// 表示法构建器：spacefill/ballstick/sticks/lines/cartoon/surface
import * as THREE from 'three'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'
import { elementInfo } from './chemistry'
import type { StructureData } from './parser'
import type { RepConfig } from './types'

export interface Pickable {
  mesh: THREE.Object3D
  kind: 'spheres' | 'cylinders' | 'lines' | 'cartoon' | 'surface'
  /** instanceId → atomIdx（instanced mesh 用） */
  atomMap?: Int32Array
  /** LineSegments: vertexIndex → atomIdx */
  lineAtomMap?: Int32Array
  /** cartoon: aResIndex 属性名 */
  resAttr?: string
}

export interface RepBuild {
  group: THREE.Group
  pickables: Pickable[]
  dispose: () => void
}

export interface BuildOptions {
  quality: 'low' | 'medium' | 'high'
  /** 颜色覆盖应用到 colors 之后（由 engine 完成） */
}

const UP = new THREE.Vector3(0, 1, 0)

function sphereSegments(count: number, quality: 'low' | 'medium' | 'high'): [number, number] {
  if (quality === 'low') return count > 30000 ? [8, 6] : [12, 8]
  if (quality === 'medium') return count > 30000 ? [10, 8] : count > 8000 ? [14, 10] : [18, 12]
  return count > 60000 ? [10, 8] : count > 20000 ? [14, 10] : count > 5000 ? [20, 14] : [28, 20]
}

/** 球体表示（spacefill 用 vdw 全径，ball&stick 用固定小球） */
export function buildSpheres(
  structure: StructureData,
  atomIdx: number[],
  colors: Float32Array,
  radiusMode: 'vdw' | 'fixed',
  radiusScale: number,
  opts: BuildOptions,
): RepBuild {
  const [ws, hs] = sphereSegments(atomIdx.length, opts.quality)
  const geo = new THREE.SphereGeometry(1, ws, hs)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.02, envMapIntensity: 0.9 })
  const mesh = new THREE.InstancedMesh(geo, mat, atomIdx.length)
  const m = new THREE.Matrix4()
  const pos = structure.atoms.positions
  const atomMap = new Int32Array(atomIdx.length)
  for (let k = 0; k < atomIdx.length; k++) {
    const i = atomIdx[k]
    const r = radiusMode === 'vdw' ? elementInfo(structure.atoms.elements[i]).vdw * radiusScale : radiusScale
    m.makeScale(r, r, r)
    m.setPosition(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
    mesh.setMatrixAt(k, m)
    mesh.setColorAt(k, new THREE.Color(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]))
    atomMap[k] = i
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  const group = new THREE.Group()
  group.add(mesh)
  return {
    group,
    pickables: [{ mesh, kind: 'spheres', atomMap }],
    dispose: () => { geo.dispose(); mat.dispose(); mesh.dispose() },
  }
}

