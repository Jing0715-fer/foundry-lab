// 接触界面分析：两组原子选择间的重原子接触检测（对标 ChimeraX contacts / findclash）
// 判据：A 组与 B 组重原子距离 ≤ cutoff（默认 4.5 Å，ChimeraX contact 默认 6.0 / clash 0.9+0.9）
// 排除：同残基、氢/氘（重原子接触）、直接成键原子对
// 输出：残基对级聚合（最小距离 + 最近原子对 + 接触原子数），供 3D 连线与 2D 接触图谱使用
import type { StructureData } from './parser'
import { tt } from '@/i18n'
import { dataRegistry, engineRef, useMolStore, buildNamedMasks } from './store'
import { evaluateSelection } from './selection'
import { useContactStore } from './contacts-store'

export interface ContactPair {
  /** A 侧残基索引 */
  resA: number
  /** B 侧残基索引 */
  resB: number
  /** 最小重原子距离（Å） */
  minDist: number
  /** 最近原子对（A 侧 / B 侧原子索引） */
  atomA: number
  atomB: number
  /** 接触原子对计数 */
  count: number
}

export interface ContactOptions {
  cutoff?: number
}

export interface ContactResult {
  pairs: ContactPair[]
  /** A/B 侧界面残基索引（去重升序） */
  residuesA: number[]
  residuesB: number[]
  /** 参与检测的原子数 */
  atomsA: number
  atomsB: number
  ms: number
}

/** 检测两组选择间的接触（mask 为原子掩码） */
export function detectContacts(
  data: StructureData,
  aMask: Uint8Array,
  bMask: Uint8Array,
  opts: ContactOptions = {},
): ContactResult {
  const t0 = performance.now()
  const { cutoff = 4.5 } = opts
  const atoms = data.atoms
  const pos = atoms.positions
  const n = atoms.count
  const empty: ContactResult = { pairs: [], residuesA: [], residuesB: [], atomsA: 0, atomsB: 0, ms: performance.now() - t0 }

  // 直连键排除表
  const bonded = new Set<number>()
  for (let b = 0; b < data.bonds.count; b++) {
    const a1 = data.bonds.a[b], b1 = data.bonds.b[b]
    bonded.add(a1 * n + b1)
    bonded.add(b1 * n + a1)
  }

  // 重原子索引列表（排除 H/D——与跨结构版 detectContactsCross 口径一致，r63-fix-c #5：
  // 旧版单结构路径无氢过滤，氢键长距离接触（H···O ~2.8Å）大量涌入结果）
  const listA: number[] = [], listB: number[] = []
  for (let i = 0; i < n; i++) {
    const e = atoms.elements[i]
    if (e === 'H' || e === 'D') continue
    if (aMask[i]) listA.push(i)
    if (bMask[i]) listB.push(i)
  }
  if (!listA.length || !listB.length) return { ...empty, atomsA: listA.length, atomsB: listB.length }

  // 残基对聚合
  const nR = data.residues.length
  const pairMap = new Map<number, ContactPair>()
  const cut2 = cutoff * cutoff
  for (const a of listA) {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
    const cand = data.grid.queryRadius(ax, ay, az, cutoff, pos)
    const resA = data.atomResidue[a]
    for (const b of cand) {
      if (!bMask[b]) continue
      const e = atoms.elements[b]
      if (e === 'H' || e === 'D') continue // 重原子接触（对齐跨结构版）
      const resB = data.atomResidue[b]
      if (resA === resB) continue
      if (bonded.has(a * n + b)) continue
      const dx = pos[b * 3] - ax, dy = pos[b * 3 + 1] - ay, dz = pos[b * 3 + 2] - az
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > cut2) continue
      const dist = Math.sqrt(d2)
      const key = resA * nR + resB
      const existing = pairMap.get(key)
      if (existing) {
        existing.count++
        if (dist < existing.minDist) {
          existing.minDist = dist
          existing.atomA = a
          existing.atomB = b
        }
      } else {
        pairMap.set(key, { resA, resB, minDist: dist, atomA: a, atomB: b, count: 1 })
      }
    }
  }

  const pairs = [...pairMap.values()].sort((p, q) => p.minDist - q.minDist)
  const setA = new Set<number>(), setB = new Set<number>()
  for (const p of pairs) {
    setA.add(p.resA)
    setB.add(p.resB)
  }
  return {
    pairs,
    residuesA: [...setA].sort((x, y) => x - y),
    residuesB: [...setB].sort((x, y) => x - y),
    atomsA: listA.length,
    atomsB: listB.length,
    ms: performance.now() - t0,
  }
}

