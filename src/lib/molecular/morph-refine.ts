// Morph 帧后处理精修（rigimol 风格）：键长约束松弛（SHAKE）+ 长程去碰撞。
//
// 背景：纯逐原子线性/样条插值会让中间帧出现两类伪影——
//   ① 键长畸变：做旋转运动的键其两端点线性插值后键长先收缩再恢复（视感「橡皮筋抖动」）
//   ② 原子穿插：侧链扫过空间时与非键原子重叠（视感「穿模」）
// 精修流程（对每个中间帧，首尾真实构象不动）：
//   1) SHAKE 松弛：每根键的目标长度 = 两端真实构象（样条结点）键长的线性插值；
//      按逆质量权重把两端点沿键轴拉回目标长度（H 原子承担大部分修正）
//   2) 去碰撞：均匀空间网格找重原子非键近距对（排除同残基/相邻残基/成键对），
//      沿连线对称推开到 vdW×0.72 阈值
//   3) 再跑若干轮 SHAKE 修复去碰撞扰动的键
import type { StructureData } from './parser'

/** vdW 半径（Å，FreeSASA 默认集与 sasa.ts 一致；去碰撞用） */
const VDW_RADII: Record<string, number> = {
  H: 1.20, D: 1.20,
  C: 1.70, N: 1.55, O: 1.52, S: 1.80, P: 1.80, SE: 1.90,
  F: 1.47, CL: 1.75, BR: 1.85, I: 1.98,
  NA: 2.27, MG: 1.73, K: 2.75, CA: 2.31, ZN: 1.39, FE: 2.00, CU: 1.40,
  MN: 2.25, NI: 1.63, CO: 1.63, CD: 1.58, HG: 1.55,
}
const VDW_FALLBACK = 1.70

/** 碰撞判定系数：dist < 0.72 × (ri+rj) 视为碰撞（rigimol/sculpt 常用近似） */
const CLASH_FACTOR = 0.72
/** 去碰撞网格 cell（Å）：覆盖最大常见 vdW 和 × 系数（2.0+2.0 → 2.88）+ 余量 */
const GRID_CELL = 4.0

export interface RefineStats {
  /** 参与约束的键数 */
  bonds: number
  /** 修复前中间帧的平均键长偏差（Å，相对结点插值目标） */
  bondDrift: number
  /** 修复前中间帧的最大键长偏差（Å） */
  maxDrift: number
  /** 修复的非键碰撞对数（逐帧累计） */
  clashesFixed: number
}

/** 每帧的松弛迭代数（帧多时递减保构建耗时可控） */
function shakeIters(frames: number): number {
  return frames > 60 ? 3 : 5
}

/**
 * 就地精修 morph 帧序列。
 * @param sub 轨迹结构（bonds/atoms 元数据来源；原子序与帧数组一致）
 * @param frames 插值帧（frames[0] 与 frames[最后一帧] 为真实构象，不修改）
 * @param knots 样条结点（真实构象坐标，含首尾）；键长目标在其间线性插值
 * @param us 每帧在结点参数空间的坐标（0..knots.length-1；与帧采样参数一致）
 * @returns 统计；键数据缺失（bonds.count=0）返回 null
 */