/** 键表示（sticks / ballstick 的棍部分，含半键着色） */
export function buildSticks(
  structure: StructureData,
  atomMask: Uint8Array,
  atomCount: number,
  colors: Float32Array,
  stickRadius: number,
  opts: BuildOptions,
): RepBuild {
  const bonds = structure.bonds
  // 找出两端都在 mask 内的键
  const pairA: number[] = []
  const pairB: number[] = []
  for (let b = 0; b < bonds.count; b++) {
    const a = bonds.a[b], c = bonds.b[b]
    if (atomMask[a] && atomMask[c]) { pairA.push(a); pairB.push(c) }
  }
  const segs = pairA.length * 2
  const radial = opts.quality === 'low' ? 6 : opts.quality === 'medium' ? 10 : 14
  const geo = new THREE.CylinderGeometry(1, 1, 1, radial, 1, true)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.02, envMapIntensity: 0.85 })
  const group = new THREE.Group()
  const pickables: Pickable[] = []
  const pos = structure.atoms.positions
  if (segs > 0) {
    const mesh = new THREE.InstancedMesh(geo, mat, segs)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const dir = new THREE.Vector3()
    const mid = new THREE.Vector3()
    const aPos = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const atomMap = new Int32Array(segs)
    let k = 0
    for (let b = 0; b < pairA.length; b++) {
      const ai = pairA[b], bi = pairB[b]
      aPos.set(pos[ai * 3], pos[ai * 3 + 1], pos[ai * 3 + 2])
      mid.set(
        (pos[ai * 3] + pos[bi * 3]) / 2,
        (pos[ai * 3 + 1] + pos[bi * 3 + 1]) / 2,
        (pos[ai * 3 + 2] + pos[bi * 3 + 2]) / 2,
      )
      // 两半段
      for (const [atomI, from, to] of [
        [ai, aPos, mid] as const,
        [bi, mid.clone(), new THREE.Vector3(pos[bi * 3], pos[bi * 3 + 1], pos[bi * 3 + 2])] as const,
      ]) {
        dir.subVectors(to, from)
        const len = dir.length()
        if (len < 1e-6) continue
        dir.normalize()
        q.setFromUnitVectors(UP, dir)
        scale.set(stickRadius, len, stickRadius)
        m.compose(from.clone().addScaledVector(dir, len / 2), q, scale)
        mesh.setMatrixAt(k, m)
        mesh.setColorAt(k, new THREE.Color(colors[atomI * 3], colors[atomI * 3 + 1], colors[atomI * 3 + 2]))
        atomMap[k] = atomI
        k++
      }
    }
    mesh.count = k
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
    pickables.push({ mesh, kind: 'cylinders', atomMap })
  }
  return {
    group,
    pickables,
    dispose: () => { geo.dispose(); mat.dispose(); group.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose?.() }) },
  }
}

/** 线框 */
export function buildLines(
  structure: StructureData,
  atomMask: Uint8Array,
  colors: Float32Array,
): RepBuild {
  const bonds = structure.bonds
  const pos = structure.atoms.positions
  const verts: number[] = []
  const cols: number[] = []
  const lineAtomMap: number[] = []
  for (let b = 0; b < bonds.count; b++) {
    const a = bonds.a[b], c = bonds.b[b]
    if (!atomMask[a] || !atomMask[c]) continue
    verts.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2])
    cols.push(colors[a * 3], colors[a * 3 + 1], colors[a * 3 + 2])
    verts.push(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2])
    cols.push(colors[c * 3], colors[c * 3 + 1], colors[c * 3 + 2])
    lineAtomMap.push(a, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
  const mat = new THREE.LineBasicMaterial({ vertexColors: true })
  const lines = new THREE.LineSegments(geo, mat)
  const group = new THREE.Group()
  group.add(lines)
  return {
    group,
    pickables: [{ mesh: lines, kind: 'lines', lineAtomMap: Int32Array.from(lineAtomMap) }],
    dispose: () => { geo.dispose(); mat.dispose() },
  }
}

// ---------- Cartoon ----------

interface ResidueCA {
  resIdx: number
  ca: number   // CA 原子索引
  o: number    // O 原子索引（可能 -1）
  c: number    // C 原子索引（可能 -1）
  b: number    // CA 原子 B 因子（putty 管径用）
  color: [number, number, number]
}

/** putty 模式额外参数 */
export interface CartoonExtras {
  /** putty：B 因子管径映射（截面圆，半径随 B 增大） */
  putty?: boolean
  /** putty：B 上限（Å²，0=自动用实际最大值；超出钳制） */
  puttyRange?: number
}

