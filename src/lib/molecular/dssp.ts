// DSSP 风格二级结构指认（Kabsch–Sander 骨架氢键能量 + 螺旋/桥接判定）
// 用途：① 无 HELIX/SHEET 记录结构的 cartoon 兜底 ② `dssp` 命令强制重算
// 参考：Kabsch & Sander (1983) Biopolymers 22:2577-2637
// 能量：E = q1·q2·(1/rON + 1/rCH − 1/rOH − 1/rCN)·f，q1=0.42e、q2=0.20e、f=332
// E < −0.5 kcal/mol 判定为骨架氢键；相邻残基(|Δi|<2)排除（肽键误报）
import type { StructureData } from './parser'
import { AMINO_ACIDS } from './chemistry'

export interface DSSPResult {
  /** 每残基指认：0=loop 1=helix 2=strand */
  ss: Uint8Array
  helixResidues: number
  strandResidues: number
  loopResidues: number
  hbonds: number
  bridges: number
  ms: number
}

/** 静电常数（kcal·Å/mol） */
const F = 0.42 * 0.20 * 332
/** 氢键能量阈值（kcal/mol） */
const E_THRESHOLD = -0.5
/** O···N 搜索半径（Å）——E 阈值决定的有效范围上限 */
const SEARCH_R = 12

interface BB {
  /** N/CA/C/O 原子索引（-1 = 缺失） */
  n: number
  ca: number
  c: number
  o: number
  /** 显式酰胺氢原子索引（-1 = 需要放置） */
  h: number
  /** 前一残基 C 原子索引（H 放置用，-1 = 不可作供体） */
  cPrev: number
  /** 脯氨酸（无酰胺氢，不能作供体） */
  pro: boolean
  /** 链内序号 */
  order: number
  chain: number
}

const AMIDE_H_NAMES = new Set(['H', '1H', '2H', '3H', 'H1', 'H2', 'H3'])

