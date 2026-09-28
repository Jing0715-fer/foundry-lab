// 氢键检测与几何
// 判据（ChimeraX/PYMOL 常用风格）：
//  - 有氢结构：D-H...A，H...A ≤ maxDist(默认2.5Å)，D-H...A 角度 ≥ minAngle(默认120°)
//  - 无氢结构（多数 X-ray PDB）：D...A 重原子距离 ≤ maxHeavyDist(默认3.5Å)
// 供体/受体杂原子：N、O、S（及带电的卤素受体可选）
// 排除：同残基内、直接成键、1-3 共键邻居（共享成键原子，如肽键 O=C-N 的 O…N ≈2.3Å——
//  共价几何约束而非氢键；旧版漏掉此排除导致每个肽键都被误判为氢键、整屏虚线）、水-水之间
import type { StructureData } from './parser'
import { WATERS } from './chemistry'

export interface HBond {
  donor: number      // 供体重原子索引
  hydrogen: number   // 氢原子索引（无氢结构为 -1）
  acceptor: number   // 受体原子索引
  dist: number       // 距离（有氢用 H...A，无氢用 D...A）
  angle: number      // D-H...A 角度（无氢为 180 占位）
}

export interface HBondOptions {
  maxDist?: number        // H...A 最大距离（有氢时）
  maxHeavyDist?: number   // D...A 最大距离（无氢时）
  minAngle?: number       // 最小角度
  includeWater?: boolean  // 是否包含水分子参与的氢键
}

const DONOR_ELEMS = new Set(['N', 'O', 'S'])
const ACCEPTOR_ELEMS = new Set(['N', 'O', 'S'])
/** 带有这些氢名的供体（N/O/S 上的氢） */
const isHAttachedToDonor = (hName: string) => /^(\d?H[A-Z]*|\d*H)$/i.test(hName.trim())