export function buildCartoon(
  structure: StructureData,
  atomMask: Uint8Array,
  colors: Float32Array,
  widthScale: number,
  opts: BuildOptions,
  extras: CartoonExtras = {},
): RepBuild {
  const group = new THREE.Group()
  const pickables: Pickable[] = []
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  const atoms = structure.atoms

  // putty：全结构 B 范围（蛋白 CA + 核酸 P，跨链一致半径语义；上限可用 puttyRange 钳制）
  let bRange: { min: number; max: number } | null = null
  if (extras.putty) {
    let bmin = Infinity, bmax = -Infinity
    let seen = 0
    for (const chain of structure.chains) {
      if (chain.type !== 'protein' && chain.type !== 'nucleic') continue
      const guideName = chain.type === 'protein' ? 'CA' : 'P'
      for (const ri of chain.residueIdx) {
        const r = structure.residues[ri]
        for (let i = r.start; i < r.end; i++) {
          if (!atomMask[i] || atoms.names[i] !== guideName) continue
          const b = atoms.bfactors[i]
          if (!Number.isFinite(b)) continue
          if (b < bmin) bmin = b
          if (b > bmax) bmax = b
          seen++
        }
      }
    }
    if (seen >= 2 && bmax > bmin) {
      const cap = extras.puttyRange && extras.puttyRange > bmin ? extras.puttyRange : bmax
      bRange = { min: bmin, max: Math.max(cap, bmin + 1e-6) }
    }
  }

  for (const chain of structure.chains) {
    if (chain.type === 'nucleic') {
      buildNucleicTube(structure, chain, atomMask, colors, widthScale, group, pickables, disposables, extras.putty === true, bRange)
      continue
    }
    if (chain.type !== 'protein') continue
    // 收集带 CA 且在 mask 中的残基
    const list: ResidueCA[] = []
    for (const ri of chain.residueIdx) {
      const r = structure.residues[ri]
      let ca = -1, o = -1, c = -1
      for (let i = r.start; i < r.end; i++) {
        if (!atomMask[i]) continue
        const nm = atoms.names[i]
        if (nm === 'CA' && ca < 0) ca = i
        else if (nm === 'O' && o < 0) o = i
        else if (nm === 'C' && c < 0) c = i
      }
      if (ca >= 0) {
        const b = atoms.bfactors[ca]
        list.push({
          resIdx: ri, ca, o, c,
          b: Number.isFinite(b) ? b : 0,
          color: [colors[ca * 3], colors[ca * 3 + 1], colors[ca * 3 + 2]],
        })
      }
    }
    if (list.length === 0) continue
    // 分段（CA-CA 距离 > 4.7 视为断链）
    const segments: ResidueCA[][] = []
    let seg: ResidueCA[] = [list[0]]
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].ca, b = list[i].ca
      const d = Math.hypot(
        atoms.positions[a * 3] - atoms.positions[b * 3],
        atoms.positions[a * 3 + 1] - atoms.positions[b * 3 + 1],
        atoms.positions[a * 3 + 2] - atoms.positions[b * 3 + 2],
      )
      if (d > 4.7) { segments.push(seg); seg = [list[i]] }
      else seg.push(list[i])
    }
    segments.push(seg)
    for (const s of segments) buildRibbonSegment(structure, s, widthScale, group, pickables, disposables, extras.putty === true, bRange)
  }
  return {
    group,
    pickables,
    dispose: () => { for (const d of disposables) d.dispose() },
  }
}

