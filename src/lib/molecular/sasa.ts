// 溶剂可及面积（SASA）计算：Shrake–Rupley 算法（对标 FreeSASA / ChimeraX measure area）
// 每原子在 vdW+probe 扩展球面上均匀撒 Fibonacci 采样点，统计未被邻近原子扩展球遮挡的点比例。
// 掩码语义：activeMask = 需要计算 SASA 的原子；occluderMask = 作为遮挡体的原子。
//   完整结构：active = occluder = all
//   ΔSASA 三路：A 单独（active=A, occluder=A）、B 单独、复合物（active=A∪B, occluder=A∪B）
import type { StructureData } from './parser'
import { residueClass } from './chemistry'

/** vdW 半径（ProtOr/Bondi 混合，FreeSASA 默认集），单位 Å */
const VDW_RADII: Record<string, number> = {
  H: 1.20, D: 1.20,
  C: 1.70, N: 1.55, O: 1.52, S: 1.80, P: 1.80, SE: 1.90,
  F: 1.47, CL: 1.75, BR: 1.85, I: 1.98,
  NA: 2.27, MG: 1.73, K: 2.75, CA: 2.31, ZN: 1.39, FE: 2.00, CU: 1.40,
  MN: 2.25, NI: 1.63, CO: 1.63, CD: 1.58, HG: 1.55,
}
const VDW_FALLBACK = 1.70

export function atomVDWRadius(el: string): number {
  return VDW_RADII[el.toUpperCase()] ?? VDW_FALLBACK
}

/** 黄金角（弧度） */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const sphereCache = new Map<number, Float32Array>()

/** Fibonacci 球面单位采样点（缓存复用）：返回 xyz × n */
export function fibonacciSphere(n: number): Float32Array {
  const cached = sphereCache.get(n)
  if (cached) return cached
  const pts = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    const z = 1 - 2 * (k + 0.5) / n
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const theta = k * GOLDEN_ANGLE
    pts[k * 3] = r * Math.cos(theta)
    pts[k * 3 + 1] = r * Math.sin(theta)
    pts[k * 3 + 2] = z
  }
  sphereCache.set(n, pts)
  return pts
}

/** 均匀空间网格（worker 内同构实现；此处供主线程同步计算复用） */
class SASAGrid {
  private cell: number
  private map = new Map<number, number[]>()
  private minIx = 0; private minIy = 0; private minIz = 0
  private maxIx = 0; private maxIy = 0; private maxIz = 0

  constructor(positions: Float32Array, count: number, cell = 6) {
    this.cell = cell
    if (count > 0) {
      this.minIx = this.maxIx = this.gi(positions[0])
      this.minIy = this.maxIy = this.gi(positions[1])
      this.minIz = this.maxIz = this.gi(positions[2])
    }
    for (let i = 0; i < count; i++) {
      const ix = this.gi(positions[i * 3]), iy = this.gi(positions[i * 3 + 1]), iz = this.gi(positions[i * 3 + 2])
      if (ix < this.minIx) this.minIx = ix; if (ix > this.maxIx) this.maxIx = ix
      if (iy < this.minIy) this.minIy = iy; if (iy > this.maxIy) this.maxIy = iy
      if (iz < this.minIz) this.minIz = iz; if (iz > this.maxIz) this.maxIz = iz
      const key = (ix << 20) | (iy << 10) | iz
      let arr = this.map.get(key)
      if (!arr) { arr = []; this.map.set(key, arr) }
      arr.push(i)
    }
  }

  private gi(v: number) { return Math.floor(v / this.cell) + 2048 }