/** 距离 → 接触线颜色（近 = 红 #ef4444，远 = 琥珀 #f59e0b；t∈[0,1]） */
export function contactColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t))
  // 线性插值 red(239,68,68) → amber(245,158,11)
  return [
    (239 + (245 - 239) * c) / 255,
    (68 + (158 - 68) * c) / 255,
    (68 + (11 - 68) * c) / 255,
  ]
}

// ---------- 跨结构接触（复合物界面检测，对标 ChimeraX contacts 跨模型） ----------

export interface CrossContactPair {
  /** A 侧残基索引（在结构 A 的残基表内） */
  resA: number
  /** B 侧残基索引（在结构 B 的残基表内） */
  resB: number
  /** 最小重原子距离（Å） */
  minDist: number
  /** 最近原子对（各自结构内的局部原子索引） */
  atomA: number
  atomB: number
  /** 接触原子对计数 */
  count: number
}

export interface CrossContactResult {
  pairs: CrossContactPair[]
  residuesA: number[]
  residuesB: number[]
  atomsA: number
  atomsB: number
  ms: number
}

/**
 * 跨结构接触检测：结构 A 的原子选择 vs 结构 B 的原子选择。
 * 前提：两结构已在同一坐标系（superpose 变换直接写入 atoms.positions）。
 * 判据：重原子（非 H/D）间距离 ≤ cutoff；氢原子排除。
 * B 侧用其空间网格加速查询。
 */
export function detectContactsCross(
  dataA: StructureData,
  aMask: Uint8Array,
  dataB: StructureData,
  bMask: Uint8Array,
  opts: ContactOptions = {},
): CrossContactResult {
  const t0 = performance.now()
  const { cutoff = 4.5 } = opts
  const posA = dataA.atoms.positions
  const posB = dataB.atoms.positions
  const nA = dataA.atoms.count

  // 重原子索引列表（排除 H/D）
  const listA: number[] = []
  for (let i = 0; i < nA; i++) {
    if (!aMask[i]) continue
    const e = dataA.atoms.elements[i]
    if (e === 'H' || e === 'D') continue
    listA.push(i)
  }
  const nB = dataB.atoms.count
  let countB = 0
  for (let i = 0; i < nB; i++) if (bMask[i]) countB++
  if (!listA.length || !countB) {
    return { pairs: [], residuesA: [], residuesB: [], atomsA: listA.length, atomsB: countB, ms: performance.now() - t0 }
  }

  // 残基对聚合（key 用字符串避免跨结构索引碰撞）
  const pairMap = new Map<string, CrossContactPair>()
  const cut2 = cutoff * cutoff
  for (const a of listA) {
    const ax = posA[a * 3], ay = posA[a * 3 + 1], az = posA[a * 3 + 2]
    const cand = dataB.grid.queryRadius(ax, ay, az, cutoff, posB)
    const resA = dataA.atomResidue[a]
    for (const b of cand) {
      if (!bMask[b]) continue
      const e = dataB.atoms.elements[b]
      if (e === 'H' || e === 'D') continue
      const resB = dataB.atomResidue[b]
      const dx = posB[b * 3] - ax, dy = posB[b * 3 + 1] - ay, dz = posB[b * 3 + 2] - az
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > cut2) continue
      const dist = Math.sqrt(d2)
      const key = `${resA}:${resB}`
      const existing = pairMap.get(key)
      if (existing) {
        existing.count++
        if (dist < existing.minDist) {
          existing.minDist = dist
          existing.atomA = a
          existing.atomB = b
        }
      } else {
        pairMap.set(key, { resA, resB, minDist: dist, atomA: a, atomB: b, count: 1 })
      }
    }
  }

  const pairs = [...pairMap.values()].sort((p, q) => p.minDist - q.minDist)
  const setA = new Set<number>(), setB = new Set<number>()
  for (const p of pairs) {
    setA.add(p.resA)
    setB.add(p.resB)
  }
  return {
    pairs,
    residuesA: [...setA].sort((x, y) => x - y),
    residuesB: [...setB].sort((x, y) => x - y),
    atomsA: listA.length,
    atomsB: countB,
    ms: performance.now() - t0,
  }
}

// ---------- 分析运行器（面板 / 命令行共用） ----------

export interface RunContactOutcome {
  ok: boolean
  message: string
}

