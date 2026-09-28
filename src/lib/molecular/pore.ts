// HOLE 式离子通道孔道剖面分析（r72）
// ─────────────────────────────────────────────────────────────────────────────
// 对标 Smart/Ogden/Wallace 的 HOLE 程序（Biophys J, 1996）核心输出：沿通道轴逐点
// 计算能放入孔道而不与蛋白原子（vdW 半径）碰撞的最大球半径 R(t)，产出：
//  · 孔道剖面曲线（3D 环带 + 2D 剖面卡，红/绿/蓝三分区=HOLE 惯例色）
//  · 收缩点（constriction）位置与半径——通道开关/选择性滤波器的关键读数
//  · 膜蛋白语境：membrane 命令画脂双层板（孔道分析图的标配语境）
//
// 算法（简明球拟合，与 HOLE 同族）：
//  ① 通道轴 = 蛋白聚合物原子的主方差轴（3×3 协方差 Jacobi 特征分解；
//     通道蛋白沿孔轴最长，主轴即孔轴——KcsA 1BL8 实证）
//  ② 轴上采样 N 点：R(t) = min_i(|a_i − p(t)| − vdw_i)，封顶 maxR（封顶=bulk/开口腔）
//  ③ 采样窗口剪枝：原子按 t 排序 + 二分定位窗口（|t_i − t| < maxR + maxVdw），
//     60K 原子结构也能毫秒级完成（纯计算无 worker 依赖）
// 计入原子 = 聚合物（蛋白/核酸）全部原子；水/配体/离子不计（孔道几何由蛋白壁决定，
// 与 HOLE 惯例一致——通道内的离子会错误地把剖面「压死」在轴上）。
import { tt } from '@/i18n'
import type { StructureData } from './parser'
import { elementInfo } from './chemistry'
import { dataRegistry, engineRef, useMolStore } from './store'
import { usePoreStore, type PoreResult, type PoreSample } from './pore-store'

/** HOLE 三分区阈值（Å）：红=过窄（水合离子难通过）/ 绿=单水合 K⁺ 可过 / 蓝=宽敞 */
export const HOLE_NARROW = 1.15
export const HOLE_MAX_GREEN = 2.3

/** 孔道分区色（HOLE 惯例；数据编码色非 UI 主题色） */
export const PORE_ZONE_COLORS = { narrow: '#dc2626', mid: '#16a34a', wide: '#2563eb' } as const

export function poreZoneColor(r: number): string {
  if (r < HOLE_NARROW) return PORE_ZONE_COLORS.narrow
  if (r < HOLE_MAX_GREEN) return PORE_ZONE_COLORS.mid
  return PORE_ZONE_COLORS.wide
}

/** 3×3 对称阵 Jacobi 特征分解（engine.ts 同款数学，独立副本避免循环依赖） */
function eigenSymmetric3(a: number[]): { vals: number[]; vecs: number[][] } {
  const m = [...a]
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 16; sweep++) {
    let off = 0
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += m[i * 3 + j] * m[i * 3 + j]
    if (off < 1e-12) break
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(m[p * 3 + q]) < 1e-14) continue
        const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * m[p * 3 + q])
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 3; k++) {
          const mkp = m[k * 3 + p]
          const mkq = m[k * 3 + q]
          m[k * 3 + p] = c * mkp - s * mkq
          m[k * 3 + q] = s * mkp + c * mkq
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p * 3 + k]
          const mqk = m[q * 3 + k]
          m[p * 3 + k] = c * mpk - s * mqk
          m[q * 3 + k] = s * mpk + c * mqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p]
          const vkq = v[k * 3 + q]
          v[k * 3 + p] = c * vkp - s * vkq
          v[k * 3 + q] = s * vkp + c * vkq
        }
      }
    }
  }
  const vals = [m[0], m[4], m[8]]
  const vecs = [[v[0], v[3], v[6]], [v[1], v[4], v[7]], [v[2], v[5], v[8]]]
  return { vals, vecs }
}

