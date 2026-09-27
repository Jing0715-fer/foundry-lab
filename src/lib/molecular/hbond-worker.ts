// 氢键检测 Web Worker：大结构（≥ 2000 原子）异步计算，避免阻塞主线程与交互。
// 自包含实现（不导入主线程模块）：主线程把元素/水标志预编译为 Uint8 标志数组传入，
// worker 内部重建均匀空间网格后按与 detectHBonds 相同的判据计算。
// 判据：有氢结构 D-H…A（H…A ≤ maxDist 且角度 ≥ minAngle）；无氢结构 D…A ≤ maxHeavyDist。
// export {}：声明为 ES 模块，避免本文件顶层标识符泄漏进 TS 全局作用域（与其他 worker 冲突）
export {}

interface DetectPayload {
  type: 'detect'
  reqId: number
  structureId: string
  /** 检测缓存 key（maxDist|includeWater|rev）——结果原样带回供缓存比对 */
  key: string
  positions: Float32Array
  /** 1 = N/O/S（供体/受体候选） */
  heteroFlag: Uint8Array
  /** 1 = H/D */
  isHydrogen: Uint8Array
  atomResidue: Int32Array
  /** 残基是否水 */
  resWater: Uint8Array
  bondA: Int32Array
  bondB: Int32Array
  hasH: boolean
  maxDist: number
  maxHeavyDist: number
  minAngle: number
  includeWater: boolean
}

interface ResultMessage {
  type: 'result'
  reqId: number
  structureId: string
  key: string
  count: number
  /** [donor, hydrogen, acceptor] × count */
  triplets: Int32Array
  /** [dist, angle] × count */
  values: Float32Array
}

/** 均匀空间哈希网格（与主线程 SpatialGrid 同思路的自包含实现） */
class Grid {
  private cell: number
  private map = new Map<number, number[]>()
  private minIx = 0; private minIy = 0; private minIz = 0
  private maxIx = 0; private maxIy = 0; private maxIz = 0

  constructor(positions: Float32Array, count: number, cell = 6) {
    this.cell = cell
    if (count > 0) {
      this.minIx = this.maxIx = this.ix(positions[0])
      this.minIy = this.maxIy = this.ix(positions[1])
      this.minIz = this.maxIz = this.ix(positions[2])
    }
    for (let i = 0; i < count; i++) {
      const ix = this.ix(positions[i * 3]), iy = this.ix(positions[i * 3 + 1]), iz = this.ix(positions[i * 3 + 2])
      if (ix < this.minIx) this.minIx = ix; if (ix > this.maxIx) this.maxIx = ix
      if (iy < this.minIy) this.minIy = iy; if (iy > this.maxIy) this.maxIy = iy
      if (iz < this.minIz) this.minIz = iz; if (iz > this.maxIz) this.maxIz = iz
      const key = this.key(ix, iy, iz)
      let arr = this.map.get(key)
      if (!arr) { arr = []; this.map.set(key, arr) }
      arr.push(i)
    }
  }

  private ix(v: number) { return Math.floor(v / this.cell) + 2048 }
  private key(ix: number, iy: number, iz: number) { return (ix << 20) | (iy << 10) | iz }

  /** 半径 r 内的原子索引 */
  query(x: number, y: number, z: number, r: number): number[] {
    const out: number[] = []
    const cx = this.ix(x), cy = this.ix(y), cz = this.ix(z)
    const span = Math.ceil(r / this.cell)
    for (let ix = cx - span; ix <= cx + span; ix++) {
      if (ix < this.minIx - 1 || ix > this.maxIx + 1) continue
      for (let iy = cy - span; iy <= cy + span; iy++) {
        if (iy < this.minIy - 1 || iy > this.maxIy + 1) continue
        for (let iz = cz - span; iz <= cz + span; iz++) {
          if (iz < this.minIz - 1 || iz > this.maxIz + 1) continue
          const arr = this.map.get(this.key(ix, iy, iz))
          if (!arr) continue
          for (let k = 0; k < arr.length; k++) out.push(arr[k])
        }
      }
    }
    return out
  }
}

interface DetectResult {
  triplets: Int32Array
  values: Float32Array
  count: number
}