/** 求值两组表达式 → 检测接触 → 更新 store + 引擎连线渲染 */
export function runContactAnalysis(aExpr?: string, bExpr?: string, cutoff?: number): RunContactOutcome {
  const store = useMolStore.getState()
  const cs = useContactStore.getState()
  if (!store.activeId) return { ok: false, message: tt({ zh: '没有活动结构', en: 'No active structure' }) }
  const data = dataRegistry.get(store.activeId)
  if (!data) return { ok: false, message: tt({ zh: '结构数据不存在', en: 'Structure data missing' }) }
  const A = (aExpr ?? cs.aExpr).trim().replace(/[,，\s]+$/, '').trim()
  const B = (bExpr ?? cs.bExpr).trim().replace(/[,，\s]+$/, '').trim()
  const cut = cutoff ?? cs.cutoff
  if (!A || !B) return { ok: false, message: tt({ zh: '请提供 A/B 两组选择表达式', en: 'Provide both A/B selection expressions' }) }

  const named = buildNamedMasks(store.activeId, data)
  const ra = evaluateSelection(A, { structure: data, named })
  const rb = evaluateSelection(B, { structure: data, named })
  const errors: { a?: string; b?: string } = {}
  if (ra.error) errors.a = ra.error
  if (rb.error) errors.b = rb.error
  // 同步表达式与参数到 store（面板反映命令行调用）
  useContactStore.setState({ aExpr: A, bExpr: B, cutoff: cut, defaulted: true })
  if (ra.error || rb.error) {
    // 表达式错误不摧毁已有分析结果（agent 修正轮的失败命令不应清掉成功的 83 对接触——实测踩坑）；
    // 只记录错误供面板提示，旧结果保留到下一次成功运行或显式 clear
    useContactStore.setState({ errors })
    return { ok: false, message: tt({ zh: `表达式错误：${[errors.a, errors.b].filter(Boolean).join('；')}`, en: `Expression error: ${[errors.a, errors.b].filter(Boolean).join('; ')}` }) }
  }
  if (ra.count === 0 || rb.count === 0) {
    useContactStore.getState().setResult({ structureId: store.activeId, pairs: [], residuesA: [], residuesB: [], atomsA: ra.count, atomsB: rb.count })
    engineRef.current?.updateContacts()
    return { ok: false, message: tt({ zh: `选择为空（A: ${ra.count} 原子，B: ${rb.count} 原子）`, en: `Empty selection (A: ${ra.count} atoms, B: ${rb.count} atoms)` }) }
  }

  const result = detectContacts(data, ra.mask, rb.mask, { cutoff: cut })
  useContactStore.getState().setResult({
    structureId: store.activeId,
    pairs: result.pairs,
    residuesA: result.residuesA,
    residuesB: result.residuesB,
    atomsA: result.atomsA,
    atomsB: result.atomsB,
  })
  engineRef.current?.updateContacts()
  if (!result.pairs.length) {
    return { ok: true, message: tt({ zh: `未发现接触（A: ${ra.count} 原子 ↔ B: ${rb.count} 原子，截断 ${cut} Å，${result.ms.toFixed(0)} ms）——两组可能不相邻或距离超过截断值`, en: `No contacts found (A: ${ra.count} atoms ↔ B: ${rb.count} atoms, cutoff ${cut} Å, ${result.ms.toFixed(0)} ms) — the two groups may not be adjacent or are farther than the cutoff` }) }
  }
  const nearest = result.pairs[0]
  const fmtRes = (ri: number) => {
    const r = data.residues[ri]
    return `${r.chainId.trim() || '?'}:${r.resName}${r.resSeq}`
  }
  return {
    ok: true,
    message: tt({
      zh: `${result.pairs.length} 对残基接触（A: ${ra.count} ↔ B: ${rb.count} 原子，截断 ${cut} Å，${result.ms.toFixed(0)} ms）· 界面残基 A ${result.residuesA.length} / B ${result.residuesB.length} · 最近 ${fmtRes(nearest.resA)} ↔ ${fmtRes(nearest.resB)} ${nearest.minDist.toFixed(2)} Å`,
      en: `${result.pairs.length} residue-pair contacts (A: ${ra.count} ↔ B: ${rb.count} atoms, cutoff ${cut} Å, ${result.ms.toFixed(0)} ms) · interface residues A ${result.residuesA.length} / B ${result.residuesB.length} · nearest ${fmtRes(nearest.resA)} ↔ ${fmtRes(nearest.resB)} ${nearest.minDist.toFixed(2)} Å`,
    }),
  }
}