function buildRibbonSegment(
  structure: StructureData,
  list: ResidueCA[],
  widthScale: number,
  group: THREE.Group,
  pickables: Pickable[],
  disposables: (THREE.BufferGeometry | THREE.Material)[],
  putty: boolean = false,
  bRange: { min: number; max: number } | null = null,
) {
  const atoms = structure.atoms
  const n = list.length
  if (n === 1) {
    // 单残基：小球标记（putty 下半径随 B）
    const ca = list[0].ca
    let r = 0.6 * widthScale
    if (putty && bRange) {
      const span = Math.max(1e-6, bRange.max - bRange.min)
      const t = Math.sqrt(Math.min(1, Math.max(0, (list[0].b - bRange.min) / span)))
      r = (0.2 + 0.85 * t) * widthScale
    }
    const geo = new THREE.SphereGeometry(r, 16, 12)
    const col = list[0].color
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(col[0], col[1], col[2]), roughness: 0.5 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(atoms.positions[ca * 3], atoms.positions[ca * 3 + 1], atoms.positions[ca * 3 + 2])
    group.add(mesh)
    disposables.push(geo, mat)
    return
  }

  // ---- 采样点 ----
  const ctrl = list.map(r => new THREE.Vector3(
    atoms.positions[r.ca * 3], atoms.positions[r.ca * 3 + 1], atoms.positions[r.ca * 3 + 2],
  ))
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal', 0.5)
  const samplesPer = n < 8 ? 8 : 4
  const S = (n - 1) * samplesPer + 1
  const samplePos: THREE.Vector3[] = []
  for (let k = 0; k < S; k++) samplePos.push(curve.getPoint(k / (S - 1)))

  // ---- 切向 ----
  const T: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const prev = ctrl[Math.max(0, i - 1)]
    const next = ctrl[Math.min(n - 1, i + 1)]
    T.push(new THREE.Vector3().subVectors(next, prev).normalize())
  }

  // ---- 肽平面方向 U（宽方向） ----
  const U: THREE.Vector3[] = []
  let lastU: THREE.Vector3 | null = null
  for (let i = 0; i < n; i++) {
    const caPos = ctrl[i]
    const ref = list[i].o >= 0 ? list[i].o : list[i].c
    let u: THREE.Vector3
    if (ref >= 0) {
      const v = new THREE.Vector3(
        atoms.positions[ref * 3] - caPos.x,
        atoms.positions[ref * 3 + 1] - caPos.y,
        atoms.positions[ref * 3 + 2] - caPos.z,
      )
      u = v.sub(T[i].clone().multiplyScalar(v.dot(T[i])))
      if (u.lengthSq() < 0.01) u = lastU ? lastU.clone() : new THREE.Vector3(0, 0, 1)
    } else {
      u = lastU ? lastU.clone() : new THREE.Vector3(0, 0, 1)
    }
    u.normalize()
    // 与前一方向保持连续（避免翻转）
    if (lastU && u.dot(lastU) < 0) u.negate()
    lastU = u
    U.push(u)
  }
  // 平滑 U
  const Us = U.map((_, i) => {
    const avg = new THREE.Vector3()
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) avg.add(U[k])
    avg.normalize()
    return avg
  })

  // ---- 截面参数（宽/厚/指数）----
  // putty：B 因子 → 圆截面半径（sqrt 映射：柔性区粗、刚性区细；无箭头锥化）
  const wArr: number[] = [], tArr: number[] = [], pArr: number[] = []
  if (putty && bRange) {
    const span = Math.max(1e-6, bRange.max - bRange.min)
    const rMin = 0.2 * widthScale
    const rMax = 1.05 * widthScale
    for (let i = 0; i < n; i++) {
      const t = Math.sqrt(Math.min(1, Math.max(0, (list[i].b - bRange.min) / span)))
      const r = rMin + (rMax - rMin) * t
      wArr.push(2 * r); tArr.push(2 * r); pArr.push(2) // p=2 → 正圆截面
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ss = structure.residues[list[i].resIdx].ss
      if (ss === 'H') { wArr.push(2.15 * widthScale); tArr.push(0.42 * widthScale); pArr.push(3.6) }
      else if (ss === 'E') { wArr.push(2.55 * widthScale); tArr.push(0.34 * widthScale); pArr.push(6) }
      else { wArr.push(0.68 * widthScale); tArr.push(0.68 * widthScale); pArr.push(2.2) }
    }
  }
  // 平滑（窗口1；putty 管径再过一遍使过渡更顺）
  const smooth = (arr: number[]) => arr.map((_, i) => {
    const a = arr[Math.max(0, i - 1)], b = arr[i], c = arr[Math.min(n - 1, i + 1)]
    return (a + b + c) / 3
  })
  const wS = putty ? smooth(smooth(wArr)) : smooth(wArr)
  const tS = putty ? smooth(smooth(tArr)) : smooth(tArr)
  const pS = smooth(pArr)

  // ---- β 折叠箭头锥化：每个 sheet 段的最后一个残基（putty 圆管不需要）----
  const taper = new Float32Array(n).fill(1)
  if (!putty) {
    for (let i = 0; i < n; i++) {
      const ss = structure.residues[list[i].resIdx].ss
      if (ss !== 'E') continue
      const nextSs = i + 1 < n ? structure.residues[list[i + 1].resIdx].ss : 'L'
      if (nextSs !== 'E') {
        // i 是 strand 末端 → 在 i..i+1 区间锥化（覆盖到 loop 起始处）
        taper[i] = 1
        if (i + 1 < n) taper[i + 1] = 0.18
      }
    }
  }

  // ---- 网格 ----
  const K = 10
  const vertCount = S * K + 2
  const positions = new Float32Array(vertCount * 3)
  const vertColors = new Float32Array(vertCount * 3)
  const aRes = new Float32Array(vertCount)
  const indices: number[] = []
  const cA = new THREE.Color(), cB = new THREE.Color()
  const tangent = new THREE.Vector3(), uDir = new THREE.Vector3(), nDir = new THREE.Vector3()

  for (let k = 0; k < S; k++) {
    const f = k / samplesPer
    const i0 = Math.min(n - 1, Math.floor(f))
    const i1 = Math.min(n - 1, i0 + 1)
    const frac = f - i0
    tangent.copy(T[i0]).lerp(T[i1], frac).normalize()
    uDir.copy(Us[i0]).lerp(Us[i1], frac)
    uDir.sub(tangent.clone().multiplyScalar(uDir.dot(tangent)))
    if (uDir.lengthSq() < 1e-6) uDir.set(0, 0, 1)
    uDir.normalize()
    nDir.crossVectors(tangent, uDir).normalize()
    // 截面参数插值 + 锥化
    let w = wS[i0] + (wS[i1] - wS[i0]) * frac
    const t = tS[i0] + (tS[i1] - tS[i0]) * frac
    const p = pS[i0] + (pS[i1] - pS[i0]) * frac
    const tp = taper[i0] + (Math.min(n - 1, i0 + 1) < n ? taper[Math.min(n - 1, i0 + 1)] - taper[i0] : 0) * frac
    w *= Math.max(0.12, tp)
    // 颜色插值
    cA.setRGB(list[i0].color[0], list[i0].color[1], list[i0].color[2])
    cB.setRGB(list[i1].color[0], list[i1].color[1], list[i1].color[2])
    cA.lerp(cB, frac)
    const resIdx = frac > 0.5 ? list[i1].resIdx : list[i0].resIdx

    const center = samplePos[k]
    for (let a = 0; a < K; a++) {
      const ang = (a / K) * Math.PI * 2
      const ca = Math.cos(ang), sa = Math.sin(ang)
      const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / p) * w / 2
      const ey = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / p) * t / 2
      const vi = k * K + a
      positions[vi * 3] = center.x + uDir.x * ex + nDir.x * ey
      positions[vi * 3 + 1] = center.y + uDir.y * ex + nDir.y * ey
      positions[vi * 3 + 2] = center.z + uDir.z * ex + nDir.z * ey
      vertColors[vi * 3] = cA.r; vertColors[vi * 3 + 1] = cA.g; vertColors[vi * 3 + 2] = cA.b
      aRes[vi] = resIdx
    }
  }
  // 索引
  for (let k = 0; k < S - 1; k++) {
    for (let a = 0; a < K; a++) {
      const a0 = k * K + a
      const a1 = k * K + (a + 1) % K
      const b0 = (k + 1) * K + a
      const b1 = (k + 1) * K + (a + 1) % K
      indices.push(a0, b0, b1, a0, b1, a1)
    }
  }
  // 端帽
  const capA = S * K, capB = S * K + 1
  positions[capA * 3] = samplePos[0].x; positions[capA * 3 + 1] = samplePos[0].y; positions[capA * 3 + 2] = samplePos[0].z
  positions[capB * 3] = samplePos[S - 1].x; positions[capB * 3 + 1] = samplePos[S - 1].y; positions[capB * 3 + 2] = samplePos[S - 1].z
  vertColors[capA * 3] = list[0].color[0]; vertColors[capA * 3 + 1] = list[0].color[1]; vertColors[capA * 3 + 2] = list[0].color[2]
  const lastC = list[n - 1].color
  vertColors[capB * 3] = lastC[0]; vertColors[capB * 3 + 1] = lastC[1]; vertColors[capB * 3 + 2] = lastC[2]
  aRes[capA] = list[0].resIdx; aRes[capB] = list[n - 1].resIdx
  for (let a = 0; a < K; a++) {
    indices.push(capA, (a + 1) % K, a)
    indices.push(capB, (S - 1) * K + a, (S - 1) * K + (a + 1) % K)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(vertColors, 3))
  geo.setAttribute('aResIndex', new THREE.BufferAttribute(aRes, 1))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0.02, envMapIntensity: 0.7, side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  group.add(mesh)
  disposables.push(geo, mat)
  pickables.push({ mesh, kind: 'cartoon', resAttr: 'aResIndex' })
}