function detect(p: DetectPayload): DetectResult {
  const { positions, heteroFlag, isHydrogen, atomResidue, resWater, bondA, bondB, hasH } = p
  const n = heteroFlag.length
  const { maxDist, maxHeavyDist, minAngle, includeWater } = p
  const outD: number[] = [], outH: number[] = [], outA: number[] = []
  const outDist: number[] = [], outAng: number[] = []
  if (n === 0) return { triplets: new Int32Array(0), values: new Float32Array(0), count: 0 }

  const grid = new Grid(positions, n, 6)

  // 直接成键对（排除）+ 1-3 共键邻居（共享成键原子，如肽键 O=C-N 的 O…N ≈2.3Å——
  // 共价几何约束而非氢键）+ 供体重原子 → 结合氢
  const bonded = new Set<number>()
  const neighbors = new Map<number, number[]>()
  const pushNeighbor = (a: number, b: number) => {
    const list = neighbors.get(a)
    if (list) list.push(b)
    else neighbors.set(a, [b])
  }
  const donorHydrogens = new Map<number, number[]>()
  const nb = bondA.length
  for (let b = 0; b < nb; b++) {
    const a = bondA[b], c = bondB[b]
    bonded.add(a * n + c)
    bonded.add(c * n + a)
    pushNeighbor(a, c)
    pushNeighbor(c, a)
    if (hasH) {
      const aH = isHydrogen[a] === 1, cH = isHydrogen[c] === 1
      if (aH && !cH && heteroFlag[c] === 1) {
        const list = donorHydrogens.get(c) ?? []
        list.push(a)
        donorHydrogens.set(c, list)
      } else if (cH && !aH && heteroFlag[a] === 1) {
        const list = donorHydrogens.get(a) ?? []
        list.push(c)
        donorHydrogens.set(a, list)
      }
    }
  }
  /** 供体 → 1-3 共键邻居集合（懒构建缓存） */
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

  const isWaterRes = (i: number) => resWater[atomResidue[i]] === 1

  const donors: number[] = []
  for (let i = 0; i < n; i++) {
    if (heteroFlag[i] !== 1) continue
    if (isWaterRes(i) && !includeWater) continue
    if (!hasH || donorHydrogens.has(i)) donors.push(i)
  }

  const radius = hasH ? maxHeavyDist + 1.2 : maxHeavyDist
  const seen = new Set<number>() // donor*n+acceptor 对称去重

  for (const d of donors) {
    const dx = positions[d * 3], dy = positions[d * 3 + 1], dz = positions[d * 3 + 2]
    const cand = grid.query(dx, dy, dz, radius)
    const hyds = donorHydrogens.get(d) ?? []
    for (const a of cand) {
      if (a === d || heteroFlag[a] !== 1) continue
      const aWater = isWaterRes(a)
      if (aWater && !includeWater) continue
      if (atomResidue[a] === atomResidue[d]) continue
      if (bonded.has(d * n + a)) continue
      if (oneThreeOf(d).has(a)) continue // 1-3 共键邻居：共价几何约束非氢键（肽键 O…N）
      if (isWaterRes(d) && aWater) continue
      const key = d < a ? d * n + a : a * n + d
      if (seen.has(key)) continue

      if (hasH && hyds.length > 0) {
        let bestD = -1, bestH = -1, bestA = -1, bestDist = 0, bestAng = 0
        for (const h of hyds) {
          const hax = positions[h * 3] - positions[a * 3]
          const hay = positions[h * 3 + 1] - positions[a * 3 + 1]
          const haz = positions[h * 3 + 2] - positions[a * 3 + 2]
          const ha = Math.sqrt(hax * hax + hay * hay + haz * haz)
          if (ha > maxDist) continue
          const hdx = positions[d * 3] - positions[h * 3]
          const hdy = positions[d * 3 + 1] - positions[h * 3 + 1]
          const hdz = positions[d * 3 + 2] - positions[h * 3 + 2]
          const hd = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz)
          const dot = -(hax * hdx + hay * hdy + haz * hdz)
          const cosA = dot / (ha * hd)
          const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI
          if (ang < minAngle) continue
          if (bestD < 0 || ha < bestDist) { bestD = d; bestH = h; bestA = a; bestDist = ha; bestAng = ang }
        }
        if (bestD >= 0) {
          seen.add(key)
          outD.push(bestD); outH.push(bestH); outA.push(bestA)
          outDist.push(bestDist); outAng.push(bestAng)
        }
      } else {
        const ddx = positions[a * 3] - dx
        const ddy = positions[a * 3 + 1] - dy
        const ddz = positions[a * 3 + 2] - dz
        const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        if (dist > maxHeavyDist) continue
        seen.add(key)
        outD.push(d); outH.push(-1); outA.push(a)
        outDist.push(dist); outAng.push(180)
      }
    }
  }

  const count = outD.length
  const triplets = new Int32Array(count * 3)
  const values = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    triplets[i * 3] = outD[i]
    triplets[i * 3 + 1] = outH[i]
    triplets[i * 3 + 2] = outA[i]
    values[i * 2] = outDist[i]
    values[i * 2 + 1] = outAng[i]
  }
  return { triplets, values, count }
}

// worker 上下文（globalThis 转换避免 DOM/webworker lib 冲突）
const ctx = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<DetectPayload>) => void) | null
}

ctx.onmessage = (e: MessageEvent<DetectPayload>) => {
  const msg = e.data
  if (!msg || msg.type !== 'detect') return
  const { triplets, values, count } = detect(msg)
  const result: ResultMessage = {
    type: 'result',
    reqId: msg.reqId,
    structureId: msg.structureId,
    key: msg.key,
    count,
    triplets,
    values,
  }
  // 传输输出缓冲避免再次拷贝
  ctx.postMessage(result, [triplets.buffer, values.buffer])
}