  query(x: number, y: number, z: number, r: number): number[] {
    const out: number[] = []
    const cx = this.gi(x), cy = this.gi(y), cz = this.gi(z)
    const span = Math.ceil(r / this.cell)
    for (let ix = cx - span; ix <= cx + span; ix++) {
      if (ix < this.minIx - 1 || ix > this.maxIx + 1) continue
      for (let iy = cy - span; iy <= cy + span; iy++) {
        if (iy < this.minIy - 1 || iy > this.maxIy + 1) continue
        for (let iz = cz - span; iz <= cz + span; iz++) {
          if (iz < this.minIz - 1 || iz > this.maxIz + 1) continue
          const arr = this.map.get((ix << 20) | (iy << 10) | iz)
          if (arr) for (let k = 0; k < arr.length; k++) out.push(arr[k])
        }
      }
    }
    return out
  }
}

export interface SasaComputeOptions {
  /** 水探针半径（Å），默认 1.4 */
  probe?: number
  /** 每原子采样点数（92 ≈ FreeSASA 默认精度），默认 92 */
  nPoints?: number
  /** 跳过氢原子（默认 true：氢的 SASA 语义不稳定且 X-ray 结构无氢） */
  skipHydrogens?: boolean
}

/**
 * Shrake–Rupley 核心：带掩码的逐原子 SASA。
 * active/occluder 掩码为 null 时视为全选。返回 per-atom SASA（Å²，非 active 原子为 0）。
 */
export function computeSasaMasked(
  positions: Float32Array,
  radii: Float32Array,
  count: number,
  activeMask: Uint8Array | null,
  occluderMask: Uint8Array | null,
  probe: number,
  nPoints: number,
): Float32Array {
  const out = new Float32Array(count)
  if (count === 0) return out
  const sphere = fibonacciSphere(nPoints)
  const grid = new SASAGrid(positions, count, 6)
  // 最大遮挡半径（查询窗口用）
  let maxR = 0
  for (let i = 0; i < count; i++) {
    if (occluderMask && !occluderMask[i]) continue
    const r = radii[i] + probe
    if (r > maxR) maxR = r
  }

  for (let i = 0; i < count; i++) {
    if (activeMask && !activeMask[i]) continue
    const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2]
    const rExt = radii[i] + probe
    const rExt2 = rExt * rExt
    // 邻居只需检查 rExt + maxR 范围
    const cand = grid.query(xi, yi, zi, rExt + maxR)
    // 预展开邻居扩展半径平方
    const nb: number[] = []
    const nbSep2: number[] = []
    for (const j of cand) {
      if (j === i) continue
      if (occluderMask && !occluderMask[j]) continue
      const rj = radii[j] + probe
      // 粗筛：中心距 > rExt + rj 时不可能遮挡任何采样点
      const dx = positions[j * 3] - xi, dy = positions[j * 3 + 1] - yi, dz = positions[j * 3 + 2] - zi
      const d2 = dx * dx + dy * dy + dz * dz
      const sum = rExt + rj
      if (d2 > sum * sum) continue
      nb.push(j)
      nbSep2.push(rj * rj)
    }
    // 采样点遮挡统计
    let free = 0
    for (let k = 0; k < nPoints; k++) {
      const px = xi + sphere[k * 3] * rExt
      const py = yi + sphere[k * 3 + 1] * rExt
      const pz = zi + sphere[k * 3 + 2] * rExt
      let occluded = false
      for (let m = 0; m < nb.length; m++) {
        const j = nb[m]
        const qx = px - positions[j * 3], qy = py - positions[j * 3 + 1], qz = pz - positions[j * 3 + 2]
        if (qx * qx + qy * qy + qz * qz < nbSep2[m]) { occluded = true; break }
      }
      if (!occluded) free++
    }
    out[i] = 4 * Math.PI * rExt2 * (free / nPoints)
  }
  return out
}

// ---------- 结构级封装 ----------

/** 预编译逐原子 vdW 半径 */
export function compileRadii(elements: string[]): Float32Array {
  const r = new Float32Array(elements.length)
  for (let i = 0; i < elements.length; i++) r[i] = atomVDWRadius(elements[i])
  return r
}

