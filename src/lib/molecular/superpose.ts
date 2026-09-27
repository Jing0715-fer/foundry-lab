// 结构叠合（superposition）：序列比对 + 刚体拟合，对标 ChimeraX matchmaker
// 流程：提取两结构最长蛋白链序列 → Needleman-Wunsch 全局比对 → 匹配残基的 CA 原子对
//      → Horn 四元数法（Kabsch 等价）求最优旋转平移 → 变换应用与 RMSD 报告
import type { StructureData } from './parser'
import { SpatialGrid } from './parser'
import { residueOneLetter, residueClass } from './chemistry'
import { tt } from '@/i18n'

export interface ChainSequence {
  chainId: string
  /** 残基索引数组（每个元素对应 sequence 中一个字符） */
  residueIdx: number[]
  /** 每残基 CA 原子索引（无 CA 为 -1） */
  caAtoms: Int32Array
  sequence: string
}

export interface SuperposeResult {
  ok: boolean
  error?: string
  /** 匹配的链对 */
  mobileChain: string
  refChain: string
  /** 比对到的残基对数 */
  matched: number
  /** 对齐后 CA RMSD (Å) */
  rmsd: number
  /** 旋转四元数 (w, x, y, z) */
  quat: [number, number, number, number]
  /** 平移向量 */
  translation: [number, number, number]
  /** 匹配残基对（双方残基索引，用于 UI 高亮） */
  pairs: [number, number][]
}

/** 提取一条链的蛋白序列（含 CA 索引） */
export function extractChainSequence(data: StructureData, chainIdx: number): ChainSequence | null {
  const chain = data.chains[chainIdx]
  if (!chain || chain.type !== 'protein') return null
  const residueIdx: number[] = []
  const caAtoms: number[] = []
  let sequence = ''
  for (const ri of chain.residueIdx) {
    const r = data.residues[ri]
    if (!r || !r.polymer) continue
    const one = residueOneLetter(r.resName)
    if (one === '·') continue // 非标准残基
    // 找 CA
    let ca = -1
    for (let i = r.start; i < r.end; i++) {
      if (data.atoms.names[i] === 'CA') { ca = i; break }
    }
    residueIdx.push(ri)
    caAtoms.push(ca)
    sequence += one
  }
  if (sequence.length < 4) return null
  return { chainId: chain.id, residueIdx, caAtoms: new Int32Array(caAtoms), sequence }
}

/** 所有蛋白链序列（按长度降序） */
export function extractAllSequences(data: StructureData): ChainSequence[] {
  const out: ChainSequence[] = []
  data.chains.forEach((_, i) => {
    const s = extractChainSequence(data, i)
    if (s) out.push(s)
  })
  return out.sort((a, b) => b.sequence.length - a.sequence.length)
}

// ---------- Needleman-Wunsch 全局比对 ----------

const MATCH = 3
const SIMILAR = 1
const MISMATCH = -2
const GAP = -2

/** 相似残基判断（同生化类别，如 I/L/V）；unknown/ligand/water 无生化类别语义，不算相似 */
function isSimilar(a: string, b: string): boolean {
  const cls = residueClass(a)
  return a !== b && cls === residueClass(b) && cls !== 'unknown' && cls !== 'ligand' && cls !== 'water'
}

/** NW 全局比对；返回匹配位置对 [seqA 索引, seqB 索引]（不含 gap） */
export function alignSequences(a: string, b: string): { pairs: [number, number][]; score: number } {
  const n = a.length, m = b.length
  // 空/过短保护
  if (n === 0 || m === 0) return { pairs: [], score: 0 }
  // 线性空间 F 矩阵（(n+1)×(m+1)）
  const W = m + 1
  const F = new Int32Array((n + 1) * W)
  for (let j = 1; j <= m; j++) F[j] = j * GAP
  for (let i = 1; i <= n; i++) F[i * W] = i * GAP
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      const bj = b[j - 1]
      const diag = F[(i - 1) * W + (j - 1)] + (ai === bj ? MATCH : isSimilar(ai, bj) ? SIMILAR : MISMATCH)
      const up = F[(i - 1) * W + j] + GAP
      const left = F[i * W + (j - 1)] + GAP
      F[i * W + j] = Math.max(diag, up, left)
    }
  }
  // 回溯
  const pairs: [number, number][] = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const ai = a[i - 1], bj = b[j - 1]
      const s = ai === bj ? MATCH : isSimilar(ai, bj) ? SIMILAR : MISMATCH
      if (F[i * W + j] === F[(i - 1) * W + (j - 1)] + s) {
        pairs.push([i - 1, j - 1])
        i--; j--
        continue
      }
    }
    if (i > 0 && F[i * W + j] === F[(i - 1) * W + j] + GAP) { i-- }
    else if (j > 0) { j-- }
    else break
  }
  pairs.reverse()
  return { pairs, score: F[n * W + m] }
}

// ---------- Horn 四元数法（最优刚体变换） ----------