/** 界面残基 → 原子索引列表（供选择/高亮） */
export function interfaceAtomIndices(data: StructureData, residues: number[]): number[] {
  const out: number[] = []
  for (const ri of residues) {
    const r = data.residues[ri]
    for (let i = r.start; i < r.end; i++) out.push(i)
  }
  return out
}

// ---------- 界面埋藏面积（ΔSASA）运行器 ----------

/** 对 contacts 的 A/B 组计算 ΔSASA（三路 Shrake–Rupley）；大结构走 Web Worker */
export function runBuriedSasa(): RunContactOutcome {
  const store = useMolStore.getState()
  const cs = useContactStore.getState()
  if (!store.activeId) return { ok: false, message: tt({ zh: '没有活动结构', en: 'No active structure' }) }
  if (cs.cross) return { ok: false, message: tt({ zh: '当前为跨结构接触结果——请用 xbsa 计算跨结构界面埋藏面积（沿用 xcontacts 的 A/B 掩码）', en: 'Current result is a cross-structure contact — use xbsa to compute the cross-structure buried area (it reuses the xcontacts A/B masks)' }) }
  const data = dataRegistry.get(store.activeId)
  if (!data) return { ok: false, message: tt({ zh: '结构数据不存在', en: 'Structure data missing' }) }
  const A = cs.aExpr.trim(), B = cs.bExpr.trim()
  if (!A || !B) return { ok: false, message: tt({ zh: '请先设置 A/B 两组选择（contacts 或分析面板）', en: 'Set the A/B selections first (contacts or the analysis panel)' }) }
  const named = buildNamedMasks(store.activeId, data)
  const ra = evaluateSelection(A, { structure: data, named })
  const rb = evaluateSelection(B, { structure: data, named })
  if (ra.error || rb.error) return { ok: false, message: tt({ zh: `表达式错误：${[ra.error, rb.error].filter(Boolean).join('；')}`, en: `Expression error: ${[ra.error, rb.error].filter(Boolean).join('; ')}` }) }
  if (ra.count === 0 || rb.count === 0) return { ok: false, message: tt({ zh: `选择为空（A: ${ra.count}，B: ${rb.count}）`, en: `Empty selection (A: ${ra.count}, B: ${rb.count})` }) }
  const eng = engineRef.current
  if (!eng) return { ok: false, message: tt({ zh: '渲染引擎未就绪', en: 'Render engine not ready' }) }
  const r = eng.requestBuriedSasa(store.activeId, ra.mask, rb.mask)
  if (r.done && r.result) {
    const total = r.result.buriedA + r.result.buriedB
    return {
      ok: true,
      message: tt({
        zh: `ΔSASA 界面埋藏面积：合计 ${total.toFixed(0)} Å²（A ${r.result.buriedA.toFixed(0)} + B ${r.result.buriedB.toFixed(0)}）· 界面核心残基 A ${r.result.coreA.length} / B ${r.result.coreB.length}（ΔSASA > 1 Å²）· ${r.result.ms.toFixed(0)} ms`,
        en: `ΔSASA interface buried area: total ${total.toFixed(0)} Å² (A ${r.result.buriedA.toFixed(0)} + B ${r.result.buriedB.toFixed(0)}) · interface core residues A ${r.result.coreA.length} / B ${r.result.coreB.length} (ΔSASA > 1 Å²) · ${r.result.ms.toFixed(0)} ms`,
      }),
    }
  }
  return { ok: true, message: tt({ zh: 'ΔSASA 计算中（Web Worker）——完成后将在此输出结果', en: 'ΔSASA computing (Web Worker) — the result will be printed here when done' }) }
}

// ---------- 跨结构界面埋藏面积（ΔSASA）运行器 ----------

/**
 * 跨结构 ΔSASA：对 xcontacts 的 A/B 掩码做联合三路 SASA。
 * 前提：两结构已 superpose 到同一坐标系（掩码来自跨结构接触上下文）。
 */
