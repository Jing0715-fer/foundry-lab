// 构象插值 morph（对标 PyMOL morph）：结构间生成插值轨迹对象
// 双构象：链对贪心配对（NW 得分）→ 残基对内原子名精确匹配 → B 内存叠合到 A → smoothstep 线性插值
// 多构象（morph multi）：参考构象 A 与每个构象分别匹配 → 取全部匹配的原子交集 →
//   逐个叠合到 A → Catmull-Rom 样条穿过全部构象态生成帧（平滑多态过渡）
import type { StructureData } from './parser'
import { subsetStructure } from './parser'
import { extractAllSequences, alignSequences, superposeStructures, quatToMatrix } from './superpose'
import { refineMorphFrames, type RefineStats } from './morph-refine'
import { tt } from '@/i18n'

export interface MorphResult {
  ok: boolean
  error?: string
  /** 新建结构（含 ensemble 帧） */
  data?: StructureData
  /** 匹配原子数 / 残基对数 */
  matchedAtoms: number
  matchedResidues: number
  /** 配对的链（A 链 ID → B 链 ID） */
  matchedChains: [string, string][]
  /** 插值帧数 */
  frames: number
  /** 自动叠合的 CA RMSD（Å）；null = 未做叠合（同源位姿直通或恒等匹配） */
  alignRmsd: number | null
  /** 使用的匹配策略 */
  strategy: 'sequence' | 'identity'
  /** 帧精修统计（键长约束 + 去碰撞）；null = 未启用或无键数据 */
  refine?: RefineStats | null
}

/** 多态 morph 结果（morph multi） */
export interface MultiMorphResult {
  ok: boolean
  error?: string
  data?: StructureData
  matchedAtoms: number
  matchedResidues: number
  matchedChains: [string, string][]
  /** 插值帧数 */
  frames: number
  /** 构象态（结点）数 = 输入结构数 */
  knots: number
  /** 每个后续构象叠合到参考的 CA RMSD（Å）；恒等策略为 null */
  rmsds: (number | null)[]
  strategy: 'sequence' | 'identity'
  /** 帧精修统计（键长约束 + 去碰撞）；null = 未启用或无键数据 */
  refine?: RefineStats | null
}

/** 原子名精确匹配残基对内的原子（双方都有同名原子才配对） */
function matchResidueAtoms(A: StructureData, B: StructureData, riA: number, riB: number, out: [number, number][]) {
  const rA = A.residues[riA]
  const rB = B.residues[riB]
  if (!rA || !rB) return
  const bByName = new Map<string, number>()
  for (let j = rB.start; j < rB.end; j++) {
    const nm = B.atoms.names[j]
    if (!bByName.has(nm)) bByName.set(nm, j)
  }
  for (let i = rA.start; i < rA.end; i++) {
    const j = bByName.get(A.atoms.names[i])
    if (j !== undefined) out.push([i, j])
  }
}

/** 链对贪心配对：按 NW 比对得分降序取对（每链只用一次，长度差 > 60% 跳过） */
function pairProteinChains(A: StructureData, B: StructureData) {
  const seqsA = extractAllSequences(A)
  const seqsB = extractAllSequences(B)
  type Scored = { sa: (typeof seqsA)[number]; sb: (typeof seqsB)[number]; pairs: [number, number][]; score: number }
  const scored: Scored[] = []
  for (const sa of seqsA) {
    for (const sb of seqsB) {
      if (Math.min(sa.sequence.length, sb.sequence.length) < 0.4 * Math.max(sa.sequence.length, sb.sequence.length)) continue
      const { pairs, score } = alignSequences(sa.sequence, sb.sequence)
      // 只保留全同残基对（morph 插值要求化学等价）
      let identical = 0
      for (const [i, j] of pairs) if (sa.sequence[i] === sb.sequence[j]) identical++
      scored.push({ sa, sb, pairs, score: score + identical })
    }
  }
  scored.sort((x, y) => y.score - x.score)
  const usedA = new Set<string>()
  const usedB = new Set<string>()
  const out: Omit<Scored, 'score'>[] = []
  for (const c of scored) {
    const ka = c.sa.chainId
    const kb = c.sb.chainId
    if (usedA.has(ka) || usedB.has(kb)) continue
    usedA.add(ka)
    usedB.add(kb)
    out.push(c)
  }
  return { pairs: out }
}

/** 单对结构匹配结果（A ↔ X） */
interface PairMatch {
  /** A 原子索引 → X 原子索引（pairs 为空 = 匹配失败） */
  pairs: [number, number][]
  matchedResidues: number
  matchedChains: [string, string][]
  strategy: 'sequence' | 'identity'
}