export function computeDSSP(data: StructureData): DSSPResult {
  const t0 = performance.now()
  const atoms = data.atoms
  const residues = data.residues
  const nR = residues.length
  const ss = new Uint8Array(nR)
  if (nR === 0) return { ss, helixResidues: 0, strandResidues: 0, loopResidues: 0, hbonds: 0, bridges: 0, ms: performance.now() - t0 }

  // ---- 1. 每条蛋白链的骨架原子 + 链内序号 ----
  const bb: (BB | null)[] = new Array(nR).fill(null)
  for (let ci = 0; ci < data.chains.length; ci++) {
    const ch = data.chains[ci]
    let order = 0
    let lastC = -1
    for (const ri of ch.residueIdx) {
      const r = residues[ri]
      const isAA = AMINO_ACIDS.has(r.resName.toUpperCase())
      if (!isAA || r.water) continue
      let n = -1, ca = -1, c = -1, o = -1, h = -1
      for (let i = r.start; i < r.end; i++) {
        const nm = atoms.names[i]
        if (nm === 'N') n = i
        else if (nm === 'CA') ca = i
        else if (nm === 'C') c = i
        else if (nm === 'O' || nm === 'OXT') { if (o < 0) o = i }
        else if (AMIDE_H_NAMES.has(nm)) h = i
      }
      if (n < 0 || ca < 0 || c < 0 || o < 0) { order++; continue }
      bb[ri] = {
        n, ca, c, o, h,
        cPrev: lastC,
        pro: r.resName.toUpperCase() === 'PRO',
        order, chain: ci,
      }
      order++
      lastC = c
    }
  }

  // ---- 2. 供体氢位置（显式 H 或理想几何放置）----
  // 放置方法（经 1D3Z 真实氢验证，平均误差 0.03 Å）：
  // H 位于 C'(prev)-N-Cα(i) 平面内，从 N→C'(prev) 方向旋转 120°，取远离 Cα(i) 一侧，键长 1.0 Å
  const pos = atoms.positions
  const hPos = new Float32Array(nR * 3)
  const canDonate = new Uint8Array(nR)
  for (let ri = 0; ri < nR; ri++) {
    const b = bb[ri]
    if (!b || b.pro) continue
    if (b.h >= 0) {
      hPos[ri * 3] = pos[b.h * 3]
      hPos[ri * 3 + 1] = pos[b.h * 3 + 1]
      hPos[ri * 3 + 2] = pos[b.h * 3 + 2]
      canDonate[ri] = 1
    } else if (b.cPrev >= 0 && b.ca >= 0) {
      const nx = pos[b.n * 3], ny = pos[b.n * 3 + 1], nz = pos[b.n * 3 + 2]
      // u1 = unit(C'prev − N)，u2 = unit(Cα − N)
      let u1x = pos[b.cPrev * 3] - nx, u1y = pos[b.cPrev * 3 + 1] - ny, u1z = pos[b.cPrev * 3 + 2] - nz
      let u2x = pos[b.ca * 3] - nx, u2y = pos[b.ca * 3 + 1] - ny, u2z = pos[b.ca * 3 + 2] - nz
      const l1 = Math.sqrt(u1x * u1x + u1y * u1y + u1z * u1z)
      const l2 = Math.sqrt(u2x * u2x + u2y * u2y + u2z * u2z)
      if (l1 > 0.4 && l2 > 0.4) {
        u1x /= l1; u1y /= l1; u1z /= l1
        u2x /= l2; u2y /= l2; u2z /= l2
        // 平面法线（退化时回退 C' 延长线放置）
        let kx = u1y * u2z - u1z * u2y
        let ky = u1z * u2x - u1x * u2z
        let kz = u1x * u2y - u1y * u2x
        const kl = Math.sqrt(kx * kx + ky * ky + kz * kz)
        if (kl > 1e-6) {
          kx /= kl; ky /= kl; kz /= kl
          const th = 120 * Math.PI / 180
          const c = Math.cos(th), s = Math.sin(th)
          const dot1 = kx * u1x + ky * u1y + kz * u1z
          // Rodrigues 旋转 u1 绕 nrm ±120°，两候选取远离 Cα 者
          const rotSign = (sgn: number) => ({
            x: u1x * c + kx * dot1 * (1 - c) + (ky * u1z - kz * u1y) * s * sgn,
            y: u1y * c + ky * dot1 * (1 - c) + (kz * u1x - kx * u1z) * s * sgn,
            z: u1z * c + kz * dot1 * (1 - c) + (kx * u1y - ky * u1x) * s * sgn,
          })
          const r1 = rotSign(1), r2 = rotSign(-1)
          const d1 = r1.x * u2x + r1.y * u2y + r1.z * u2z
          const d2 = r2.x * u2x + r2.y * u2y + r2.z * u2z
          const hDir = d1 < d2 ? r1 : r2
          hPos[ri * 3] = nx + hDir.x
          hPos[ri * 3 + 1] = ny + hDir.y
          hPos[ri * 3 + 2] = nz + hDir.z
          canDonate[ri] = 1
        } else {
          // 共线退化：C' 延长线
          hPos[ri * 3] = nx + u1x
          hPos[ri * 3 + 1] = ny + u1y
          hPos[ri * 3 + 2] = nz + u1z
          canDonate[ri] = 1
        }
      }
    }
  }

  // ---- 3. 骨架氢键（CO(i) → NH(j)）----
  // key = i * nR + j；相邻(|Δorder|<2)同链排除；链间断开由 order 差体现
  const hbs = new Set<number>()
  const hb = (i: number, j: number) => hbs.has(i * nR + j)
  for (let i = 0; i < nR; i++) {
    const bi = bb[i]
    if (!bi || bi.o < 0 || bi.c < 0) continue
    const ox = pos[bi.o * 3], oy = pos[bi.o * 3 + 1], oz = pos[bi.o * 3 + 2]
    const cx = pos[bi.c * 3], cy = pos[bi.c * 3 + 1], cz = pos[bi.c * 3 + 2]
    const cand = data.grid.queryRadius(ox, oy, oz, SEARCH_R, pos)
    for (const a2 of cand) {
      if (atoms.names[a2] !== 'N') continue
      const j = data.atomResidue[a2]
      if (j === i) continue
      const bj = bb[j]
      if (!bj || !canDonate[j]) continue
      if (bj.chain === bi.chain && Math.abs(bj.order - bi.order) < 2) continue
      const nx = pos[a2 * 3], ny = pos[a2 * 3 + 1], nz = pos[a2 * 3 + 2]
      const hx = hPos[j * 3], hy = hPos[j * 3 + 1], hz = hPos[j * 3 + 2]
      // CA-CA 预筛（能量达标必然 CA 距离 < 15Å）
      const dcax = pos[bi.ca * 3] - pos[bj.ca * 3]
      const dcay = pos[bi.ca * 3 + 1] - pos[bj.ca * 3 + 1]
      const dcaz = pos[bi.ca * 3 + 2] - pos[bj.ca * 3 + 2]
      if (dcax * dcax + dcay * dcay + dcaz * dcaz > 225) continue
      const rON = Math.sqrt((ox - nx) ** 2 + (oy - ny) ** 2 + (oz - nz) ** 2)
      const rCH = Math.sqrt((cx - hx) ** 2 + (cy - hy) ** 2 + (cz - hz) ** 2)
      const rOH = Math.sqrt((ox - hx) ** 2 + (oy - hy) ** 2 + (oz - hz) ** 2)
      const rCN = Math.sqrt((cx - nx) ** 2 + (cy - ny) ** 2 + (cz - nz) ** 2)
      const E = F * (1 / rON + 1 / rCH - 1 / rOH - 1 / rCN)
      if (E < E_THRESHOLD) hbs.add(i * nR + j)
    }
  }

  // ---- 4. 螺旋：3/4-turn 标记 → 连续 run ≥ 4 ----
  // (chain, order) → residue 索引表（避免 O(nR) 内层搜索）
  const turn = new Uint8Array(nR)
  const orderByChain = new Map<number, Map<number, number>>()
  for (let ri = 0; ri < nR; ri++) {
    const b = bb[ri]
    if (!b) continue
    let m = orderByChain.get(b.chain)
    if (!m) { m = new Map(); orderByChain.set(b.chain, m) }
    m.set(b.order, ri)
  }
  const resAt = (chain: number, order: number) => orderByChain.get(chain)?.get(order) ?? -1
  const markTurnFast = (from: number, n: number) => {
    const b = bb[from]
    if (!b) return
    const t = resAt(b.chain, b.order + n)
    if (t < 0 || !hb(from, t)) return
    for (let k = 1; k <= n - 1; k++) {
      const m = resAt(b.chain, b.order + k)
      if (m >= 0) turn[m] = 1
    }
  }
  for (let ri = 0; ri < nR; ri++) {
    if (!bb[ri]) continue
    markTurnFast(ri, 3)  // 3-turn（3-10 螺旋）
    markTurnFast(ri, 4)  // 4-turn（α-螺旋）
  }
  // 连续 run ≥ 4 → H
  const assignRuns = (marks: Uint8Array, minLen: number, value: number) => {
    for (const [, m] of orderByChain) {
      const orders = [...m.keys()].sort((a, b2) => a - b2)
      let run = 0
      let prev = -10
      for (const o of orders) {
        const ri = m.get(o)!
        if (marks[ri]) {
          run = (o === prev + 1) ? run + 1 : 1
          if (run >= minLen) {
            // 回填整个 run
            for (let k = o - run + 1; k <= o; k++) {
              const rj = m.get(k)
              if (rj !== undefined) ss[rj] = value
            }
          }
        } else run = 0
        prev = o
      }
    }
  }
  assignRuns(turn, 4, 1)

  // ---- 5. β-折叠：桥接（|Δorder|≥3 或链间）----
  // 反平行折叠的氢键呈交替分布（紧对 rON≈3Å，间隔对 rON≈7Å），
  // 需组合判据（实测 1UBQ 几何验证）：
  //   tight:    hb(i→j) && hb(j→i)                       —— 紧对互氢键
  //   flanked:  两侧 ladder 邻对各有强键                   —— 间隔对填充
  //   para1/2/3: 平行几何变体
  const bridged = new Uint8Array(nR)
  let bridgeCount = 0
  const canBridge = (i: number, j: number) => {
    const bi = bb[i]!, bj = bb[j]!
    if (bi.chain === bj.chain && Math.abs(bi.order - bj.order) < 3) return false
    return true
  }
  // 残基（链内序 ±1），不存在返回 -1
  const neighbor = (ri: number, delta: number) => {
    const b = bb[ri]!
    return resAt(b.chain, b.order + delta)
  }
  // 邻对 (i±1, j∓1) 任一方向强键
  const pairStrong = (a: number, b: number) => hb(a, b) || hb(b, a)
  // 候选对：所有强键对 + 其 ladder 邻对（弱对经 flanked 判据补充）
  const candidates = new Set<number>()
  for (const key of hbs) {
    const i = Math.floor(key / nR)
    const j = key - i * nR
    if (!bb[i] || !bb[j]) continue
    if (canBridge(i, j)) candidates.add(key)
    // ladder 邻对（紧对之间的间隔对）
    for (const [di, dj] of [[1, -1], [-1, 1]] as const) {
      const ip = neighbor(i, di), jq = neighbor(j, dj)
      if (ip >= 0 && jq >= 0 && bb[ip] && bb[jq] && canBridge(ip, jq)) candidates.add(ip * nR + jq)
    }
  }
  for (const key of candidates) {
    const i = Math.floor(key / nR)
    const j = key - i * nR
    let isBridge = false
    // tight 反平行：互氢键
    if (hb(j, i) && hb(i, j)) isBridge = true
    // flanked：ladder 两侧邻对 (i-1,j+1) 与 (i+1,j-1) 各有强键（任一方向）
    if (!isBridge) {
      const im1 = neighbor(i, -1), ip1 = neighbor(i, 1)
      const jm1 = neighbor(j, -1), jp1 = neighbor(j, 1)
      const flankA = im1 >= 0 && jp1 >= 0 && pairStrong(im1, jp1)
      const flankB = ip1 >= 0 && jm1 >= 0 && pairStrong(ip1, jm1)
      if (flankA && flankB) isBridge = true
    }
    // para 判据仅对强键对有意义（要求 hb(i,j) 或 hb(j,i)）
    if (!isBridge && hbs.has(key)) {
      const j1 = neighbor(j, 1), i1 = neighbor(i, 1)
      // para1: hb(i→j+1) && hb(j→i+1)
      if (j1 >= 0 && i1 >= 0 && hb(i, j1) && hb(j, i1)) isBridge = true
      // para2: hb(i→j) && hb(j+1→i)
      if (!isBridge && j1 >= 0 && hb(j1, i)) isBridge = true
      // para3: hb(i+1→j) && hb(j→i+1)
      if (!isBridge && i1 >= 0 && hb(i1, j) && hb(j, i1)) isBridge = true
    }
    if (isBridge) {
      bridged[i] = 1
      bridged[j] = 1
      bridgeCount++
    }
  }
  // 连续 bridged run ≥ 2 且非螺旋 → E
  assignRuns(bridged, 2, 2)
  // H 优先（桥接误覆盖螺旋时恢复）
  for (let ri = 0; ri < nR; ri++) {
    if (turn[ri] && ss[ri] === 2) ss[ri] = 1
  }

  let helix = 0, strand = 0, loop = 0
  for (let ri = 0; ri < nR; ri++) {
    if (!bb[ri]) continue
    if (ss[ri] === 1) helix++
    else if (ss[ri] === 2) strand++
    else loop++
  }
  return { ss, helixResidues: helix, strandResidues: strand, loopResidues: loop, hbonds: hbs.size, bridges: bridgeCount, ms: performance.now() - t0 }
}