/** 聚合物原子集合上的主轴（最大方差方向）+ 质心。膜蛋白语境与孔道轴共用 */
export function principalAxis(data: StructureData): { origin: [number, number, number]; dir: [number, number, number] } {
  const pos = data.atoms.positions
  const residues = data.residues
  // 聚合物残基原子（排除水/配体/离子：膜几何由蛋白壁决定）
  let n = 0
  let cx = 0, cy = 0, cz = 0
  for (let ri = 0; ri < residues.length; ri++) {
    const r = residues[ri]
    if (!r.polymer || r.water) continue
    for (let i = r.start; i < r.end; i++) {
      cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; n++
    }
  }
  if (n === 0) {
    // 退化：非聚合物结构（纯配体）用全部原子
    for (let i = 0; i < data.atoms.count; i++) {
      cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; n++
    }
  }
  cx /= n; cy /= n; cz /= n
  // 协方差（聚合物原子；退化时全原子）
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  const acc = (i: number) => {
    const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  if (n > 0 && residues.some(r => r.polymer && !r.water)) {
    for (let ri = 0; ri < residues.length; ri++) {
      const r = residues[ri]
      if (!r.polymer || r.water) continue
      for (let i = r.start; i < r.end; i++) acc(i)
    }
  } else {
    for (let i = 0; i < data.atoms.count; i++) acc(i)
  }
  const { vals, vecs } = eigenSymmetric3([xx, xy, xz, xy, yy, yz, xz, yz, zz])
  let best = 0
  for (let i = 1; i < 3; i++) if (vals[i] > vals[best]) best = i
  const d = vecs[best]
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  return { origin: [cx, cy, cz], dir: [d[0] / len, d[1] / len, d[2] / len] }
}

export interface PoreOptions {
  /** 剖面封顶半径（Å；两端开口腔/胞外腔的显示上限） */
  maxR: number
  /** 轴向采样点数 */
  samples: number
}

/** 孔道剖面计算（纯函数；世界坐标，随结构位姿实时） */
export function computePoreProfile(data: StructureData, opts: PoreOptions): PoreResult {
  const t0 = performance.now()
  const { origin, dir } = principalAxis(data)
  const pos = data.atoms.positions
  const elements = data.atoms.elements
  const residues = data.residues

  // 聚合物原子（蛋白壁）：t 投影 + vdW 半径，按 t 排序供窗口剪枝
  const idx: number[] = []
  for (let ri = 0; ri < residues.length; ri++) {
    const r = residues[ri]
    if (!r.polymer || r.water) continue
    for (let i = r.start; i < r.end; i++) idx.push(i)
  }
  const K = idx.length
  const ts = new Float64Array(K)
  const vdw = new Float32Array(K)
  let maxVdw = 0
  let tMin = Infinity, tMax = -Infinity
  for (let k = 0; k < K; k++) {
    const i = idx[k]
    const t = (pos[i * 3] - origin[0]) * dir[0] + (pos[i * 3 + 1] - origin[1]) * dir[1] + (pos[i * 3 + 2] - origin[2]) * dir[2]
    ts[k] = t
    const vi = elementInfo(elements[i]).vdw
    vdw[k] = vi
    if (vi > maxVdw) maxVdw = vi
    if (t < tMin) tMin = t
    if (t > tMax) tMax = t
  }
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) => ts[a] - ts[b])
  const tsSorted = new Float64Array(K)
  for (let k = 0; k < K; k++) tsSorted[k] = ts[order[k]]

  // 采样区间：蛋白跨度内收 2.5Å（避开轴端点的边界伪影）
  const margin = 2.5
  const span = tMax - tMin
  const lo = tMin + margin, hi = tMax - margin
  const N = Math.max(24, Math.min(opts.samples, 400))
  const samples: PoreSample[] = []
  const window = opts.maxR + maxVdw + 1
  // 二分：首个 ≥ x 的排序下标
  const lowerBound = (x: number) => {
    let a = 0, b = K
    while (a < b) { const m = (a + b) >> 1; if (tsSorted[m] < x) a = m + 1; else b = m }
    return a
  }
  let cT = lo, cR = Infinity
  for (let s = 0; s < N; s++) {
    const t = lo + ((hi - lo) * s) / (N - 1)
    const px = origin[0] + dir[0] * t, py = origin[1] + dir[1] * t, pz = origin[2] + dir[2] * t
    let r = opts.maxR
    const from = lowerBound(t - window)
    for (let q = from; q < K && tsSorted[q] <= t + window; q++) {
      const k = order[q]
      const ax = pos[idx[k] * 3], ay = pos[idx[k] * 3 + 1], az = pos[idx[k] * 3 + 2]
      const d = Math.hypot(ax - px, ay - py, az - pz) - vdw[k]
      if (d < r) r = d
      if (r <= 0) break // 已被原子覆盖（负半径不再有意义，截断求值）
    }
    if (r < 0) r = 0
    samples.push({ t: +t.toFixed(2), r: +r.toFixed(3) })
    if (r < cR) { cR = r; cT = t }
  }

  const name = useMolStore.getState().structures.find(x => x.id === data.id)?.name ?? data.name
  return {
    structureId: data.id,
    structureName: name,
    origin, dir,
    samples,
    maxR: opts.maxR,
    constriction: { t: +cT.toFixed(2), r: +cR.toFixed(3) },
    span: +span.toFixed(1),
    tMin: +tMin.toFixed(2), tMax: +tMax.toFixed(2),
    nAtoms: K,
    ms: +(performance.now() - t0).toFixed(1),
  }
}

export type PoreRunResult = { ok: true; result: PoreResult } | { ok: false; message: string }

/** 命令入口：计算活动结构剖面 + 存 store + 触发引擎环带渲染 */
export function runPore(opts: Partial<PoreOptions> = {}): PoreRunResult {
  const s = useMolStore.getState()
  if (!s.activeId) return { ok: false, message: tt({ zh: '当前没有结构——先加载离子通道（如 load 1bl8 KcsA）', en: 'No structure loaded — load an ion channel first (e.g. load 1bl8 KcsA)' }) }
  const data = dataRegistry.get(s.activeId)
  if (!data) return { ok: false, message: tt({ zh: '结构数据不存在', en: 'Structure data not found' }) }
  const maxR = Math.max(3, Math.min(opts.maxR ?? 8, 16))
  const samples = Math.max(60, Math.min(opts.samples ?? 160, 400))
  const result = computePoreProfile(data, { maxR, samples })
  usePoreStore.getState().set(result)
  engineRef.current?.updatePore()
  return { ok: true, result }
}

/** 清除孔道剖面（pore off / 关闭剖面卡共用） */
export function clearPore(): void {
  usePoreStore.getState().clear()
  engineRef.current?.updatePore()
}