export function runCrossBuriedSasa(): RunContactOutcome {
  const cs = useContactStore.getState()
  const cross = cs.cross
  if (!cross) return { ok: false, message: tt({ zh: '请先运行 xcontacts 建立跨结构接触（xbsa 沿用其 A/B 掩码与当前位姿）', en: 'Run xcontacts first to establish cross-structure contacts (xbsa reuses its A/B masks and current poses)' }) }
  const eng = engineRef.current
  if (!eng) return { ok: false, message: tt({ zh: '渲染引擎未就绪', en: 'Render engine not ready' }) }
  const r = eng.requestCrossBuriedSasa(cross.idA, cross.maskA, cross.idB, cross.maskB)
  if (r.done && r.result) {
    const total = r.result.buriedA + r.result.buriedB
    return {
      ok: true,
      message: tt({
        zh: `跨结构 ΔSASA 界面埋藏面积：合计 ${total.toFixed(0)} Å²（${cross.labelA} ${r.result.buriedA.toFixed(0)} + ${cross.labelB} ${r.result.buriedB.toFixed(0)}）· 核心残基 ${cross.labelA} ${r.result.coreA.length} / ${cross.labelB} ${r.result.coreB.length}（ΔSASA > 1 Å²）· ${r.result.ms.toFixed(0)} ms`,
        en: `Cross-structure ΔSASA buried area: total ${total.toFixed(0)} Å² (${cross.labelA} ${r.result.buriedA.toFixed(0)} + ${cross.labelB} ${r.result.buriedB.toFixed(0)}) · core residues ${cross.labelA} ${r.result.coreA.length} / ${cross.labelB} ${r.result.coreB.length} (ΔSASA > 1 Å²) · ${r.result.ms.toFixed(0)} ms`,
      }),
    }
  }
  return { ok: true, message: tt({ zh: `跨结构 ΔSASA 计算中（Web Worker，${cross.labelA} ↔ ${cross.labelB}）——完成后将在此输出结果`, en: `Cross-structure ΔSASA computing (Web Worker, ${cross.labelA} ↔ ${cross.labelB}) — the result will be printed here when done` }) }
}

// ---------- 跨结构接触运行器 ----------

/** 按 PDB 编号 / 名称前缀解析结构（支持 "1UBQ"、"1ubq"、"ubiq" 等） */
export function resolveStructure(ref: string): { id: string; data: StructureData; label: string } | null {
  const s = useMolStore.getState()
  const q = ref.trim()
  if (!q) return null
  const lower = q.toLowerCase()
  // 精确 PDB 编号匹配
  const byPdb = s.structures.find(x => x.meta.pdbId?.toLowerCase() === lower)
  if (byPdb) {
    const d = dataRegistry.get(byPdb.id)
    if (d) return { id: byPdb.id, data: d, label: byPdb.meta.pdbId! }
  }
  // 名称 / 标题前缀匹配
  const byName = s.structures.find(x => x.name.toLowerCase().startsWith(lower) || x.meta.pdbId?.toLowerCase().startsWith(lower))
  if (byName) {
    const d = dataRegistry.get(byName.id)
    if (d) return { id: byName.id, data: d, label: byName.meta.pdbId ?? byName.name }
  }
  return null
}

export interface RunCrossOutcome extends RunContactOutcome {
  /** A/B 侧结构（成功时返回，供渲染） */
  idA?: string
  idB?: string
  dataA?: StructureData
  dataB?: StructureData
  residuesA?: number[]
  residuesB?: number[]
}

/**
 * 跨结构接触：xcontacts <结构A>:<exprA> | <结构B>:<exprB> [cutoff]
 * 例：xcontacts 1UBQ:chain A | 1D3Z:chain A 5.0
 * 也可两表达式无结构前缀（默认活动结构为 A，另一结构按 B 解析）。
 */