export function detectHBonds(structure: StructureData, opts: HBondOptions = {}): HBond[] {
  const {
    maxDist = 2.5,
    maxHeavyDist = 3.5,
    minAngle = 120,
    includeWater = false,
  } = opts
  const atoms = structure.atoms
  const n = atoms.count
  const bonds = structure.bonds
  const out: HBond[] = []
  if (n === 0) return out

  // 邻接表：直接成键排除 + 1-3 共键邻居（共享成键原子）排除
  const bonded = new Set<number>()
  const bondKey = (a: number, b: number) => a * n + b
  const neighbors = new Map<number, number[]>()

  // 供体重原子 → 结合氢（结构有氢时）
  const donorHydrogens = new Map<number, number[]>()
  const hasH = structure.hasHydrogens

  const isAcceptorAtom = (i: number) => ACCEPTOR_ELEMS.has(atoms.elements[i])
  const isWaterRes = (i: number) => structure.residues[structure.atomResidue[i]].water
  if (hasH) {
    // 每个氢找最近的重原子邻居（键内）
    for (let b = 0; b < bonds.count; b++) {
      const a = bonds.a[b], c = bonds.b[b]
      bonded.add(bondKey(a, c))
      bonded.add(bondKey(c, a))
      pushNeighbor(neighbors, a, c)
      pushNeighbor(neighbors, c, a)
      const ea = atoms.elements[a], ec = atoms.elements[c]
      const aIsH = ea === 'H' || ea === 'D'
      const cIsH = ec === 'H' || ec === 'D'
      if (aIsH && !cIsH && DONOR_ELEMS.has(ec)) {
        const list = donorHydrogens.get(c) ?? []
        list.push(a)
        donorHydrogens.set(c, list)
      } else if (cIsH && !aIsH && DONOR_ELEMS.has(ea)) {
        const list = donorHydrogens.get(a) ?? []
        list.push(c)
        donorHydrogens.set(a, list)
      }
    }
  } else {
    // 无氢也要排除成键对
    for (let b = 0; b < bonds.count; b++) {
      bonded.add(bondKey(bonds.a[b], bonds.b[b]))
      bonded.add(bondKey(bonds.b[b], bonds.a[b]))
      pushNeighbor(neighbors, bonds.a[b], bonds.b[b])
      pushNeighbor(neighbors, bonds.b[b], bonds.a[b])
    }
  }
  /** 供体 → 1-3 共键邻居集合（懒构建缓存：仅对成为供体的原子计算） */
  const oneThreeCache = new Map<number, Set<number>>()
  const oneThreeOf = (d: number): Set<number> => {
    let set = oneThreeCache.get(d)
    if (!set) {
      set = new Set<number>()
      for (const p of neighbors.get(d) ?? []) {
        for (const q of neighbors.get(p) ?? []) {
          if (q !== d) set.add(q)
        }
      }
      oneThreeCache.set(d, set)
    }
    return set
  }

  const donors: number[] = []
  const acceptors: number[] = []
  for (let i = 0; i < n; i++) {
    if (!DONOR_ELEMS.has(atoms.elements[i]) && !ACCEPTOR_ELEMS.has(atoms.elements[i])) continue
    const water = isWaterRes(i)
    if (water && !includeWater) continue
    if (DONOR_ELEMS.has(atoms.elements[i]) && (!hasH || donorHydrogens.has(i))) donors.push(i)
    if (ACCEPTOR_ELEMS.has(atoms.elements[i])) acceptors.push(i)
  }
  void acceptors

  // 空间查询（半径 = 有氢 2.8 / 无氢 3.5，覆盖 H 与 D 的位置差）
  const radius = hasH ? maxHeavyDist + 1.2 : maxHeavyDist
  const pos = atoms.positions
  const seen = new Set<number>() // 去重 key（donor*n + acceptor）

  for (const d of donors) {
    const dx = pos[d * 3], dy = pos[d * 3 + 1], dz = pos[d * 3 + 2]
    const cand = structure.grid.queryRadius(dx, dy, dz, radius, pos)
    const hyds = donorHydrogens.get(d) ?? []
    for (const a of cand) {
      if (a === d || !isAcceptorAtom(a)) continue
      const aWater = isWaterRes(a)
      if (aWater && !includeWater) continue
      // 同残基排除
      if (structure.atomResidue[a] === structure.atomResidue[d]) continue
      // 直接成键排除（相邻残基的 N-H...O=C 肽键误报）
      if (bonded.has(bondKey(d, a))) continue
      // 1-3 共键邻居排除：共享成键原子的原子对（肽键 O=C-N 中 O…N ≈2.3Å）——
      // 共价几何约束而非氢键；旧版漏掉此排除导致每个肽键都被误报、整屏虚线
      if (oneThreeOf(d).has(a)) continue
      // 水-水排除（几乎无意义且量大）
      if (isWaterRes(d) && aWater) continue
      // 对称去重（同一对只算一次：按 donor<acceptor 记录）
      const key = d < a ? d * n + a : a * n + d
      if (seen.has(key)) continue

      if (hasH && hyds.length > 0) {
        // 找满足几何的最佳氢
        let best: HBond | null = null
        for (const h of hyds) {
          // H...A 距离
          const hax = pos[h * 3] - pos[a * 3]
          const hay = pos[h * 3 + 1] - pos[a * 3 + 1]
          const haz = pos[h * 3 + 2] - pos[a * 3 + 2]
          const ha = Math.sqrt(hax * hax + hay * hay + haz * haz)
          if (ha > maxDist) continue
          // D-H...A 角度（顶点 H）
          const hdx = pos[d * 3] - pos[h * 3]
          const hdy = pos[d * 3 + 1] - pos[h * 3 + 1]
          const hdz = pos[d * 3 + 2] - pos[h * 3 + 2]
          const hd = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz)
          const dot = -(hax * hdx + hay * hdy + haz * hdz) // HA 与 HD 反向
          const cosA = dot / (ha * hd)
          const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI
          if (ang < minAngle) continue
          const cand2: HBond = { donor: d, hydrogen: h, acceptor: a, dist: ha, angle: ang }
          if (!best || cand2.dist < best.dist) best = cand2
        }
        if (best) {
          seen.add(key)
          out.push(best)
        }
      } else {
        // 无氢：重原子距离判据
        const ddx = pos[a * 3] - dx
        const ddy = pos[a * 3 + 1] - dy
        const ddz = pos[a * 3 + 2] - dz
        const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        if (dist > maxHeavyDist) continue
        seen.add(key)
        out.push({ donor: d, hydrogen: -1, acceptor: a, dist, angle: 180 })
      }
    }
  }
  return out
}

function pushNeighbor(map: Map<number, number[]>, a: number, b: number) {
  const list = map.get(a)
  if (list) list.push(b)
  else map.set(a, [b])
}

/** 氢键统计摘要 */
export function hbondSummary(structure: StructureData, hbonds: HBond[]) {
  const byResidue = new Map<number, number>()
  let waterInvolved = 0
  for (const hb of hbonds) {
    const rd = structure.atomResidue[hb.donor]
    const ra = structure.atomResidue[hb.acceptor]
    byResidue.set(rd, (byResidue.get(rd) ?? 0) + 1)
    byResidue.set(ra, (byResidue.get(ra) ?? 0) + 1)
    if (structure.residues[rd].water || structure.residues[ra].water) waterInvolved++
  }
  return { total: hbonds.length, waterInvolved, residues: byResidue.size }
}

/** WATERS 重新导出避免未使用告警 */
export { WATERS }