function buildNucleicTube(
  structure: StructureData,
  chain: { residueIdx: number[]; type: string },
  atomMask: Uint8Array,
  colors: Float32Array,
  widthScale: number,
  group: THREE.Group,
  pickables: Pickable[],
  disposables: (THREE.BufferGeometry | THREE.Material)[],
  putty: boolean = false,
  bRange: { min: number; max: number } | null = null,
) {
  const atoms = structure.atoms
  const pts: THREE.Vector3[] = []
  const cols: [number, number, number][] = []
  const resIdxs: number[] = []
  const bs: number[] = []
  for (const ri of chain.residueIdx) {
    const r = structure.residues[ri]
    let p = -1
    for (let i = r.start; i < r.end; i++) {
      if (atomMask[i] && atoms.names[i] === 'P') { p = i; break }
    }
    if (p < 0) continue
    pts.push(new THREE.Vector3(atoms.positions[p * 3], atoms.positions[p * 3 + 1], atoms.positions[p * 3 + 2]))
    cols.push([colors[p * 3], colors[p * 3 + 1], colors[p * 3 + 2]])
    resIdxs.push(ri)
    const b = atoms.bfactors[p]
    bs.push(Number.isFinite(b) ? b : 0)
  }
  if (pts.length < 2) return
  // 分段（P-P > 8 视为断开）
  const segments: { pts: THREE.Vector3[]; cols: [number, number, number][]; resIdxs: number[]; bs: number[] }[] = []
  let cur = { pts: [pts[0]], cols: [cols[0]], resIdxs: [resIdxs[0]], bs: [bs[0]] }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].distanceTo(pts[i - 1]) > 8) {
      segments.push(cur)
      cur = { pts: [pts[i]], cols: [cols[i]], resIdxs: [resIdxs[i]], bs: [bs[i]] }
    } else {
      cur.pts.push(pts[i]); cur.cols.push(cols[i]); cur.resIdxs.push(resIdxs[i]); cur.bs.push(bs[i])
    }
  }
  segments.push(cur)
  for (const seg of segments) {
    if (seg.pts.length < 2) continue
    // putty：B 因子 → 变半径圆管（与蛋白 putty 同款 sqrt 映射；平行传输框架防扭转）
    if (putty && bRange) {
      buildNucleicPuttySegment(seg, widthScale, bRange, group, pickables, disposables)
      continue
    }
    const curve = new THREE.CatmullRomCurve3(seg.pts, false, 'centripetal', 0.5)
    const tubular = Math.max(16, seg.pts.length * 8)
    const geo = new THREE.TubeGeometry(curve, tubular, 0.45 * widthScale, 10, false)
    // 逐顶点着色 + aResIndex
    const vertCount = geo.attributes.position.count
    const vertColors = new Float32Array(vertCount * 3)
    const aRes = new Float32Array(vertCount)
    const radial = 11 // radialSegments+1
    for (let v = 0; v < vertCount; v++) {
      const tSeg = Math.floor(v / radial) / tubular
      const fi = tSeg * (seg.resIdxs.length - 1)
      const i0 = Math.min(seg.resIdxs.length - 1, Math.floor(fi))
      const i1 = Math.min(seg.resIdxs.length - 1, i0 + 1)
      const fr = fi - i0
      const c0 = seg.cols[i0], c1 = seg.cols[i1]
      vertColors[v * 3] = c0[0] + (c1[0] - c0[0]) * fr
      vertColors[v * 3 + 1] = c0[1] + (c1[1] - c0[1]) * fr
      vertColors[v * 3 + 2] = c0[2] + (c1[2] - c0[2]) * fr
      aRes[v] = fr > 0.5 ? seg.resIdxs[i1] : seg.resIdxs[i0]
    }
    geo.setAttribute('color', new THREE.BufferAttribute(vertColors, 3))
    geo.setAttribute('aResIndex', new THREE.BufferAttribute(aRes, 1))
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.5, metalness: 0.02, envMapIntensity: 0.7,
    })
    const mesh = new THREE.Mesh(geo, mat)
    group.add(mesh)
    disposables.push(geo, mat)
    pickables.push({ mesh, kind: 'cartoon', resAttr: 'aResIndex' })
  }
}