export interface SasaStats {
  /** 总 SASA（Å²） */
  total: number
  /** 疏水残基贡献（nonpolar/aromatic/cysteine/proline 类） */
  hydrophobic: number
  /** 极性残基贡献 */
  polar: number
  /** 水与配体贡献 */
  het: number
  /** 按残基聚合（索引对齐 data.residues，非聚合物为 0） */
  perResidue: Float32Array
  /** 计算耗时 ms */
  ms: number
}

/** 全结构 SASA + 统计（写回 data.sasa 由调用方决定） */
export function computeSasa(data: StructureData, opts: SasaComputeOptions = {}): { perAtom: Float32Array; stats: SasaStats } {
  const t0 = performance.now()
  const { probe = 1.4, nPoints = 92, skipHydrogens = true } = opts
  const n = data.atoms.count
  const radii = compileRadii(data.atoms.elements)
  const active = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (skipHydrogens && (data.atoms.elements[i] === 'H' || data.atoms.elements[i] === 'D')) continue
    active[i] = 1
  }
  const perAtom = computeSasaMasked(data.atoms.positions, radii, n, active, active, probe, nPoints)
  const stats = sasaStats(data, perAtom)
  stats.ms = performance.now() - t0
  return { perAtom, stats }
}

/** 对已有 per-atom SASA 聚合统计 */
export function sasaStats(data: StructureData, perAtom: Float32Array): SasaStats {
  const nRes = data.residues.length
  const perResidue = new Float32Array(nRes)
  let total = 0, hydrophobic = 0, polar = 0, het = 0
  for (let i = 0; i < data.atoms.count; i++) {
    const s = perAtom[i]
    if (s <= 0) continue
    const ri = data.atomResidue[i]
    perResidue[ri] += s
    total += s
    const res = data.residues[ri]
    if (res.water) { het += s; continue }
    const cls = residueClass(res.resName)
    if (!res.polymer) { het += s; continue }
    if (cls === 'nonpolar' || cls === 'aromatic' || cls === 'cysteine') hydrophobic += s
    else polar += s
  }
  return { total, hydrophobic, polar, het, perResidue, ms: 0 }
}

// ---------- 界面埋藏面积（ΔSASA / BSA） ----------

export interface BuriedSasaResult {
  /** per-atom ΔSASA（alone − complex；A∪B 之外为 0） */
  delta: Float32Array
  /** 残基级 ΔSASA（索引对齐 residues） */
  perResidue: Float32Array
  /** A 侧埋藏总面积（Å²） */
  buriedA: number
  /** B 侧埋藏总面积（Å²） */
  buriedB: number
  /** ΔSASA > 1 Å² 的界面残基索引（A、B 分列） */
  coreA: number[]
  coreB: number[]
  /** A/B 原子数 */
  atomsA: number
  atomsB: number
  /** 掩码重原子数 */
  heavyA: number
  heavyB: number
  ms: number
}

/**
 * 界面埋藏面积：ΔSASA = SASA(单独) − SASA(复合物)。
 * 三路计算（A alone / B alone / A∪B），标准界面残基判据 ΔSASA > 1 Å²。
 */