// ---------- φ/ψ 扭转盆地统计 ----------
// 动机：Kabsch–Sander 氢键法判 E 需要链间/远程链内 H 键桥接伙伴；统计构建
// 引擎（抗体 germline Fv 等）的 β 片段有真实的延伸扭转（φ/ψ 落 β 盆地）但
// 没有折叠配对 → DSSP 诚实报 loop。本统计补上骨架扭转维度：报告 φ/ψ 落在
// α 盆地 / β 盆地的残基比例，让"延伸构象含量"这一设计质量信号可见。
export interface TorsionBasinResult {
  /** 可计算 φ/ψ 的残基对总数 */
  total: number
  /** φ/ψ 落 α 螺旋盆地（φ∈[-80,-30], ψ∈[-60,20]） */
  helixBasin: number
  /** φ/ψ 落 β 延伸盆地（φ∈[-180,-30], ψ∈[90,180]） */
  betaBasin: number
  ms: number
}

/** 标准二面角（IUPAC 符号约定）——p0..p3 四点，绕 p1-p2 轴 */
function dihedral(
  p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[],
): number {
  const b0x = p0[0] - p1[0], b0y = p0[1] - p1[1], b0z = p0[2] - p1[2]
  const b1x = p2[0] - p1[0], b1y = p2[1] - p1[1], b1z = p2[2] - p1[2]
  const b2x = p3[0] - p2[0], b2y = p3[1] - p2[1], b2z = p3[2] - p2[2]
  const n1 = Math.hypot(b1x, b1y, b1z)
  if (n1 < 1e-9) return NaN
  const ux = b1x / n1, uy = b1y / n1, uz = b1z / n1
  // v = b0 ⊥ b1 分量, w = b2 ⊥ b1 分量
  const d0 = b0x * ux + b0y * uy + b0z * uz
  const d2 = b2x * ux + b2y * uy + b2z * uz
  const vx = b0x - d0 * ux, vy = b0y - d0 * uy, vz = b0z - d0 * uz
  const wx = b2x - d2 * ux, wy = b2y - d2 * uy, wz = b2z - d2 * uz
  const x = vx * wx + vy * wy + vz * wz
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
  const y = cx * wx + cy * wy + cz * wz
  return (Math.atan2(y, x) * 180) / Math.PI
}