/**
 * 结构对原子匹配（双策略）：① 蛋白链序列比对 + 残基内原子名精确配对；
 * ② 兜底恒等——原子数相等且逐位元数据全同（同 PDB 不同构象 / 核酸同源等）。
 * pairs 为空表示两种策略都失败。
 */
function matchStructureAtoms(A: StructureData, X: StructureData): PairMatch {
  // ---------- 策略 1：蛋白链序列比对配对 ----------
  const atomPairs: [number, number][] = []
  const matchedChains: [string, string][] = []
  let matchedResidues = 0
  const chainPairs = pairProteinChains(A, X)
  for (const cp of chainPairs.pairs) {
    let chainRes = 0
    for (const [ai, xi] of cp.pairs) {
      if (cp.sa.sequence[ai] !== cp.sb.sequence[xi]) continue // 化学等价才插值
      const riA = cp.sa.residueIdx[ai]
      const riX = cp.sb.residueIdx[xi]
      const before = atomPairs.length
      matchResidueAtoms(A, X, riA, riX, atomPairs)
      if (atomPairs.length > before) chainRes++
    }
    if (chainRes > 0) {
      matchedResidues += chainRes
      matchedChains.push([cp.sa.chainId.trim() || '?', cp.sb.chainId.trim() || '?'])
    }
  }
  if (matchedResidues >= 3) return { pairs: atomPairs, matchedResidues, matchedChains, strategy: 'sequence' }

  // ---------- 策略 2（兜底）：同源结构按索引恒等匹配 ----------
  if (A.atoms.count === X.atoms.count && A.atoms.count > 0) {
    let same = true
    for (let i = 0; i < A.atoms.count; i++) {
      if (
        A.atoms.names[i] !== X.atoms.names[i] ||
        A.atoms.chainIds[i] !== X.atoms.chainIds[i] ||
        A.atoms.resSeqs[i] !== X.atoms.resSeqs[i] ||
        A.atoms.resNames[i].toUpperCase() !== X.atoms.resNames[i].toUpperCase()
      ) { same = false; break }
    }
    if (same) {
      const pairs: [number, number][] = []
      for (let i = 0; i < A.atoms.count; i++) pairs.push([i, i])
      return { pairs, matchedResidues: A.residues.length, matchedChains: [], strategy: 'identity' }
    }
  }
  return { pairs: [], matchedResidues: 0, matchedChains: [], strategy: 'sequence' }
}

/** 把构象 X 的坐标叠合到 A（内存副本，不改动 X 本身）；返回子结构索引序的坐标数组 */
function superposeOnto(A: StructureData, X: StructureData): { pos: Float32Array; rmsd: number | null } {
  const res = superposeStructures(X, A)
  if (!res.ok) {
    // 无法叠合（如非蛋白）——按当前位姿直接使用（用户可能已手动 superpose）
    return { pos: X.atoms.positions.slice(), rmsd: null }
  }
  const m = quatToMatrix(res.quat)
  const [tx, ty, tz] = res.translation
  const n = X.atoms.count
  const pos = new Float32Array(n * 3)
  const src = X.atoms.positions
  for (let i = 0; i < n; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2]
    pos[i * 3] = m[0][0] * x + m[0][1] * y + m[0][2] * z + tx
    pos[i * 3 + 1] = m[1][0] * x + m[1][1] * y + m[1][2] * z + ty
    pos[i * 3 + 2] = m[2][0] * x + m[2][1] * y + m[2][2] * z + tz
  }
  return { pos, rmsd: res.rmsd }
}

/**
 * 构建双构象 morph 轨迹结构。
 * @param A 参考构象（轨迹起点，输出坐标系 = A 的当前世界位姿）
 * @param B 目标构象（会先在内存中自动叠合到 A，不改动 B 本身）
 * @param steps 插值帧数（10–120，含首尾）
 * @param refine 帧后处理精修（默认开启：键长约束 + 去碰撞，rigimol 风格）
 */