/** 核酸 putty 管段：磷酸骨架曲线上的变半径圆管（B 因子 sqrt 映射，与蛋白 putty 视觉一致） */
function buildNucleicPuttySegment(
  seg: { pts: THREE.Vector3[]; cols: [number, number, number][]; resIdxs: number[]; bs: number[] },
  widthScale: number,
  bRange: { min: number; max: number },
  group: THREE.Group,
  pickables: Pickable[],
  disposables: (THREE.BufferGeometry | THREE.Material)[],
) {
  const n = seg.pts.length
  // 半径映射 + 双重平滑（窗口 1，与蛋白 putty 相同）
  const span = Math.max(1e-6, bRange.max - bRange.min)
  const rMin = 0.2 * widthScale
  const rMax = 1.05 * widthScale
  const rArr = seg.bs.map(b => rMin + (rMax - rMin) * Math.sqrt(Math.min(1, Math.max(0, (b - bRange.min) / span))))
  const smooth = (arr: number[]) => arr.map((_, i) => {
    const a = arr[Math.max(0, i - 1)], b = arr[i], c = arr[Math.min(n - 1, i + 1)]
    return (a + b + c) / 3
  })
  const rS = smooth(smooth(rArr))

  // 骨架采样曲线
  const curve = new THREE.CatmullRomCurve3(seg.pts, false, 'centripetal', 0.5)
  const samplesPer = 8
  const S = (n - 1) * samplesPer + 1
  const samplePos: THREE.Vector3[] = []
  for (let k = 0; k < S; k++) samplePos.push(curve.getPoint(k / (S - 1)))

  // 平行传输框架：法向沿曲线逐点投影到切平面（无肽平面参考方向 → 传输防扭转）
  const tangents: THREE.Vector3[] = []
  for (let k = 0; k < S; k++) {
    const prev = samplePos[Math.max(0, k - 1)]
    const next = samplePos[Math.min(S - 1, k + 1)]
    tangents.push(new THREE.Vector3().subVectors(next, prev).normalize())
  }
  const normals: THREE.Vector3[] = []
  let curN = new THREE.Vector3(0, 1, 0)
  if (Math.abs(tangents[0].y) > 0.9) curN.set(1, 0, 0)
  curN.sub(tangents[0].clone().multiplyScalar(curN.dot(tangents[0]))).normalize()
  for (let k = 0; k < S; k++) {
    const t = tangents[k]
    curN.sub(t.clone().multiplyScalar(curN.dot(t)))
    if (curN.lengthSq() < 1e-6) {
      // 切向与法向平行（数值退化）：换一个最不平行的坐标轴
      curN.set(Math.abs(t.x) < 0.9 ? 1 : 0, Math.abs(t.y) < 0.9 ? 1 : 0, Math.abs(t.z) < 0.9 ? 1 : 0)
      curN.sub(t.clone().multiplyScalar(curN.dot(t)))
    }
    curN.normalize()
    normals.push(curN.clone())
  }

  // 网格（K 环向分段 + 两端帽）
  const K = 10
  const vertCount = S * K + 2
  const positions = new Float32Array(vertCount * 3)
  const vertColors = new Float32Array(vertCount * 3)
  const aRes = new Float32Array(vertCount)
  const indices: number[] = []
  const binormal = new THREE.Vector3()

  for (let k = 0; k < S; k++) {
    const f = k / samplesPer
    const i0 = Math.min(n - 1, Math.floor(f))
    const i1 = Math.min(n - 1, i0 + 1)
    const frac = f - i0
    const r = rS[i0] + (rS[i1] - rS[i0]) * frac
    binormal.crossVectors(tangents[k], normals[k]).normalize()
    const c0 = seg.cols[i0], c1 = seg.cols[i1]
    const resIdx = frac > 0.5 ? seg.resIdxs[i1] : seg.resIdxs[i0]
    const center = samplePos[k]
    for (let a = 0; a < K; a++) {
      const ang = (a / K) * Math.PI * 2
      const ex = Math.cos(ang) * r
      const ey = Math.sin(ang) * r
      const vi = k * K + a
      positions[vi * 3] = center.x + normals[k].x * ex + binormal.x * ey
      positions[vi * 3 + 1] = center.y + normals[k].y * ex + binormal.y * ey
      positions[vi * 3 + 2] = center.z + normals[k].z * ex + binormal.z * ey
      vertColors[vi * 3] = c0[0] + (c1[0] - c0[0]) * frac
      vertColors[vi * 3 + 1] = c0[1] + (c1[1] - c0[1]) * frac
      vertColors[vi * 3 + 2] = c0[2] + (c1[2] - c0[2]) * frac
      aRes[vi] = resIdx
    }
  }
  for (let k = 0; k < S - 1; k++) {
    for (let a = 0; a < K; a++) {
      const a0 = k * K + a
      const a1 = k * K + (a + 1) % K
      const b0 = (k + 1) * K + a
      const b1 = (k + 1) * K + (a + 1) % K
      indices.push(a0, b0, b1, a0, b1, a1)
    }
  }
  // 端帽
  const capA = S * K, capB = S * K + 1
  positions[capA * 3] = samplePos[0].x; positions[capA * 3 + 1] = samplePos[0].y; positions[capA * 3 + 2] = samplePos[0].z
  positions[capB * 3] = samplePos[S - 1].x; positions[capB * 3 + 1] = samplePos[S - 1].y; positions[capB * 3 + 2] = samplePos[S - 1].z
  const firstC = seg.cols[0], lastC = seg.cols[n - 1]
  vertColors[capA * 3] = firstC[0]; vertColors[capA * 3 + 1] = firstC[1]; vertColors[capA * 3 + 2] = firstC[2]
  vertColors[capB * 3] = lastC[0]; vertColors[capB * 3 + 1] = lastC[1]; vertColors[capB * 3 + 2] = lastC[2]
  aRes[capA] = seg.resIdxs[0]; aRes[capB] = seg.resIdxs[n - 1]
  for (let a = 0; a < K; a++) {
    indices.push(capA, (a + 1) % K, a)
    indices.push(capB, (S - 1) * K + a, (S - 1) * K + (a + 1) % K)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(vertColors, 3))
  geo.setAttribute('aResIndex', new THREE.BufferAttribute(aRes, 1))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0.02, envMapIntensity: 0.7, side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  group.add(mesh)
  disposables.push(geo, mat)
  pickables.push({ mesh, kind: 'cartoon', resAttr: 'aResIndex' })
}