export function computeBuriedSasa(
  data: StructureData,
  maskA: Uint8Array,
  maskB: Uint8Array,
  opts: SasaComputeOptions = {},
): BuriedSasaResult {
  const t0 = performance.now()
  const { probe = 1.4, nPoints = 92, skipHydrogens = true } = opts
  const n = data.atoms.count
  const radii = compileRadii(data.atoms.elements)
  // 掩码（可选去氢）
  const a = new Uint8Array(n), b = new Uint8Array(n), ab = new Uint8Array(n)
  let atomsA = 0, atomsB = 0, heavyA = 0, heavyB = 0
  for (let i = 0; i < n; i++) {
    const isH = skipHydrogens && (data.atoms.elements[i] === 'H' || data.atoms.elements[i] === 'D')
    a[i] = maskA[i] && !isH ? 1 : 0
    b[i] = maskB[i] && !isH ? 1 : 0
    ab[i] = a[i] || b[i]
    if (maskA[i]) { atomsA++; if (!isH) heavyA++ }
    if (maskB[i]) { atomsB++; if (!isH) heavyB++ }
  }
  const sasaA = computeSasaMasked(data.atoms.positions, radii, n, a, a, probe, nPoints)
  const sasaB = computeSasaMasked(data.atoms.positions, radii, n, b, b, probe, nPoints)
  const sasaAB = computeSasaMasked(data.atoms.positions, radii, n, ab, ab, probe, nPoints)
  const delta = new Float32Array(n)
  let buriedA = 0, buriedB = 0
  for (let i = 0; i < n; i++) {
    if (a[i]) {
      const d = sasaA[i] - sasaAB[i]
      if (d > 0) { delta[i] = d; buriedA += d }
    } else if (b[i]) {
      const d = sasaB[i] - sasaAB[i]
      if (d > 0) { delta[i] = d; buriedB += d }
    }
  }
  // 残基聚合 + 核心界面残基（ΔSASA > 1 Å²）
  const perResidue = new Float32Array(data.residues.length)
  const coreA: number[] = [], coreB: number[] = []
  for (let i = 0; i < n; i++) {
    if (delta[i] > 0) perResidue[data.atomResidue[i]] += delta[i]
  }
  for (let r = 0; r < data.residues.length; r++) {
    if (perResidue[r] <= 1) continue
    if (maskA[data.residues[r].start]) coreA.push(r)
    else coreB.push(r)
  }
  return { delta, perResidue, buriedA, buriedB, coreA, coreB, atomsA, atomsB, heavyA, heavyB, ms: performance.now() - t0 }
}

/**
 * 跨结构界面埋藏面积（纯数值版，无 StructureData 依赖）：
 * 调用方把两个结构的 positions/radii/isHydrogen 拼接为联合数组，
 * maskA 只覆盖 A 结构区间 [0, nA)，maskB 只覆盖 B 结构区间 [nA, nA+nB)。
 * 三路 SASA 语义与 computeBuriedSasa 一致（A alone / B alone / A∪B）；
 * 残基聚合与核心残基判定由调用方按各自结构完成。
 */
export function computeBuriedSasaArrays(
  positions: Float32Array,
  radii: Float32Array,
  isHydrogen: Uint8Array,
  maskA: Uint8Array,
  maskB: Uint8Array,
  probe: number,
  nPoints: number,
): { delta: Float32Array; buriedA: number; buriedB: number; heavyA: number; heavyB: number } {
  const count = radii.length
  const a = new Uint8Array(count), b = new Uint8Array(count), ab = new Uint8Array(count)
  let heavyA = 0, heavyB = 0
  for (let i = 0; i < count; i++) {
    const skip = isHydrogen[i] === 1
    a[i] = maskA[i] && !skip ? 1 : 0
    b[i] = maskB[i] && !skip ? 1 : 0
    ab[i] = a[i] || b[i]
    if (a[i]) heavyA++
    if (b[i]) heavyB++
  }
  const sasaA = computeSasaMasked(positions, radii, count, a, a, probe, nPoints)
  const sasaB = computeSasaMasked(positions, radii, count, b, b, probe, nPoints)
  const sasaAB = computeSasaMasked(positions, radii, count, ab, ab, probe, nPoints)
  const delta = new Float32Array(count)
  let buriedA = 0, buriedB = 0
  for (let i = 0; i < count; i++) {
    if (a[i]) {
      const d = sasaA[i] - sasaAB[i]
      if (d > 0) { delta[i] = d; buriedA += d }
    } else if (b[i]) {
      const d = sasaB[i] - sasaAB[i]
      if (d > 0) { delta[i] = d; buriedB += d }
    }
  }
  return { delta, buriedA, buriedB, heavyA, heavyB }
}

/** 原子最大理论 SASA（扩展球面积，暴露分数分母） */
export function maxAtomSasa(el: string, probe: number): number {
  const r = atomVDWRadius(el) + probe
  return 4 * Math.PI * r * r
}