export function runCrossContactAnalysis(specA: string, specB: string, cutoff?: number): RunCrossOutcome {
  const store = useMolStore.getState()
  const cs = useContactStore.getState()
  const cut = cutoff ?? cs.cutoff

  // 解析 "STRUCT:expr"（STRUCT 为 PDB 编号或名称前缀；可省略 → 活动结构）
  const parseSpec = (spec: string): { struct: ReturnType<typeof resolveStructure>; expr: string; error?: string } => {
    const s = spec.trim()
    const m = s.match(/^(.+?):(.+)$/)
    if (m && !s.includes('|')) {
      const st = resolveStructure(m[1])
      if (st) return { struct: st, expr: m[2].trim() }
      // 无匹配结构 → 可能是 "resi 1:10" 之类，整串当表达式
      return { struct: null, expr: s }
    }
    return { struct: null, expr: s }
  }

  const pa = parseSpec(specA)
  const pb = parseSpec(specB)
  const structA = pa.struct ?? (store.activeId ? (() => { const d = dataRegistry.get(store.activeId); return d ? { id: store.activeId, data: d, label: store.structures.find(x => x.id === store.activeId)?.meta.pdbId ?? tt({ zh: '活动结构', en: 'active structure' }) } : null })() : null)
  const structB = pb.struct ?? (store.activeId ? (() => { const d = dataRegistry.get(store.activeId); return d ? { id: store.activeId, data: d, label: store.structures.find(x => x.id === store.activeId)?.meta.pdbId ?? tt({ zh: '活动结构', en: 'active structure' }) } : null })() : null)

  if (!structA || !structB) return { ok: false, message: tt({ zh: '结构未找到（用 PDB 编号或名称前缀指定，如 1UBQ:chain A）', en: 'Structure not found (specify with a PDB ID or name prefix, e.g. 1UBQ:chain A)' }) }
  if (structA.id === structB.id) return { ok: false, message: tt({ zh: '跨结构检测需要两个不同结构（同结构请用 contacts）', en: 'Cross-structure detection needs two different structures (use contacts within one structure)' }) }
  if (!pa.expr || !pb.expr) return { ok: false, message: tt({ zh: '请提供 A/B 两侧选择表达式', en: 'Provide selection expressions for both A and B sides' }) }

  const namedA = buildNamedMasks(structA.id, structA.data)
  const namedB = buildNamedMasks(structB.id, structB.data)
  const ra = evaluateSelection(pa.expr, { structure: structA.data, named: namedA })
  const rb = evaluateSelection(pb.expr, { structure: structB.data, named: namedB })
  if (ra.error || rb.error) return { ok: false, message: tt({ zh: `表达式错误：${[ra.error, rb.error].filter(Boolean).join('；')}`, en: `Expression error: ${[ra.error, rb.error].filter(Boolean).join('; ')}` }) }
  if (ra.count === 0 || rb.count === 0) return { ok: false, message: tt({ zh: `选择为空（${structA.label}: ${ra.count}，${structB.label}: ${rb.count}）`, en: `Empty selection (${structA.label}: ${ra.count}, ${structB.label}: ${rb.count})` }) }

  const result = detectContactsCross(structA.data, ra.mask, structB.data, rb.mask, { cutoff: cut })

  // 存入 contact store（跨结构模式：两套局部索引）
  useContactStore.getState().setCrossResult(
    {
      idA: structA.id,
      idB: structB.id,
      labelA: structA.label,
      labelB: structB.label,
      exprA: pa.expr,
      exprB: pb.expr,
      cutoff: cut,
      maskA: ra.mask,
      maskB: rb.mask,
    },
    result.pairs,
    result.residuesA,
    result.residuesB,
    result.atomsA,
    result.atomsB,
  )
  engineRef.current?.updateContacts()

  if (!result.pairs.length) {
    return {
      ok: true,
      message: tt({ zh: `未发现跨结构接触（${structA.label} ↔ ${structB.label}，截断 ${cut} Å，${result.ms.toFixed(0)} ms）——建议先 superpose 将两结构对齐到同一坐标系`, en: `No cross-structure contacts found (${structA.label} ↔ ${structB.label}, cutoff ${cut} Å, ${result.ms.toFixed(0)} ms) — consider superposing the two structures into the same coordinate frame first` }),
    }
  }
  const nearest = result.pairs[0]
  const fmtRes = (d: StructureData, ri: number) => {
    const r = d.residues[ri]
    return `${r.chainId.trim() || '?'}:${r.resName}${r.resSeq}`
  }
  return {
    ok: true,
    idA: structA.id,
    idB: structB.id,
    dataA: structA.data,
    dataB: structB.data,
    residuesA: result.residuesA,
    residuesB: result.residuesB,
    message: tt({
      zh: `${result.pairs.length} 对跨结构残基接触（${structA.label}: ${ra.count} ↔ ${structB.label}: ${rb.count} 原子，截断 ${cut} Å，${result.ms.toFixed(0)} ms）· 界面残基 ${structA.label} ${result.residuesA.length} / ${structB.label} ${result.residuesB.length} · 最近 ${fmtRes(structA.data, nearest.resA)} ↔ ${fmtRes(structB.data, nearest.resB)} ${nearest.minDist.toFixed(2)} Å`,
      en: `${result.pairs.length} cross-structure residue-pair contacts (${structA.label}: ${ra.count} ↔ ${structB.label}: ${rb.count} atoms, cutoff ${cut} Å, ${result.ms.toFixed(0)} ms) · interface residues ${structA.label} ${result.residuesA.length} / ${structB.label} ${result.residuesB.length} · nearest ${fmtRes(structA.data, nearest.resA)} ↔ ${fmtRes(structB.data, nearest.resB)} ${nearest.minDist.toFixed(2)} Å`,
    }),
  }
}