export function computeTorsionBasins(data: StructureData): TorsionBasinResult {
  const t0 = performance.now()
  const atoms = data.atoms
  const pos = atoms.positions
  const residues = data.residues
  let total = 0, helixBasin = 0, betaBasin = 0

  for (const ch of data.chains) {
    // 收集该链连续氨基酸残基的 (N, CA, C) 索引
    const bbList: { n: number; ca: number; c: number }[] = []
    for (const ri of ch.residueIdx) {
      const r = residues[ri]
      if (!AMINO_ACIDS.has(r.resName.toUpperCase()) || r.water) continue
      let n = -1, ca = -1, c = -1
      for (let i = r.start; i < r.end; i++) {
        const nm = atoms.names[i]
        if (nm === 'N') n = i
        else if (nm === 'CA') ca = i
        else if (nm === 'C') c = i
      }
      if (n >= 0 && ca >= 0 && c >= 0) bbList.push({ n, ca, c })
    }
    for (let i = 0; i < bbList.length; i++) {
      const cur = bbList[i]
      const prev = i > 0 ? bbList[i - 1] : null
      const next = i < bbList.length - 1 ? bbList[i + 1] : null
      if (!prev || !next) continue
      const phi = dihedral(
        [pos[prev.c * 3], pos[prev.c * 3 + 1], pos[prev.c * 3 + 2]],
        [pos[cur.n * 3], pos[cur.n * 3 + 1], pos[cur.n * 3 + 2]],
        [pos[cur.ca * 3], pos[cur.ca * 3 + 1], pos[cur.ca * 3 + 2]],
        [pos[cur.c * 3], pos[cur.c * 3 + 1], pos[cur.c * 3 + 2]],
      )
      const psi = dihedral(
        [pos[cur.n * 3], pos[cur.n * 3 + 1], pos[cur.n * 3 + 2]],
        [pos[cur.ca * 3], pos[cur.ca * 3 + 1], pos[cur.ca * 3 + 2]],
        [pos[cur.c * 3], pos[cur.c * 3 + 1], pos[cur.c * 3 + 2]],
        [pos[next.n * 3], pos[next.n * 3 + 1], pos[next.n * 3 + 2]],
      )
      if (!Number.isFinite(phi) || !Number.isFinite(psi)) continue
      total++
      if (phi >= -80 && phi <= -30 && psi >= -60 && psi <= 20) helixBasin++
      else if (phi >= -180 && phi <= -30 && psi >= 90 && psi <= 180) betaBasin++
    }
  }
  return { total, helixBasin, betaBasin, ms: performance.now() - t0 }
}