/** 4×4 对称矩阵 Jacobi 特征分解；返回 { eigenvalues, eigenvectors（列向量） } 降序 */
function jacobiEigen4(K: number[][]): { values: number[]; vectors: number[][] } {
  const a = K.map(r => [...r])
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]
  const MAX_ITER = 64
  for (let iter = 0; iter < MAX_ITER; iter++) {
    // 非对角最大元素
    let off = 0
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q]
    if (off < 1e-14) break
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // 旋转 A 和 V 的 (p,q) 平面
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2], a[3][3]]
  // 按特征值降序排序（返回列向量）
  const order = values.map((val, idx) => [val, idx] as [number, number]).sort((x, y) => y[0] - x[0])
  const vectors = order.map(([, idx]) => [v[0][idx], v[1][idx], v[2][idx], v[3][idx]])
  return { values: order.map(([val]) => val), vectors }
}

export interface RigidTransform {
  quat: [number, number, number, number] // (w, x, y, z)
  translation: [number, number, number]
  rmsd: number
  count: number
}

/**
 * Horn 四元数法最优刚体拟合：求 R,t 使 Σ|R·p+t−q|² 最小
 * P/Q 为 [x,y,z][]（去质心在内部完成）
 */
export function rigidFit(P: number[][], Q: number[][]): RigidTransform | null {
  const n = P.length
  if (n < 3 || n !== Q.length) return null
  // 质心
  const pc = [0, 0, 0], qc = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 3; d++) { pc[d] += P[i][d] / n; qc[d] += Q[i][d] / n }
  }
  // 去质心并构造 S 矩阵
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const p0: number[][] = [], q0: number[][] = []
  for (let i = 0; i < n; i++) {
    const pi = [P[i][0] - pc[0], P[i][1] - pc[1], P[i][2] - pc[2]]
    const qi = [Q[i][0] - qc[0], Q[i][1] - qc[1], Q[i][2] - qc[2]]
    p0.push(pi); q0.push(qi)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += pi[r] * qi[c]
  }
  // Horn 4×4 对称矩阵
  const [Sxx, Sxy, Sxz] = [S[0][0], S[0][1], S[0][2]]
  const [Syx, Syy, Syz] = [S[1][0], S[1][1], S[1][2]]
  const [Szx, Szy, Szz] = [S[2][0], S[2][1], S[2][2]]
  const K = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]
  const { values, vectors } = jacobiEigen4(K)
  // 最大特征值对应的特征向量 = 最优旋转四元数 (w, x, y, z)
  const q = vectors[0]
  let [qw, qx, qy, qz] = q
  const norm = Math.hypot(qw, qx, qy, qz) || 1
  qw /= norm; qx /= norm; qy /= norm; qz /= norm
  // 四元数 → 旋转矩阵，t = qc − R·pc
  const R = quatToMatrix([qw, qx, qy, qz])
  const translation: [number, number, number] = [
    qc[0] - (R[0][0] * pc[0] + R[0][1] * pc[1] + R[0][2] * pc[2]),
    qc[1] - (R[1][0] * pc[0] + R[1][1] * pc[1] + R[1][2] * pc[2]),
    qc[2] - (R[2][0] * pc[0] + R[2][1] * pc[1] + R[2][2] * pc[2]),
  ]
  // RMSD
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const px = R[0][0] * P[i][0] + R[0][1] * P[i][1] + R[0][2] * P[i][2] + translation[0]
    const py = R[1][0] * P[i][0] + R[1][1] * P[i][1] + R[1][2] * P[i][2] + translation[1]
    const pz = R[2][0] * P[i][0] + R[2][1] * P[i][1] + R[2][2] * P[i][2] + translation[2]
    sumSq += (px - Q[i][0]) ** 2 + (py - Q[i][1]) ** 2 + (pz - Q[i][2]) ** 2
  }
  const quat: [number, number, number, number] = [qw, qx, qy, qz]
  return { quat, translation, rmsd: Math.sqrt(sumSq / n), count: n }
}

