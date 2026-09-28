// SASA Web Worker：大结构（≥ 2200 原子）异步计算 Shrake–Rupley，避免阻塞主线程。
// 自包含实现（与 sasa.ts 同算法）：主线程预编译 vdW 半径与掩码传入。
// 支持两种计算：
//   kind='full'    完整结构 per-atom SASA
//   kind='buried'  界面 ΔSASA（A alone / B alone / A∪B 三路 → delta per-atom）
// export {}：声明为 ES 模块，避免本文件顶层标识符泄漏进 TS 全局作用域（与其他 worker 冲突）
export {}

interface ComputePayload {
  type: 'compute'
  reqId: number
  structureId: string
  /** 缓存 key（kind|probe|nPoints|rev） */
  key: string
  kind: 'full' | 'buried'
  positions: Float32Array
  /** vdW 半径（主线程编译） */
  radii: Float32Array
  /** 氢/氘标志（1 = 跳过） */
  isHydrogen: Uint8Array
  probe: number
  nPoints: number
  /** buried 专用：A/B 组原子掩码 */
  maskA?: Uint8Array
  maskB?: Uint8Array
}

interface ResultMessage {
  type: 'result'
  reqId: number
  structureId: string
  key: string
  kind: 'full' | 'buried'
  /** full：per-atom SASA */
  sasa?: Float32Array
  /** buried：per-atom ΔSASA（alone − complex） */
  delta?: Float32Array
  ms: number
}

// ---------- Fibonacci 球（缓存） ----------
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const sphereCache = new Map<number, Float32Array>()
function fibonacciSphere(n: number): Float32Array {
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

// ---------- 空间网格（与 hbond-worker 同构） ----------
class Grid {
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

/** 带掩码的 Shrake–Rupley（与主线程 computeSasaMasked 同判据） */
function computeMasked(
  positions: Float32Array,
  radii: Float32Array,
  count: number,
  activeMask: Uint8Array,
  occluderMask: Uint8Array,
  probe: number,
  nPoints: number,
): Float32Array {
  const out = new Float32Array(count)
  if (count === 0) return out
  const sphere = fibonacciSphere(nPoints)
  const grid = new Grid(positions, count, 6)
  let maxR = 0
  for (let i = 0; i < count; i++) {
    if (!occluderMask[i]) continue
    const r = radii[i] + probe
    if (r > maxR) maxR = r
  }
  for (let i = 0; i < count; i++) {
    if (!activeMask[i]) continue
    const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2]
    const rExt = radii[i] + probe
    const rExt2 = rExt * rExt
    const cand = grid.query(xi, yi, zi, rExt + maxR)
    const nb: number[] = []
    const nbSep2: number[] = []
    for (const j of cand) {
      if (j === i || !occluderMask[j]) continue
      const rj = radii[j] + probe
      const dx = positions[j * 3] - xi, dy = positions[j * 3 + 1] - yi, dz = positions[j * 3 + 2] - zi
      const d2 = dx * dx + dy * dy + dz * dz
      const sum = rExt + rj
      if (d2 > sum * sum) continue
      nb.push(j)
      nbSep2.push(rj * rj)
    }
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

function run(p: ComputePayload): ResultMessage {
  const t0 = performance.now()
  const { positions, radii, probe, nPoints, isHydrogen } = p
  const count = radii.length
  if (p.kind === 'full') {
    const active = new Uint8Array(count)
    for (let i = 0; i < count; i++) active[i] = isHydrogen[i] ? 0 : 1
    const sasa = computeMasked(positions, radii, count, active, active, probe, nPoints)
    return { type: 'result', reqId: p.reqId, structureId: p.structureId, key: p.key, kind: 'full', sasa, ms: performance.now() - t0 }
  }
  // buried：三路计算
  const maskA = p.maskA ?? new Uint8Array(count)
  const maskB = p.maskB ?? new Uint8Array(count)
  const a = new Uint8Array(count), b = new Uint8Array(count), ab = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const skip = isHydrogen[i] === 1
    a[i] = maskA[i] && !skip ? 1 : 0
    b[i] = maskB[i] && !skip ? 1 : 0
    ab[i] = a[i] || b[i]
  }
  const sasaA = computeMasked(positions, radii, count, a, a, probe, nPoints)
  const sasaB = computeMasked(positions, radii, count, b, b, probe, nPoints)
  const sasaAB = computeMasked(positions, radii, count, ab, ab, probe, nPoints)
  const delta = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    if (a[i]) {
      const d = sasaA[i] - sasaAB[i]
      if (d > 0) delta[i] = d
    } else if (b[i]) {
      const d = sasaB[i] - sasaAB[i]
      if (d > 0) delta[i] = d
    }
  }
  return { type: 'result', reqId: p.reqId, structureId: p.structureId, key: p.key, kind: 'buried', delta, ms: performance.now() - t0 }
}

const ctx = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<ComputePayload>) => void) | null
}

ctx.onmessage = (e: MessageEvent<ComputePayload>) => {
  const msg = e.data
  if (!msg || msg.type !== 'compute') return
  const result = run(msg)
  const transfer: Transferable[] = []
  if (result.sasa) transfer.push(result.sasa.buffer)
  if (result.delta) transfer.push(result.delta.buffer)
  ctx.postMessage(result, transfer)
}