export function buildMorph(A: StructureData, B: StructureData, name: string, steps = 30, refine = true): MorphResult {
  const fail = (msg: string): MorphResult => ({
    ok: false, error: msg, matchedAtoms: 0, matchedResidues: 0, matchedChains: [], frames: 0, alignRmsd: null, strategy: 'sequence',
  })

  const match = matchStructureAtoms(A, B)
  if (!match.pairs.length) {
    return fail(tt({ zh: '两结构没有可匹配的原子：请确认是同源蛋白（序列相似），或完全相同的结构（同 PDB 不同构象）', en: 'The two structures have no matchable atoms: make sure they are homologous proteins (similar sequences) or the exact same structure (same PDB, different conformations)' }))
  }
  const atomPairs = match.pairs
  const strategy = match.strategy

  // ---------- B 在内存中叠合到 A（蛋白场景；恒等匹配则跳过） ----------
  const aligned = strategy === 'sequence' ? superposeOnto(A, B) : { pos: B.atoms.positions.slice(), rmsd: null }
  const posB = aligned.pos
  const alignRmsd = aligned.rmsd

  // ---------- 生成插值帧 ----------
  const frames = Math.max(10, Math.min(120, Math.round(steps)))
  const n = atomPairs.length
  // 抽取 A 匹配原子子集（轨迹起点 = A 当前坐标）
  const idxA: number[] = new Array(n)
  for (let k = 0; k < n; k++) idxA[k] = atomPairs[k][0]
  let sub: StructureData
  try {
    sub = subsetStructure(A, idxA, name)
  } catch (e) {
    return fail(tt({ zh: `子结构构建失败：${e instanceof Error ? e.message : String(e)}`, en: `Sub-structure construction failed: ${e instanceof Error ? e.message : String(e)}` }))
  }
  // subset 的原子序 = idxA 升序；重建 atomPairs → 子结构索引映射
  const sorted = [...idxA].sort((a, b) => a - b)
  const mapAtoSub = new Map<number, number>()
  sorted.forEach((ai, si) => mapAtoSub.set(ai, si))
  // 目标坐标（子结构索引序）
  const target = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    const [ai, bi] = atomPairs[k]
    const si = mapAtoSub.get(ai)!
    target[si * 3] = posB[bi * 3]
    target[si * 3 + 1] = posB[bi * 3 + 1]
    target[si * 3 + 2] = posB[bi * 3 + 2]
  }
  const start = sub.atoms.positions
  const frameList: Float32Array[] = [start.slice()]
  const us: number[] = [0]
  for (let f = 1; f < frames; f++) {
    const t = f / (frames - 1)
    // smoothstep 缓动：首尾速度为零，播放观感更接近 PyMOL morph 的 spline 感
    const e = t * t * (3 - 2 * t)
    const buf = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) buf[i] = start[i] + (target[i] - start[i]) * e
    frameList.push(buf)
    us.push(e)
  }
  // 帧后处理精修：键长约束（SHAKE）+ 去碰撞；首尾真实构象不动
  const refineStats = refine ? refineMorphFrames(sub, frameList, [start, target], us) : null
  sub.ensemble = { frames: frameList }
  sub.ensembleKind = 'morph'

  return {
    ok: true,
    data: sub,
    matchedAtoms: n,
    matchedResidues: match.matchedResidues,
    matchedChains: match.matchedChains,
    frames,
    alignRmsd,
    strategy,
    refine: refineStats,
  }
}

/**
 * 构建多态 morph 轨迹（morph multi）：Catmull-Rom 样条平滑穿过 3+ 个构象态。
 * 参考构象 = 第 1 个结构；每个后续构象独立匹配（取全部匹配原子的交集）并叠合到参考位姿。
 * @param sources 构象序列（≥2 个；输出坐标系 = 第 1 个的当前世界位姿）
 * @param steps 插值帧数（10–200，含首尾，均匀分布于整条样条）
 * @param refine 帧后处理精修（默认开启：键长约束 + 去碰撞）
 */