// ---------- 分子表面（metaball 高斯面） ----------

export function buildSurface(
  structure: StructureData,
  atomIdx: number[],
  colors: Float32Array,
  rep: RepConfig,
): RepBuild {
  const group = new THREE.Group()
  const n = atomIdx.length
  if (n === 0) return { group, pickables: [], dispose: () => {} }
  const pos = structure.atoms.positions
  // 包围盒（含边缘）
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let maxR = 0
  const radii = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const i = atomIdx[k]
    const r = elementInfo(structure.atoms.elements[i]).vdw + rep.probe
    radii[k] = r
    if (r > maxR) maxR = r
    for (let d = 0; d < 3; d++) {
      const v = pos[i * 3 + d]
      if (v - r < min[d]) min[d] = v - r
      if (v + r > max[d]) max[d] = v + r
    }
  }
  const margin = maxR + 2
  for (let d = 0; d < 3; d++) { min[d] -= margin; max[d] += margin }
  const L = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  const resolution = n <= 2000 ? 120 : n <= 6000 ? 100 : n <= 15000 ? 84 : 64
  const isolation = 80
  const subtract = 12
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.0,
    envMapIntensity: 0.8,
    transparent: rep.opacity < 0.999,
    opacity: rep.opacity,
    depthWrite: rep.opacity >= 0.999,
    side: THREE.DoubleSide,
  })
  const mc = new MarchingCubes(resolution, material, false, true, 400000)
  mc.scale.set(L, L, L)
  mc.position.set(min[0], min[1], min[2])
  mc.isolation = isolation
  const col = new THREE.Color()
  for (let k = 0; k < n; k++) {
    const i = atomIdx[k]
    const nx = (pos[i * 3] - min[0]) / L
    const ny = (pos[i * 3 + 1] - min[1]) / L
    const nz = (pos[i * 3 + 2] - min[2]) / L
    const strength = (radii[k] / L) ** 2 * (isolation + subtract)
    col.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2])
    mc.addBall(nx, ny, nz, strength, subtract, col)
  }
  mc.update()
  group.add(mc)
  return {
    group,
    pickables: [{ mesh: mc, kind: 'surface' }],
    dispose: () => {
      material.dispose()
      mc.geometry?.dispose()
    },
  }
}