export function refineMorphFrames(
  sub: StructureData,
  frames: Float32Array[],
  knots: Float32Array[],
  us: number[],
): RefineStats | null {
  const n = sub.atoms.count
  const nb = sub.bonds.count
  if (nb === 0 || frames.length <= 2 || n === 0) return null

  const ba = sub.bonds.a
  const bb = sub.bonds.b
  const elements = sub.atoms.elements
  const atomRes = sub.atomResidue

  // ---------- 预计算：逆质量权重 / vdW 半径 / 成键排除表 ----------
  const w = new Float32Array(n)      // 逆质量（H≈1，重原子≈1/12）
  const rv = new Float32Array(n)     // vdW 半径
  const heavy = new Uint8Array(n)    // 非氢重原子标记
  for (let i = 0; i < n; i++) {
    const el = (elements[i] ?? '').toUpperCase()
    const isH = el === 'H' || el === 'D'
    w[i] = isH ? 1 : 1 / 12
    rv[i] = VDW_RADII[el] ?? VDW_FALLBACK
    heavy[i] = isH ? 0 : 1
  }
  // 成键原子对排除（跨残基二硫键等 |Δres|>1 的键必须显式排除）
  const bonded = new Set<number>()
  for (let b = 0; b < nb; b++) {
    const a1 = ba[b], b1 = bb[b]
    bonded.add(a1 < b1 ? a1 * n + b1 : b1 * n + a1)
  }

  // ---------- 结点键长（每结点每键） ----------
  const M = knots.length
  const klen = new Float32Array(M * nb)
  for (let m = 0; m < M; m++) {
    const K = knots[m]
    for (let b = 0; b < nb; b++) {
      const a1 = ba[b] * 3, b1 = bb[b] * 3
      const dx = K[a1] - K[b1], dy = K[a1 + 1] - K[b1 + 1], dz = K[a1 + 2] - K[b1 + 2]
      klen[m * nb + b] = Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }

  const iters = shakeIters(frames.length)
  let driftSum = 0
  let driftCount = 0
  let maxDrift = 0
  let clashesFixed = 0

  // ---------- 逐帧精修（跳过首尾真实构象） ----------
  for (let f = 1; f < frames.length - 1; f++) {
    const P = frames[f]
    const u = Math.min(Math.max(us[f] ?? 0, 0), M - 1)
    const i0 = Math.min(Math.floor(u), M - 2)
    const tt = u - i0

    // --- 统计修复前键长偏差（一次遍历，兼作基线测量） ---
    for (let b = 0; b < nb; b++) {
      const a1 = ba[b] * 3, b1 = bb[b] * 3
      const dx = P[a1] - P[b1], dy = P[a1 + 1] - P[b1 + 1], dz = P[a1 + 2] - P[b1 + 2]
      const cur = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const target = klen[i0 * nb + b] + (klen[(i0 + 1) * nb + b] - klen[i0 * nb + b]) * tt
      const d = Math.abs(cur - target)
      driftSum += d
      driftCount++
      if (d > maxDrift) maxDrift = d
    }

    // --- SHAKE 松弛：加权拉回目标键长（H 原子逆质量大，承担大部分修正） ---
    const shake = (iterations: number) => {
      for (let it = 0; it < iterations; it++) {
        for (let b = 0; b < nb; b++) {
          const ia = ba[b], ib = bb[b]
          const a3 = ia * 3, b3 = ib * 3
          const dx = P[b3] - P[a3], dy = P[b3 + 1] - P[a3 + 1], dz = P[b3 + 2] - P[a3 + 2]
          const cur = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (cur < 1e-9) continue
          const target = klen[i0 * nb + b] + (klen[(i0 + 1) * nb + b] - klen[i0 * nb + b]) * tt
          const diff = (cur - target) / cur // 归一化偏差系数
          const wa = w[ia], wb = w[ib]
          const sum = wa + wb
          if (sum <= 0) continue
          const ca = (diff * wa) / sum // a 端位移系数
          const cb = (diff * wb) / sum // b 端位移系数
          P[a3] += dx * ca; P[a3 + 1] += dy * ca; P[a3 + 2] += dz * ca
          P[b3] -= dx * cb; P[b3 + 1] -= dy * cb; P[b3 + 2] -= dz * cb
        }
      }
    }
    shake(iters)

    // --- 去碰撞（重原子，均匀网格近邻） ---
    for (let pass = 0; pass < 2; pass++) {
      // 网格重建（每 pass 位置已变）
      const grid = new Map<number, number[]>()
      const cell = GRID_CELL
      let minx = Infinity, miny = Infinity, minz = Infinity
      for (let i = 0; i < n; i++) {
        if (!heavy[i]) continue
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
        if (x < minx) minx = x
        if (y < miny) miny = y
        if (z < minz) minz = z
      }
      if (!isFinite(minx)) break
      const key = (ix: number, iy: number, iz: number) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
      const heavyIdx: number[] = []
      for (let i = 0; i < n; i++) {
        if (!heavy[i]) continue
        heavyIdx.push(i)
        const ix = Math.floor((P[i * 3] - minx) / cell)
        const iy = Math.floor((P[i * 3 + 1] - miny) / cell)
        const iz = Math.floor((P[i * 3 + 2] - minz) / cell)
        const k = key(ix, iy, iz)
        let arr = grid.get(k)
        if (!arr) { arr = []; grid.set(k, arr) }
        arr.push(i)
      }
      let fixedThisPass = 0
      for (const i of heavyIdx) {
        const ix = Math.floor((P[i * 3] - minx) / cell)
        const iy = Math.floor((P[i * 3 + 1] - miny) / cell)
        const iz = Math.floor((P[i * 3 + 2] - minz) / cell)
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
          const arr = grid.get(key(ix + ox, iy + oy, iz + oz))
          if (!arr) continue
          for (const j of arr) {
            if (j <= i) continue
            // 排除：成键 / 同残基 / 相邻残基（肽平面与相邻侧链的合法近距）
            if (bonded.has(i * n + j)) continue
            const dri = atomRes[i], drj = atomRes[j]
            if (Math.abs(dri - drj) <= 1) continue
            const thr = CLASH_FACTOR * (rv[i] + rv[j])
            const a3 = i * 3, b3 = j * 3
            let dx = P[b3] - P[a3], dy = P[b3 + 1] - P[a3 + 1], dz = P[b3 + 2] - P[a3 + 2]
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 >= thr * thr || d2 < 1e-9) continue
            const d = Math.sqrt(d2)
            const push = (thr - d) * 0.5 + 0.02 // 各推一半 + 微过冲帮助收敛
            dx = (dx / d) * push; dy = (dy / d) * push; dz = (dz / d) * push
            const wi = w[i], wj = w[j]
            const sum = wi + wj
            P[a3] -= dx * (wi / sum) * 2; P[a3 + 1] -= dy * (wi / sum) * 2; P[a3 + 2] -= dz * (wi / sum) * 2
            P[b3] += dx * (wj / sum) * 2; P[b3 + 1] += dy * (wj / sum) * 2; P[b3 + 2] += dz * (wj / sum) * 2
            if (pass === 0) clashesFixed++
            fixedThisPass++
          }
        }
      }
      if (fixedThisPass === 0) break
      // 碰撞推开后修复键长（轻量两轮）
      shake(2)
    }
  }

  return {
    bonds: nb,
    bondDrift: driftCount ? driftSum / driftCount : 0,
    maxDrift,
    clashesFixed,
  }
}