export function buildMultiMorph(sources: StructureData[], name: string, steps = 48, refine = true): MultiMorphResult {
  const fail = (msg: string): MultiMorphResult => ({
    ok: false, error: msg, matchedAtoms: 0, matchedResidues: 0, matchedChains: [], frames: 0, knots: 0, rmsds: [], strategy: 'sequence',
  })
  if (sources.length < 2) return fail(tt({ zh: '至少需要 2 个构象（多态 morph 建议 3+ 个）', en: 'At least 2 conformations are required (3+ recommended for multi-state morph)' }))
  if (sources.length > 8) return fail(tt({ zh: '构象态过多（上限 8 个）——请减少输入结构', en: 'Too many conformer states (limit is 8) — reduce the input structures' }))

  const A = sources[0]
  const rest = sources.slice(1)

  // ---------- 逐对匹配 A ↔ Xi ----------
  const matches = rest.map(X => matchStructureAtoms(A, X))
  for (let i = 0; i < matches.length; i++) {
    if (!matches[i].pairs.length) {
      return fail(tt({ zh: `第 ${i + 2} 个构象（${rest[i].name || '未命名'}）无法与第 1 个构象匹配：不是同源蛋白，也非完全相同的结构`, en: `Conformation ${i + 2} (${rest[i].name || 'unnamed'}) cannot be matched with the first one: not homologous proteins and not the exact same structure` }))
    }
  }

  // ---------- 全部配对的原子交集（以 A 的原子索引为准） ----------
  const perX = matches.map(m => new Map<number, number>(m.pairs.map(([a, x]) => [a, x] as const)))
  const kept = [...perX[0].keys()].filter(a => perX.every(mp => mp.has(a)))
  if (kept.length < 3) {
    return fail(tt({ zh: `各构象间共同匹配的原子太少（${kept.length} 个）——构象序列差异过大或序列覆盖不足`, en: `Too few atoms shared across all conformers (${kept.length}) — the conformer series is too divergent or sequence coverage is insufficient` }))
  }
  const sortedKept = [...kept].sort((a, b) => a - b)
  const n = sortedKept.length

  // 匹配残基数（A 侧去重）与链对（去重合并展示）
  const resSet = new Set<number>()
  for (const a of sortedKept) resSet.add(A.atomResidue[a])
  const chainKeys = new Set<string>()
  const matchedChains: [string, string][] = []
  for (const m of matches) {
    for (const [ca, cx] of m.matchedChains) {
      const k = `${ca}↔${cx}`
      if (!chainKeys.has(k)) { chainKeys.add(k); matchedChains.push([ca, cx]) }
    }
  }
  const strategy: 'sequence' | 'identity' = matches.every(m => m.strategy === 'identity') ? 'identity' : 'sequence'

  // ---------- 抽参考构象子集（轨迹起点） ----------
  let sub: StructureData
  try {
    sub = subsetStructure(A, sortedKept, name)
  } catch (e) {
    return fail(tt({ zh: `子结构构建失败：${e instanceof Error ? e.message : String(e)}`, en: `Sub-structure construction failed: ${e instanceof Error ? e.message : String(e)}` }))
  }
  const mapAtoSub = new Map<number, number>()
  sortedKept.forEach((ai, si) => mapAtoSub.set(ai, si))

  // ---------- 构象态结点：[A, 叠合后的 X1, X2, …]（子结构索引序） ----------
  const knots: Float32Array[] = [sub.atoms.positions.slice()]
  const rmsds: (number | null)[] = []
  for (let xi = 0; xi < rest.length; xi++) {
    const X = rest[xi]
    const seq = matches[xi].strategy === 'sequence'
    const { pos, rmsd } = seq ? superposeOnto(A, X) : { pos: X.atoms.positions.slice(), rmsd: null }
    rmsds.push(rmsd)
    const k = new Float32Array(n * 3)
    for (let si = 0; si < n; si++) {
      const aIdx = sortedKept[si]
      const xIdx = perX[xi].get(aIdx)!
      k[si * 3] = pos[xIdx * 3]
      k[si * 3 + 1] = pos[xIdx * 3 + 1]
      k[si * 3 + 2] = pos[xIdx * 3 + 2]
    }
    knots.push(k)
  }

  // ---------- Catmull-Rom 样条采样生成帧（端点复制，均匀参数） ----------
  const m = knots.length
  const frames = Math.max(10, Math.min(200, Math.round(steps)))
  const frameList: Float32Array[] = [knots[0].slice()]
  const us: number[] = [0]
  for (let f = 1; f < frames; f++) {
    const u = (f / (frames - 1)) * (m - 1)
    us.push(u)
    let i = Math.floor(u)
    if (i > m - 2) i = m - 2
    const t = u - i
    const t2 = t * t
    const t3 = t2 * t
    const K0 = knots[Math.max(i - 1, 0)]
    const K1 = knots[i]
    const K2 = knots[i + 1]
    const K3 = knots[Math.min(i + 2, m - 1)]
    const buf = new Float32Array(n * 3)
    // Catmull-Rom 基函数（uniform）：P(t) = ½(2P₁ + (−P₀+P₂)t + (2P₀−5P₁+4P₂−P₃)t² + (−P₀+3P₁−3P₂+P₃)t³)
    for (let j = 0; j < n * 3; j++) {
      const p0 = K0[j], p1 = K1[j], p2 = K2[j], p3 = K3[j]
      buf[j] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }
    frameList.push(buf)
  }
  // 帧后处理精修：键长约束（SHAKE）+ 去碰撞；首尾真实构象不动
  const refineStats = refine ? refineMorphFrames(sub, frameList, knots, us) : null
  sub.ensemble = { frames: frameList }
  sub.ensembleKind = 'multimorph'
  sub.ensembleKnots = m

  return {
    ok: true,
    data: sub,
    matchedAtoms: n,
    matchedResidues: resSet.size,
    matchedChains,
    frames,
    knots: m,
    rmsds,
    strategy,
    refine: refineStats,
  }
}