/** 四元数 (w,x,y,z) → 3×3 旋转矩阵 */
export function quatToMatrix(q: [number, number, number, number]): number[][] {
  const [w, x, y, z] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

/**
 * 主入口：移动结构 → 参考结构叠合
 * 链对策略：移动结构按最长蛋白链，参考结构遍历所有蛋白链取比对得分最高者
 * 可选 chain 参数：显式指定移动/参考链（matchmaker 风格链对选择）
 */
export function superposeStructures(mobile: StructureData, ref: StructureData, mobileChain?: string, refChain?: string): SuperposeResult {
  const mobileSeqs = extractAllSequences(mobile)
  const refSeqs = extractAllSequences(ref)
  if (!mobileSeqs.length) return fail(tt({ zh: '移动结构没有可识别的蛋白链', en: 'The mobile structure has no recognizable protein chain' }))
  if (!refSeqs.length) return fail(tt({ zh: '参考结构没有可识别的蛋白链', en: 'The reference structure has no recognizable protein chain' }))
  // 移动链：显式指定 or 最长
  let mob = mobileSeqs[0]
  if (mobileChain) {
    const found = mobileSeqs.find(s => s.chainId.trim().toUpperCase() === mobileChain.trim().toUpperCase())
    if (!found) return fail(tt({ zh: `移动结构没有蛋白链 "${mobileChain}"（可用：${mobileSeqs.map(s => s.chainId.trim()).join(', ')}）`, en: `Mobile structure has no protein chain "${mobileChain}" (available: ${mobileSeqs.map(s => s.chainId.trim()).join(', ')})` }))
    mob = found
  }
  let best: { seq: ChainSequence; score: number; pairs: [number, number][] } | null = null
  if (refChain) {
    // 显式参考链
    const rs = refSeqs.find(s => s.chainId.trim().toUpperCase() === refChain.trim().toUpperCase())
    if (!rs) return fail(tt({ zh: `参考结构没有蛋白链 "${refChain}"（可用：${refSeqs.map(s => s.chainId.trim()).join(', ')}）`, en: `Reference structure has no protein chain "${refChain}" (available: ${refSeqs.map(s => s.chainId.trim()).join(', ')})` }))
    const { pairs, score } = alignSequences(mob.sequence, rs.sequence)
    best = { seq: rs, score, pairs }
  } else {
    for (const rs of refSeqs) {
      // 只与长度相当的链比对（性能保护：序列长度差 > 60% 跳过）
      if (Math.min(mob.sequence.length, rs.sequence.length) < 0.4 * Math.max(mob.sequence.length, rs.sequence.length)) continue
      const { pairs, score } = alignSequences(mob.sequence, rs.sequence)
      if (!best || score > best.score) best = { seq: rs, score, pairs }
    }
    if (!best) {
      // 兜底：直接比对最长的参考链（即使长度悬殊）
      const rs = refSeqs[0]
      const { pairs, score } = alignSequences(mob.sequence, rs.sequence)
      best = { seq: rs, score, pairs }
    }
  }
  // 收集 CA 坐标对（双方都有 CA 且序列一致的比对位）
  const P: number[][] = []
  const Q: number[][] = []
  const residuePairs: [number, number][] = []
  const mp = mobile.atoms.positions
  const rp = ref.atoms.positions
  for (const [ai, bi] of best.pairs) {
    const mobCA = mob.caAtoms[ai]
    const refCA = best.seq.caAtoms[bi]
    if (mobCA < 0 || refCA < 0) continue
    P.push([mp[mobCA * 3], mp[mobCA * 3 + 1], mp[mobCA * 3 + 2]])
    Q.push([rp[refCA * 3], rp[refCA * 3 + 1], rp[refCA * 3 + 2]])
    residuePairs.push([mob.residueIdx[ai], best.seq.residueIdx[bi]])
  }
  if (P.length < 3) return fail(tt({ zh: `比对匹配的 CA 原子不足（${P.length} < 3），序列相似度过低`, en: `Too few matched CA atoms (${P.length} < 3); sequence similarity too low` }))
  const fit = rigidFit(P, Q)
  if (!fit) return fail(tt({ zh: '刚体拟合失败', en: 'Rigid-body fitting failed' }))
  return {
    ok: true,
    mobileChain: mob.chainId.trim() || '?',
    refChain: best.seq.chainId.trim() || '?',
    matched: P.length,
    rmsd: fit.rmsd,
    quat: fit.quat,
    translation: fit.translation,
    pairs: residuePairs,
  }
  function fail(msg: string): SuperposeResult {
    return {
      ok: false, error: msg, mobileChain: '?', refChain: '?', matched: 0,
      rmsd: NaN, quat: [1, 0, 0, 0], translation: [0, 0, 0], pairs: [],
    }
  }
}

/** 将刚体变换应用到结构坐标（positions + ensemble 帧）并重建网格/包围盒 */
export function applyRigidTransform(data: StructureData, quat: [number, number, number, number], translation: [number, number, number]) {
  const R = quatToMatrix(quat)
  const t = translation
  const apply = (pos: Float32Array) => {
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      pos[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
      pos[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
      pos[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
    }
  }
  apply(data.atoms.positions)
  if (data.ensemble) for (const frame of data.ensemble.frames) apply(frame)
  // 重建空间网格与包围盒
  data.grid = new SpatialGrid(data.atoms.positions, data.atoms.count, 6)
  recomputeBbox(data)
}

/** 坐标突变后重算包围盒（applyRigidTransform / ensemble 帧落定共用） */
export function recomputeBbox(data: StructureData) {
  const pos = data.atoms.positions
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < data.atoms.count; i++) {
    for (let d = 0; d < 3; d++) {
      const v = pos[i * 3 + d]
      if (v < min[d]) min[d] = v
      if (v > max[d]) max[d] = v
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ]
  const radius = Math.max(2, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
  data.bbox = { min, max, center, radius }
}
