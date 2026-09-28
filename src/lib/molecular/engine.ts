// MolEngine：Three.js 渲染引擎（场景/相机/拾取/高亮/测量/标签/裁剪/截图/GTAO 遮蔽）
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { EdgeShader, srgbComponents } from './edge-shader'
import { usePerfStore } from './perf-store'
import { useViewportStore } from './viewport-store'
import { AnaglyphEffect } from 'three/examples/jsm/effects/AnaglyphEffect.js'
import { marchingCubes } from './marching-cubes'
import { mateTransforms, orthoMatrix, symOpsFor, type CrystalCell } from './symmetry'
import { computeAtomColors, invalidatePocketField } from './colors'
import { elementInfo } from './chemistry'
import {
  buildCartoon, buildLines, buildSpheres, buildSticks, buildSurface,
  type Pickable, type RepBuild,
} from './representations'
import { SpatialGrid, type StructureData } from './parser'
import { evaluateSelection } from './selection'
import { detectHBonds, type HBond } from './hbonds'
import { contactColor } from './contacts'
import { useContactStore } from './contacts-store'
import { usePoreStore } from './pore-store'
import { poreZoneColor, principalAxis } from './pore'
import { superposeStructures, applyRigidTransform, recomputeBbox, type SuperposeResult } from './superpose'
import {
  computeSasa, computeBuriedSasa, computeBuriedSasaArrays, sasaStats, compileRadii,
  type SasaComputeOptions, type SasaStats, type BuriedSasaResult,
} from './sasa'
import { useSasaStore } from './sasa-store'
import { useHBondStore, type HBondPairSummary } from './hbond-store'
import { useEnsembleStore } from './ensemble-store'
import { makeTextSprite, disposeSprite } from './textsprite'
import { useMolStore, buildNamedMasks, dataRegistry } from './store'
import { tt } from '@/i18n'
import { patchCapMaterial, syncCapSettings, capState, applyCapSides, capUniforms } from './cap-material'
import { SlotLane } from './heavy-queue'
import type { AtomLabel, Measurement, RepConfig, Settings, StructureEntry } from './types'

/** 视口右上角 3D 坐标轴指示器布局常量（CSS 像素）——引擎叠加渲染与 UI 点击覆盖层共用 */
export const AXIS_GIZMO = { size: 84, margin: 12 } as const

export interface AtomPick {
  structureId: string
  atomIdx: number
  residueIdx: number
  x: number
  y: number
  button: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  doubleClick: boolean
}

export interface HoverInfo {
  structureId: string
  atomIdx: number
  residueIdx: number
  x: number
  y: number
}

export interface EngineCallbacks {
  onHover?: (info: HoverInfo | null) => void
  onPick?: (pick: AtomPick | null, empty: boolean) => void
  onContext?: (pick: AtomPick | null, x: number, y: number) => void
  /** PyMOL 橡皮带框选：Ctrl/Cmd+拖拽松手时回调框内原子（项目坐标 + 修饰键） */
  onBoxSelect?: (rect: { x0: number; y0: number; x1: number; y1: number; additive: boolean; subtractive: boolean }) => void
}

interface RepView {
  hash: string
  build: RepBuild
}

interface StructureView {
  group: THREE.Group
  reps: Map<string, RepView>
  repContainer: THREE.Group
  highlight: THREE.InstancedMesh | null
  selectionRev: number
  labelGroup: THREE.Group
  labelsKey: string
  /** 对称伴侣重建键（rev + reps 可见性 + radius） */
  symKey: string
  /** ensemble 播放期间对称克隆重建节流时间戳 */
  symLastRebuild?: number
}

/** 电子密度图层状态（引擎持有；UI 经 map-store 镜像） */
interface MapLayerState {
  name: string
  grid: Float32Array
  dims: [number, number, number]
  fracOrigin: [number, number, number]
  fracStep: [number, number, number]
  cell: CrystalCell
  mean: number; rms: number; min: number; max: number
  /** 等值面级别（σ 单位：绝对值 = mean ± iso·rms） */
  iso: number
  /** 差图负峰独立 σ 级别（正峰=iso；非差图忽略）——对标 PyMOL 双 isolevel 对象 */
  isoNeg: number
  mode: 'surface' | 'mesh' | 'both'
  /** 差图模式（Fo−Fc）：正峰绿 / 负峰红 双等值面（±iso·σ） */
  difference: boolean
  color: string
  /** 差图负峰颜色（仅 difference 时使用） */
  negColor: string
  opacity: number
  visible: boolean
  meshes: THREE.Mesh[]
  wires: THREE.LineSegments[]
  triangles: number
  truncated: boolean
}

const AMBER = 0xfbbf24
const UP_VECTOR = new THREE.Vector3(0, 1, 0)
/** 俯仰限位边界（距极点 12°）：拖拽旋转限制在极角 [12°, 168°]（±78° 仰角） */
const ORBIT_CLAMP_RAD = THREE.MathUtils.degToRad(12)
/** 俯仰限位动态评估复用向量（每帧分配避免） */
const TMP_ORBIT_V = new THREE.Vector3()
const TMP_Q_IDENTITY = new THREE.Quaternion()
const TMP_Q_SLERP = new THREE.Quaternion()
const TMP_V_UP = new THREE.Vector3()
/** 视角过渡手感 → 默认飞行时长（ms）；camTransition 设置驱动（ScenePanel 可调） */
const CAM_TRANSITION_MS: Record<'quick' | 'normal' | 'cinematic', number> = {
  quick: 350,
  normal: 650,
  cinematic: 1200,
}
/** superpose 空结果常量（失败时展开用） */
const NULL_RESULT: SuperposeResult = {
  ok: false, error: '', mobileChain: '?', refChain: '?', matched: 0,
  rmsd: NaN, quat: [1, 0, 0, 0], translation: [0, 0, 0], pairs: [],
}
/** 超过该原子数时氢键检测走 Web Worker（小结构同步更快） */
const HBOND_WORKER_MIN_ATOMS = 2000
/** 超过该原子数时 SASA 计算走 Web Worker；ΔSASA 三路计算阈值更低 */
const SASA_WORKER_MIN_ATOMS = 2200
const BSA_WORKER_MIN_ATOMS = 900
/** 深色背景下的氢键青色 / 浅色背景下的深青色（对比度自适应） */
const HBOND_COLOR_DARK = 0x4fd1c5
const HBOND_COLOR_LIGHT = 0x0d9488

/** 背景亮度判断（相对亮度 > 0.5 视为浅色） */
function isLightBackground(css: string): boolean {
  const c = new THREE.Color(css)
  return c.r * 0.299 + c.g * 0.587 + c.b * 0.114 > 0.5
}

/** 原子 → 链组索引查找表缓存（isolate/chains hide 链隔离的引擎侧过滤用）。
 *  链组 = data.chains 的连续区间（同链 ID 可拆多组：蛋白链 A + 配体链 A + 水链 A） */
const atomChainGroupCache = new WeakMap<StructureData, Uint16Array>()
function atomChainGroups(data: StructureData): Uint16Array {
  let cg = atomChainGroupCache.get(data)
  if (!cg) {
    cg = new Uint16Array(data.atoms.count)
    data.chains.forEach((c, ci) => {
      for (let i = c.start; i < c.end; i++) cg![i] = ci
    })
    atomChainGroupCache.set(data, cg)
  }
  return cg
}

/**
 * 克隆 rep 组（几何/材质共享）：THREE 的 Object3D.copy 会 JSON 深拷贝 userData，
 * 而 enginePick 存在循环引用（pick.object → mesh）会抛异常——克隆前暂存清空、克隆后恢复。
 */
function cloneGroupShallowUserData(src: THREE.Object3D): THREE.Object3D {
  const stash: { obj: THREE.Object3D; data: Record<string, unknown> }[] = []
  src.traverse(o => {
    if (o.userData && Object.keys(o.userData).length > 0) {
      stash.push({ obj: o, data: o.userData })
      o.userData = {}
    }
  })
  let clone: THREE.Object3D
  try {
    clone = src.clone(true)
  } finally {
    for (const { obj, data } of stash) obj.userData = data
  }
  return clone
}

/** 对称 3x3 特征分解（Jacobi 旋转迭代）；返回按特征值降序 { vals, vecs（vecs[j] 为第 j 个特征向量分量数组） } */
function eigenSymmetric3(a: number[]): { vals: number[]; vecs: number[][] } {
  const m = [...a]
  const vecs: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 24; sweep++) {
    // 最大非对角元
    let p = 0, q = 1, max = Math.abs(m[1])
    if (Math.abs(m[2]) > max) { p = 0; q = 2; max = Math.abs(m[2]) }
    if (Math.abs(m[5]) > max) { p = 1; q = 2; max = Math.abs(m[5]) }
    if (max < 1e-12) break
    const app = m[p * 3 + p], aqq = m[q * 3 + q], apq = m[p * 3 + q]
    const theta = (aqq - app) / (2 * apq)
    const sign = theta >= 0 ? 1 : -1
    const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
    const c = 1 / Math.sqrt(t * t + 1)
    const s = t * c
    // 行/列旋转（A' = JᵀAJ）
    for (let k = 0; k < 3; k++) {
      const mkp = m[k * 3 + p], mkq = m[k * 3 + q]
      m[k * 3 + p] = c * mkp - s * mkq
      m[k * 3 + q] = s * mkp + c * mkq
    }
    for (let k = 0; k < 3; k++) {
      const mpk = m[p * 3 + k], mqk = m[q * 3 + k]
      m[p * 3 + k] = c * mpk - s * mqk
      m[q * 3 + k] = s * mpk + c * mqk
    }
    // 累积特征向量（V = V·J，列更新）
    const vp = [...vecs[p]], vq = [...vecs[q]]
    for (let k = 0; k < 3; k++) {
      vecs[p][k] = c * vp[k] - s * vq[k]
      vecs[q][k] = s * vp[k] + c * vq[k]
    }
  }
  const vals = [m[0], m[4], m[8]]
  const order = [0, 1, 2].sort((i, j) => vals[j] - vals[i])
  return {
    vals: order.map(i => vals[i]),
    vecs: order.map(i => vecs[i].map(v => +v.toFixed(12))),
  }
}

export class MolEngine {
  container: HTMLElement
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  orthoCamera: THREE.OrthographicCamera
  activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  controls: OrbitControls
  raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2(-10, -10)
  private mouseClient = { x: 0, y: 0 }
  private views = new Map<string, StructureView>()
  private measureGroup = new THREE.Group()
  private pickMarkerGroup = new THREE.Group()
  private clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e9), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9)]
  private settings: Settings | null = null
  private raf = 0
  private disposed = false
  private lastHoverTime = 0
  private downPos = { x: 0, y: 0, t: 0, button: -1 }
  /** 橡皮带框选进行中（Ctrl/Cmd+拖拽） */
  private boxSelecting: { x0: number; y0: number; x1: number; y1: number; additive: boolean; subtractive: boolean; active: boolean } | null = null
  /** 橡皮带覆盖 div（px 坐标跟随拖拽；primary 色半透明框） */
  private rubberBandEl: HTMLDivElement | null = null
  private lastLabelsKey = ''
  private lastMeasureKey = ''
  private hbondGroup = new THREE.Group()
  private hbondCache = new Map<string, { key: string; hbonds: HBond[] }>()
  private lastHbondKey = ''
  // 晶胞盒线框（show cell：CRYST1 单胞平行六面体，a 红 b 绿 c 蓝——PyMOL cell 惯例）
  private cellGroup = new THREE.Group()
  private cellKey = ''
  // 接触界面连线（分析面板触发计算，引擎仅负责渲染）
  private contactGroup = new THREE.Group()
  // 孔道剖面环带（pore 命令：HOLE 式红/绿/蓝半径环 + 轴虚线 + 收缩环标记；分析计算在 pore.ts，引擎只渲染）
  private poreGroup = new THREE.Group()
  // 脂双层板（membrane 命令：橙头基双板 + 灰疏水核心；沿活动结构主轴定向，sync 键控重建）
  private membraneGroup = new THREE.Group()
  private membraneKey = ''
  // 氢键检测 Web Worker（大结构异步计算）
  private hbondWorker: Worker | null = null
  private hbondWorkerFailed = false
  // 重计算并发闸：氢键/SASA worker 投递前排队（全局最多 2 个重任务并发）
  private hbondSlots = new SlotLane()
  private sasaSlots = new SlotLane()
  private hbondReqId = 0
  /** structureId → 检测中的 detKey（去重与过期丢弃） */
  private hbondPending = new Map<string, string>()
  /** 最近一次 updateHBonds 的 state（异步结果到达时重渲用） */
  private lastHbondState: Parameters<MolEngine['sync']>[0] | null = null
  // SASA / ΔSASA 计算 Web Worker（大结构异步）
  private sasaWorker: Worker | null = null
  private sasaWorkerFailed = false
  private sasaReqId = 0
  /** structureId → 计算中的 key（去重与过期丢弃） */
  private sasaPending = new Map<string, string>()
  /** 跨结构 ΔSASA 飞行中元信息（worker 结果回传时掩码不可得，用快照补齐 atoms 计数与标签） */
  private xbsaMeta: { idA: string; idB: string; labelA: string; labelB: string; heavyA: number; heavyB: number } | null = null
  /** 挂起的 color sasa 烘焙请求（worker 完成后自动 applyColor） */
  private pendingSasaBake: string | null = null

  /** 挂起 color sasa 烘焙：SASA worker 完成后自动按暴露度着色（store.applyColor 调用） */
  queueSasaBake(structureId: string) {
    this.pendingSasaBake = structureId
  }
  private lastPicksKey = ''
  /** ensemble 播放内部状态（插值帧号与时间戳） */
  private ensemblePlay: { frame: number; lastT: number } | null = null
  /** ensemble/morph 帧写入过坐标但派生缓存（grid/bbox/SASA/口袋场）尚未失效的结构（null = 干净）。
 *  持有 data 引用而非 id：结构被关闭后（撤销关闭闭包持有同一 data）仍能在引擎 sync 移除分支完成失效 */
  private ensembleDirty: { id: string; data: StructureData } | null = null
  /** rock 摇摆：基准偏移与相位 */
  private rockBase: THREE.Vector3 | null = null
  private rockT = 0
  /** 视角书签平滑过渡（p=相机位置插值；g=controls.target 插值；fov 线性；
   *  up 全程球面插值——结尾零跳变、极点过渡无退化帧） */
  private camAnim: {
    t0: number; dur: number
    p0: THREE.Vector3; p1: THREE.Vector3
    g0: THREE.Vector3; g1: THREE.Vector3
    fov0: number; fov1: number
    up0: THREE.Vector3; up1: THREE.Vector3
    /** up0→up1 旋转（up 无变化时为 null，跳过插值工作） */
    upQ: THREE.Quaternion | null
  } | null = null
  /** 相机巡航路径（movie 平滑模式）：关键帧 Catmull-Rom 位置/目标插值 + up 逐段球面插值，
   *  关键帧处速度连续（无逐帧驻留顿挫，录像丝滑）；全局 easeInOutCubic 柔和起停 */
  private camPath: {
    t0: number
    /** 段累计时长边界（ms；cum.length = 段数） */
    cum: number[]
    keys: { p: THREE.Vector3; g: THREE.Vector3; up: THREE.Vector3; fov: number }[]
    /** 每段 up 旋转（keys[i]→keys[i+1]；近平行为 null） */
    upQ: (THREE.Quaternion | null)[]
    total: number
  } | null = null
  /** 用户中断相机动画计数（pointerdown/wheel 时递增；movie 序列播放器用它检测接管） */
  private camAnimCancelCount = 0
  private lastTickT = 0
  private ro: ResizeObserver
  private pickablesCache: { obj: THREE.Object3D; pick: Pickable; structureId: string }[] | null = null
  private hasContent = false
  // 灯光引用（applySettings 调节强度）
  private keyLight!: THREE.DirectionalLight
  private fillLight!: THREE.DirectionalLight
  private ambientLight!: THREE.AmbientLight
  // 红蓝立体（AnaglyphEffect 懒建；关闭即释放）
  private stereoEffect: AnaglyphEffect | null = null
  // 电子密度图层（单个；isomesh + isosurface）
  private mapGroup = new THREE.Group()
  private mapLayer: MapLayerState | null = null
  // 对称伴侣克隆组（structureId → 克隆容器；几何/材质与原 rep 共享）
  private symmetryGroups = new Map<string, THREE.Group>()
  // GTAO / 轮廓线后处理管线（ssao 或 outline 开启时懒建；gtaoFailed/edgeFailed 构建失败后永久回退）
  private composer: EffectComposer | null = null
  private gtaoPass: GTAOPass | null = null
  private composerCamera: THREE.Camera | null = null
  private gtaoFailed = false
  private edgePass: ShaderPass | null = null
  private edgeFailed = false
  // 帧性能统计（500ms 窗口上报 perf-store；autoReset 关闭后帧首手动清零）
  private perfFrames = 0
  private perfLastT = 0
  private perfStatInit = false
  /** 最近一个统计窗口的帧率（perf status 显示用，与指示器无关） */
  private lastWindowFps = 0
  // 自动性能模式（watchdog）：低帧率连续窗口计数 → 降级；高帧率连续窗口 → 恢复
  private perfLowStreak = 0
  private perfHighStreak = 0
  /** 降级前用户设置基线（恢复时还原；手动接手则直接退出自动模式） */
  private perfBaseline: { ssao: boolean; outline: boolean } | null = null
  /** 降级时的像素比乘数（恢复时回 1；applySettings 统一乘入 quality 上限） */
  private perfPrFactor = 1
  // 动画录制（WebM）
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recordStartT = 0
  private recordResolve: ((blob: Blob | null) => void) | null = null
  // 视口右上角 3D 坐标轴指示器（朝向罗盘；懒建）
  private gizmoScene: THREE.Scene | null = null
  private gizmoCamera: THREE.OrthographicCamera | null = null
  private gizmoDiscTex: THREE.CanvasTexture | null = null
  /** 罗盘逐轴部件（hover 发光反馈用）：正方向箭头+字母 / 负方向暗点 */
  private gizmoAxisParts: {
    dir: THREE.Vector3
    shaft: THREE.Mesh
    head: THREE.Mesh
    label: THREE.Sprite
    neg: THREE.Mesh
    mat: THREE.MeshBasicMaterial
    negMat: THREE.MeshBasicMaterial
    baseColor: THREE.Color
    labelScale: number
    /** 正方向箭头发光值（0..1） */
    glowPos: number
    /** 负方向暗点发光值（0..1） */
    glowNeg: number
  }[] = []
  /** 当前 hover 的轴（带符号单位向量；null = 无）；由 UI 覆盖层写入 */
  private gizmoHover: THREE.Vector3 | null = null
  // 序列条视口聚焦：残基代表原子缓存（structureId → 每残基一个原子索引）
  private repAtomCache = new Map<string, Int32Array>()
  /** 上次可见性计算的相机/切层签名（变化才重算） */
  private lastVisSig = ''
  /** 上次可见性计算时间（节流 150ms） */
  private lastVisT = 0

  constructor(container: HTMLElement, private callbacks: EngineCallbacks = {}) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.localClippingEnabled = true
    this.canvas = this.renderer.domElement
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.display = 'block'
    this.canvas.style.outline = 'none'
    this.canvas.tabIndex = 0
    container.appendChild(this.canvas)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#ffffff')
    this.scene.add(this.measureGroup)
    this.cellGroup.userData.isOverlay = true
    this.scene.add(this.cellGroup)
    this.scene.add(this.pickMarkerGroup)
    this.scene.add(this.hbondGroup)
    this.scene.add(this.contactGroup)
    this.scene.add(this.poreGroup)
    this.scene.add(this.membraneGroup)
    this.scene.add(this.mapGroup)

    // 环境光照（亮度配平：RoomEnvironment 贡献≈0.45×，叠加主光后总照度≈1.3 —— 过高会经 ACES 把饱和色
    // 冲成灰白「褪色」（用户反馈彩虹上色不显色的根因）；分数 DPR 下另见 syncComposerTargets）
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.06)
    this.scene.environment = env.texture
    this.scene.environmentIntensity = 0.45
    pmrem.dispose()

    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(4, 8, 5)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.35)
    fill.position.set(-5, -3, -4)
    this.scene.add(fill)
    const ambient = new THREE.AmbientLight(0xffffff, 0.08)
    this.scene.add(ambient)
    this.keyLight = key
    this.fillLight = fill
    this.ambientLight = ambient

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 8000)
    this.camera.position.set(40, 30, 60)
    this.orthoCamera = new THREE.OrthographicCamera(-50, 50, 40, -40, -2000, 8000)
    this.activeCamera = this.camera

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.rotateSpeed = 0.9
    this.controls.zoomSpeed = 1.1
    this.controls.minDistance = 2
    this.controls.maxDistance = 4000

    // 裁剪平面常开（slab 关闭时设置为无穷远 → 不裁剪）
    this.setClippingInfinite()

    // 调试钩子（QA / 诊断用：window.__molEngine 检查引擎内部状态）
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__molEngine = this

    // 事件
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onCancelCamAnim, { passive: true })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('pointerleave', this.onPointerLeave)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()

    this.tick()
    // 调试钩子（可在浏览器控制台检查引擎状态）
    ;(window as unknown as { __molEngine?: MolEngine }).__molEngine = this
  }

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.updateOrthoFrustum()
    if (this.composer) {
      this.syncComposerTargets(w, h, this.renderer.getPixelRatio())
    }
    this.stereoEffect?.setSize(w, h)
    this.pickablesCache = null
  }

  /** 正交 frustum 尺寸更新（纯几何职责）：半高按正交相机自身到 target 的距离换算
   *  （正交激活后 OrbitControls 直接驱动 orthoCamera，透视相机位姿已陈旧）。
   *  r63-fix-c #2：不触碰 zoom 与位姿——resize/设置变更不再重置用户滚轮缩放，
   *  也不再把陈旧的透视机位覆盖到正交相机上；位姿同步只在激活瞬间做（applySettings）。 */
  private updateOrthoFrustum() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const dist = Math.max(this.orthoCamera.position.distanceTo(this.controls.target), 1)
    const halfH = dist * Math.tan((this.camera.fov * Math.PI) / 360)
    const halfW = (halfH * w) / h
    this.orthoCamera.top = halfH
    this.orthoCamera.bottom = -halfH
    this.orthoCamera.left = -halfW
    this.orthoCamera.right = halfW
    this.orthoCamera.updateProjectionMatrix()
  }

  /** 正交相机逐帧跟随透视相机位姿（camAnim/camPath 飞行期间透视相机是被动画驱动的权威，
   *  正交相机必须镜像其位姿否则飞行视口不动）；zoom 归 1 = 视角书签/适配的取景重置语义 */
  private syncOrthoPose() {
    this.orthoCamera.position.copy(this.camera.position)
    this.orthoCamera.quaternion.copy(this.camera.quaternion)
    this.orthoCamera.zoom = 1
    this.updateOrthoFrustum()
  }

  private tick = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const now = performance.now()
    const dt = this.lastTickT ? Math.min((now - this.lastTickT) / 1000, 0.1) : 0.016
    this.lastTickT = now
    // 帧统计：autoReset 关闭 → composer 多次内部 render 调用累计不丢失，帧首手动清零
    if (!this.perfStatInit) {
      this.renderer.info.autoReset = false
      this.perfStatInit = true
      this.perfLastT = now
    }
    this.renderer.info.reset()
    this.updateEnsemble()
    // OrbitControls 逐帧 update：damping 惯性与 autoRotate 自动旋转需要持续驱动
    // （此前仅在一次性方法中调用——自动旋转(S)实际不动、拖拽无惯性尾巴）；
    // 无输入时 update 近似 no-op（change 事件仅在相机位移超 EPS 时派发）。
    // 俯仰限位动态生效后紧接 update；camAnim 块在其后覆盖位置，外部动画安全。
    this.updateOrbitClampDynamic()
    this.controls.update()
    // 视角书签平滑过渡：easeInOutCubic 插值 pos/target/fov（放在 controls.update 之后，
    // 无用户输入时 OrbitControls 每帧以当前位置重算球坐标，外部修改可安全生效）
    if (this.camAnim) {
      const a = this.camAnim
      const k = Math.min(1, (now - a.t0) / a.dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      this.camera.position.lerpVectors(a.p0, a.p1, e)
      this.controls.target.lerpVectors(a.g0, a.g1, e)
      if (Math.abs(a.fov1 - a.fov0) > 1e-3) {
        this.camera.fov = a.fov0 + (a.fov1 - a.fov0) * e
        this.camera.updateProjectionMatrix()
      }
      // up 球面插值 + 逐帧 lookAt：方向随插值位姿即时更新——
      // 结尾零跳变（旧实现结尾一次性换 up = 录像中可见的「重置视角」突变），
      // 极点过渡无退化帧（旧实现 up 全程不变，接近 top/bottom 时 lookAt 退化产生方向乱摆）
      if (a.upQ) {
        TMP_Q_SLERP.slerpQuaternions(TMP_Q_IDENTITY, a.upQ, e)
        this.camera.up.copy(a.up0).applyQuaternion(TMP_Q_SLERP).normalize()
      }
      this.camera.lookAt(this.controls.target)
      // 正交激活时飞行位姿镜像到 orthoCamera（透视相机是动画驱动权威）
      if (this.activeCamera === this.orthoCamera) this.syncOrthoPose()
      if (k >= 1) {
        // 落位：up 精确归位（slerp(1) 已到位，此处兜底浮点误差）+ controls 同步球坐标
        this.camera.up.copy(a.up1)
        this.orthoCamera.up.copy(a.up1)
        this.controls.update()
        this.camAnim = null
      }
    } else if (this.camPath) {
      // 巡航路径：关键帧间 Catmull-Rom（速度连续，无驻留）+ 全局 easeInOutCubic 柔和起停
      const a = this.camPath
      const s = Math.min(1, (now - a.t0) / a.total)
      const se = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2
      const tMs = se * a.total
      // 定位当前段 i（cum[i-1] ≤ tMs < cum[i]；末尾溢出钳到最后一段）
      let i = 0
      while (i < a.cum.length - 1 && tMs >= a.cum[i]) i++
      const segStart = i === 0 ? 0 : a.cum[i - 1]
      const f = Math.min(1, (tMs - segStart) / Math.max(1, a.cum[i] - segStart))
      const k0 = a.keys[i], k1 = a.keys[i + 1]
      const km = a.keys[i - 1] ?? k0    // 端点钳位（首段切线参考自身）
      const kp = a.keys[i + 2] ?? k1    // 尾段同理
      // Catmull-Rom（Hermite 基）：过全部关键帧，切线 = (k[i+1]-k[i-1])/2，速度在关键帧处连续
      const f2 = f * f, f3 = f2 * f
      const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2
      this.camera.position.set(
        h00 * k0.p.x + 0.5 * h10 * (k1.p.x - km.p.x) + h01 * k1.p.x + 0.5 * h11 * (kp.p.x - k0.p.x),
        h00 * k0.p.y + 0.5 * h10 * (k1.p.y - km.p.y) + h01 * k1.p.y + 0.5 * h11 * (kp.p.y - k0.p.y),
        h00 * k0.p.z + 0.5 * h10 * (k1.p.z - km.p.z) + h01 * k1.p.z + 0.5 * h11 * (kp.p.z - k0.p.z),
      )
      this.controls.target.set(
        h00 * k0.g.x + 0.5 * h10 * (k1.g.x - km.g.x) + h01 * k1.g.x + 0.5 * h11 * (kp.g.x - k0.g.x),
        h00 * k0.g.y + 0.5 * h10 * (k1.g.y - km.g.y) + h01 * k1.g.y + 0.5 * h11 * (kp.g.y - k0.g.y),
        h00 * k0.g.z + 0.5 * h10 * (k1.g.z - km.g.z) + h01 * k1.g.z + 0.5 * h11 * (kp.g.z - k0.g.z),
      )
      if (Math.abs(k1.fov - k0.fov) > 1e-3) {
        this.camera.fov = k0.fov + (k1.fov - k0.fov) * f
        this.camera.updateProjectionMatrix()
      }
      const uq = a.upQ[i]
      if (uq) {
        TMP_Q_SLERP.slerpQuaternions(TMP_Q_IDENTITY, uq, f)
        this.camera.up.copy(k0.up).applyQuaternion(TMP_Q_SLERP).normalize()
      } else {
        this.camera.up.copy(k0.up)
      }
      this.camera.lookAt(this.controls.target)
      // 正交激活时巡航位姿镜像到 orthoCamera（同 camAnim）
      if (this.activeCamera === this.orthoCamera) this.syncOrthoPose()
      if (s >= 1) {
        const last = a.keys[a.keys.length - 1]
        this.camera.position.copy(last.p)
        this.controls.target.copy(last.g)
        this.camera.up.copy(last.up)
        this.orthoCamera.up.copy(last.up)
        if (Math.abs(this.camera.fov - last.fov) > 1e-3) {
          this.camera.fov = last.fov
          this.camera.updateProjectionMatrix()
        }
        this.camera.lookAt(this.controls.target)
        this.controls.update()
        this.camPath = null
      }
    }
    // rock 摇摆：绕 target 上下轴正弦摆动（用户拖动时以新视角为基准）
    if (this.settings?.rock) {
      const cam = this.activeCamera
      if (!this.rockBase) {
        this.rockBase = cam.position.clone().sub(this.controls.target)
        this.rockT = 0
      }
      this.rockT += dt * (this.settings.spinSpeed || 2) * 0.45
      const angle = Math.sin(this.rockT) * (Math.PI / 7) // ±≈25.7°
      const off = this.rockBase.clone().applyAxisAngle(UP_VECTOR, angle)
      cam.position.copy(this.controls.target).add(off)
      cam.lookAt(this.controls.target)
    }
    const cam = this.activeCamera
    const dist = cam.position.distanceTo(this.controls.target)
    // 雾
    if (this.settings?.fog) {
      const fog = this.scene.fog as THREE.Fog
      if (fog) {
        const k = 1.4 - this.settings.fogStrength * 0.9
        fog.near = dist * k
        fog.far = dist * (k + 2.2 - this.settings.fogStrength * 1.2)
      }
    }
    // 裁剪（slab）：中心 = 环绕目标沿视线偏移 slabOffset（PyMOL clip 风格切层）
    if (this.settings?.slab) {
      const dir = new THREE.Vector3().subVectors(this.controls.target, cam.position).normalize()
      const half = this.settings.slabThickness / 2
      // 基准点 = 相机沿视线前进 |target-cam|（即环绕目标），再叠加偏移
      const base = dir.dot(cam.position) + dist + (this.settings.slabOffset ?? 0)
      // 可见条件 n·p + c ≥ 0：near 平面保留 base-half 之前方，far 平面保留 base+half 之后方
      this.clippingPlanes[0].normal.copy(dir)
      this.clippingPlanes[0].constant = -(base - half)
      this.clippingPlanes[1].normal.copy(dir).negate()
      this.clippingPlanes[1].constant = base + half
      // 封盖深度明暗：把场景包围盒投影到 NDC 取 z 范围（shader 内归一化视深用）
      if (capUniforms.uCapShadeOn.value > 0.5) this.updateCapDepthRange(cam)
    }
    // 渲染：stereo 红蓝立体优先（直渲，后处理停用避免串色），其次 GTAO/轮廓线 composer，最后直接渲染
    if (this.settings?.stereo) {
      if (!this.stereoEffect) {
        this.stereoEffect = new AnaglyphEffect(this.renderer)
        this.stereoEffect.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1)
      }
      this.stereoEffect.render(this.scene, cam)
    } else {
      if (this.stereoEffect) {
        this.stereoEffect.dispose()
        this.stereoEffect = null
      }
      // GTAO 遮蔽 / 轮廓线：经 EffectComposer 渲染；否则直接渲染
      const wantSsao = !!this.settings?.ssao && !this.gtaoFailed
      const wantOutline = !!this.settings?.outline && !this.edgeFailed
      if (wantSsao || wantOutline) {
        this.ensureComposer()
        if (this.composer && (this.gtaoPass || this.edgePass)) {
          const w = this.container.clientWidth || 1
          const h = this.container.clientHeight || 1
          const pr = this.renderer.getPixelRatio()
          this.syncComposerTargets(w, h, pr)
          if (this.gtaoPass) {
            // 刷新投影矩阵 uniform（FOV / 正交 zoom / 相机切换后仍正确）
            this.gtaoPass.blendIntensity = this.settings?.ssaoIntensity ?? 1
            // 半径为纯 uniform 更新（无 shader 重编译），每帧同步保证滑块即时生效
            this.gtaoPass.updateGtaoMaterial({ radius: this.settings?.ssaoRadius ?? 3 })
            this.gtaoPass.enabled = wantSsao
          }
          // 轮廓线 pass 常开（outline 关闭时退化为「背景还原 + 直通」，修复 composer 路径
          // 背景被 ACES 色调映射漂移的问题——与直接渲染路径的 glClear 行为对齐）
          if (this.edgePass) {
            this.edgePass.enabled = true
            this.syncEdgePass(Math.round(w * pr), Math.round(h * pr))
          }
          // RenderPass 固定写 readBuffer：每帧指回 rt1（其 depthTexture 供轮廓线采样，与启用 pass 数无关）
          this.resetComposerBuffers()
          this.composer.render()
        } else {
          this.renderer.render(this.scene, cam)
        }
      } else {
        if (this.composer) this.disposeComposer()
        this.renderer.render(this.scene, cam)
      }
    }
    // 主渲染后叠加坐标轴指示器（右上角小视口；stereo 红蓝模式下跳过避免串色）
    this.renderGizmo(cam)
    // 序列条视口聚焦：相机/切层/结构变化时重算残基可见性（节流 150ms）
    this.updateViewportVisibility(now)
    // 帧尾统计：500ms 窗口上报 perf-store（仅指示器开启时写入，避免无谓渲染）
    // 至少累计 2 帧才结算（后台节流页 ~2fps 时窗口只含 1 帧会显示误导性 0.x fps）
    this.perfFrames++
    const elapsed = now - this.perfLastT
    if (elapsed >= 500 && this.perfFrames >= 2) {
      const fps = (this.perfFrames * 1000) / elapsed
      this.lastWindowFps = fps
      if (this.settings?.showFps) {
        const info = this.renderer.info
        usePerfStore.getState().set({
          fps,
          frameMs: elapsed / this.perfFrames,
          drawCalls: info.render.calls / this.perfFrames,
          triangles: info.render.triangles / this.perfFrames,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
        })
      }
      // 自动性能模式 watchdog（与指示器独立运行）
      this.updateAutoPerf(fps)
      this.perfFrames = 0
      this.perfLastT = now
    } else if (elapsed >= 8000) {
      // 极端兜底：长时间无帧（标签页挂起恢复）重置窗口，避免陈旧基准
      this.perfFrames = 0
      this.perfLastT = now
    }
  }

  // ---------- 自动性能模式（watchdog） ----------

  /** 每个统计窗口调用：低帧率连续 6 窗口（~3s）降级；降级后 ≥30fps 连续 20 窗口（~10s）恢复 */
  private updateAutoPerf(fps: number) {
    if (!this.settings?.autoPerf) {
      // 自动模式关闭：若此前由自动降级 → 立即恢复基线（手动接手场景已在 applySettings 处理并退出自动模式）
      if (this.perfBaseline) this.restorePerfBaseline(tt({ zh: '自动性能模式已关闭，画质设置已还原', en: 'Auto performance mode off — quality settings restored' }))
      return
    }
    if (this.perfBaseline) {
      // 已降级：观察恢复条件（≥30fps 连续 20 窗口）
      if (fps >= 30) {
        this.perfHighStreak++
        if (this.perfHighStreak >= 20) {
          this.restorePerfBaseline(tt({ zh: `帧率已稳定（${fps.toFixed(0)} fps），自动还原后处理与分辨率`, en: `Frame rate stabilized (${fps.toFixed(0)} fps) — post-processing and resolution restored automatically` }))
        }
      } else {
        this.perfHighStreak = 0
      }
      return
    }
    // 未降级：低帧率连续 6 窗口触发（无可降级项时保持饱和计数，不反复触发）
    if (fps < 15) {
      this.perfLowStreak++
      if (this.perfLowStreak < 6) return
      const s = this.settings
      const heavy = s.ssao || s.outline || this.renderer.getPixelRatio() > 1.01
      if (!heavy) return
      this.perfBaseline = { ssao: s.ssao, outline: s.outline }
      this.perfPrFactor = 0.6
      this.perfHighStreak = 0
      // 立即生效：像素比直接下调；后处理经 store 走常规 sync 路径（同时写降级徽章）
      this.applyPixelRatio()
      useMolStore.getState().updateSettings({ ssao: false, outline: false })
      usePerfStore.getState().setDegraded(true)
      useMolStore.getState().appendLog(
        'out',
        tt({ zh: `自动性能模式：帧率持续偏低（${fps.toFixed(0)} fps），已临时关闭后处理并降低分辨率（perf off 或等待恢复）`, en: `Auto performance mode: frame rate persistently low (${fps.toFixed(0)} fps) — post-processing temporarily disabled and resolution reduced (perf off, or wait for recovery)` }),
      )
    } else {
      this.perfLowStreak = 0
    }
  }

  /** 还原降级前的用户设置（pixel ratio 因子 + ssao/outline） */
  private restorePerfBaseline(reason: string) {
    const baseline = this.perfBaseline
    this.perfBaseline = null
    this.perfLowStreak = 0
    this.perfHighStreak = 0
    this.perfPrFactor = 1
    this.applyPixelRatio()
    if (baseline) {
      useMolStore.getState().updateSettings({ ssao: baseline.ssao, outline: baseline.outline })
    }
    usePerfStore.getState().setDegraded(false)
    useMolStore.getState().appendLog('out', reason)
  }

  /** 像素比统一入口：quality 上限 × 自动降级因子（applySettings 与 watchdog 共用） */
  private applyPixelRatio() {
    const cap = this.settings?.quality === 'high' ? 2 : this.settings?.quality === 'medium' ? 1.5 : 1
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap) * this.perfPrFactor)
  }

  /** 命令行 perf status / 恢复入口 */
  perfStatus(): { autoPerf: boolean; degraded: boolean; fps: number } {
    const p = usePerfStore.getState()
    return { autoPerf: !!this.settings?.autoPerf, degraded: p.degraded, fps: this.lastWindowFps }
  }

  /** 手动恢复（perf restore）：按基线还原 */
  perfManualRestore() {
    if (!this.perfBaseline) {
      // 无基线也重置因子，保证一致状态
      this.perfPrFactor = 1
      this.applyPixelRatio()
      usePerfStore.getState().setDegraded(false)
      return false
    }
    this.restorePerfBaseline(tt({ zh: '已手动恢复画质设置', en: 'Quality settings restored manually' }))
    return true
  }

  // ---------- 序列条视口聚焦（残基级可见性） ----------

  /** 残基代表原子：优先 CA（蛋白）/ P（核酸磷酸骨架），否则首原子（缓存） */
  private repAtoms(structureId: string, data: StructureData): Int32Array {
    const cached = this.repAtomCache.get(structureId)
    if (cached) return cached
    const out = new Int32Array(data.residues.length)
    const names = data.atoms.names
    for (let ri = 0; ri < data.residues.length; ri++) {
      const r = data.residues[ri]
      let rep = r.start
      for (let i = r.start; i < r.end; i++) {
        const n = names[i]
        if (n === 'CA' || n === 'P') { rep = i; break }
      }
      out[ri] = rep
    }
    this.repAtomCache.set(structureId, out)
    return out
  }

  /**
   * 视口聚焦重算：相机位姿/FOV/切层/结构切换（或 ensemble 播放）触发，150ms 节流。
   * 可见判据 = 视锥内（相机空间前置 + NDC |x|,|y| ≤ 1.02）且切层开启时满足两裁剪平面。
   * 结果仅在变化时写入 viewport-store（避免序列条无谓重渲）。
   */
  private updateViewportVisibility(now: number) {
    if (!this.settings?.seqFocus) {
      if (useViewportStore.getState().structureId !== null) useViewportStore.getState().set(null, null)
      this.lastVisSig = ''
      return
    }
    const state = useMolStore.getState()
    const id = state.activeId
    const cam = this.activeCamera
    // 签名：活动结构 / 相机位姿 / fov / 正交视锥 / 切层 / ensemble 播放状态
    const es = useEnsembleStore.getState()
    const sig = [
      id ?? '',
      cam.position.x.toFixed(2), cam.position.y.toFixed(2), cam.position.z.toFixed(2),
      cam.quaternion.x.toFixed(3), cam.quaternion.y.toFixed(3), cam.quaternion.z.toFixed(3), cam.quaternion.w.toFixed(3),
      this.activeCamera === this.orthoCamera ? 'ortho' : `fov${this.camera.fov.toFixed(1)}`,
      this.settings.slab ? `${this.settings.slabThickness}|${this.settings.slabOffset ?? 0}` : 'noslab',
      es.structureId === id && es.playing ? `ens${es.frame}` : '',
      state.visualRev,
    ].join(',')
    if (sig === this.lastVisSig) return
    if (now - this.lastVisT < 150) return // 节流（签名保持差异，下帧重试）
    this.lastVisSig = sig
    this.lastVisT = now
    const data = id ? dataRegistry.get(id) : null
    if (!id || !data) {
      if (useViewportStore.getState().structureId !== null) useViewportStore.getState().set(null, null)
      return
    }
    const reps = this.repAtoms(id, data)
    const pos = data.atoms.positions
    const visible = new Uint8Array(data.residues.length)
    // 相机空间矩阵（前置判断）+ 组合投影矩阵 projection × view（直接透视除法到 NDC）
    cam.updateMatrixWorld()
    const viewMat = cam.matrixWorldInverse
    const projScreen = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, viewMat)
    const slab = !!this.settings.slab
    const p0 = this.clippingPlanes[0]
    const p1 = this.clippingPlanes[1]
    const useSlab = slab && p0.constant < 1e8
    const v = new THREE.Vector3()
    const ndc = new THREE.Vector3()
    for (let ri = 0; ri < visible.length; ri++) {
      const a = reps[ri]
      v.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2])
      if (useSlab && (p0.distanceToPoint(v) < 0 || p1.distanceToPoint(v) < 0)) continue
      ndc.copy(v).applyMatrix4(viewMat)
      if (ndc.z >= 0) continue // 相机后方
      ndc.copy(v).applyMatrix4(projScreen)  // applyMatrix4 自动做透视除法
      if (ndc.x < -1.02 || ndc.x > 1.02 || ndc.y < -1.02 || ndc.y > 1.02) continue
      visible[ri] = 1
    }
    // 变化才写入（SequenceBar 按数组身份触发重渲）
    const prev = useViewportStore.getState()
    if (prev.structureId !== id) {
      useViewportStore.getState().set(id, visible)
      return
    }
    if (prev.visible && prev.visible.length === visible.length && prev.visible.every((b, i) => b === visible[i])) return
    useViewportStore.getState().set(id, visible)
  }

  /**
   * 封盖深度明暗支持：把所有可见结构的包围盒 8 角投影到 NDC，取 z 范围写入共享 uniforms。
   * 每帧调用（仅 slab+cap+shading 同时开启），8×结构数次矩阵乘——开销可忽略。
   * 注：对称伴侣/深位姿极端场景按主结构包围盒近似（渐变仅取相对层次，绝对范围不敏感）。
   */
  private capDepthV = new THREE.Vector3()
  private capDepthMat = new THREE.Matrix4()
  private updateCapDepthRange(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    cam.updateMatrixWorld()
    this.capDepthMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    let z0 = Infinity, z1 = -Infinity
    const m = this.capDepthMat
    const v = this.capDepthV
    for (const entry of useMolStore.getState().structures) {
      if (!entry.visible) continue
      const data = dataRegistry.get(entry.id)
      if (!data) continue
      const { min, max } = data.bbox
      for (let c = 0; c < 8; c++) {
        v.set(c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2])
        v.applyMatrix4(m)
        if (v.z < z0) z0 = v.z
        if (v.z > z1) z1 = v.z
      }
    }
    if (!isFinite(z0)) return
    capUniforms.uCapZ0.value = z0
    capUniforms.uCapZ1.value = Math.max(z1, z0 + 1e-4)
  }

  // ---------- 坐标轴指示器（朝向罗盘） ----------

  /** hover 发光用临时白色（避免每帧 new Color） */
  private static readonly GIZMO_WHITE = new THREE.Color(1, 1, 1)

  /** 懒建指示器场景：三轴箭头（RGB↔XYZ 惯例）+ 轴字母 + 负方向暗点 + 主题中性背景圆盘 */
  private buildGizmo() {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    scene.add(root)
    this.gizmoAxisParts = []

    // 背景圆盘：Sprite 永远面向相机；半透明底 + 细环（深浅主题通吃）
    const px = 128
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = px
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(px / 2, px / 2, px * 0.16, px / 2, px / 2, px * 0.5)
    grad.addColorStop(0, 'rgba(255,255,255,0.03)')
    grad.addColorStop(0.8, 'rgba(255,255,255,0.18)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px * 0.5, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = 'rgba(127,127,138,0.7)'
    ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px * 0.5 - 2, 0, Math.PI * 2); ctx.stroke()
    const discTex = new THREE.CanvasTexture(canvas)
    discTex.colorSpace = THREE.SRGBColorSpace
    this.gizmoDiscTex = discTex
    const disc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: discTex, transparent: true, depthTest: false, depthWrite: false,
    }))
    disc.scale.set(2.62, 2.62, 1)
    disc.renderOrder = -1
    root.add(disc)

    // 三轴箭头 + 字母 + 负方向暗点（长度单位 ≈ 指示器 NDC 的一半）
    const AXES: { dir: [number, number, number]; color: string; label: string }[] = [
      { dir: [1, 0, 0], color: '#d95c5c', label: 'X' },
      { dir: [0, 1, 0], color: '#4faf63', label: 'Y' },
      { dir: [0, 0, 1], color: '#4a7fd6', label: 'Z' },
    ]
    const LEN = 0.9
    const UP = new THREE.Vector3(0, 1, 0)
    for (const a of AXES) {
      const dir = new THREE.Vector3(a.dir[0], a.dir[1], a.dir[2])
      const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir)
      const mat = new THREE.MeshBasicMaterial({ color: a.color })
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, LEN - 0.17, 12), mat)
      shaft.quaternion.copy(quat)
      shaft.position.copy(dir.clone().multiplyScalar((LEN - 0.17) / 2))
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.092, 0.17, 12), mat)
      head.quaternion.copy(quat)
      head.position.copy(dir.clone().multiplyScalar(LEN - 0.085))
      root.add(shaft, head)

      const lbl = makeTextSprite(a.label, 0.4, { color: a.color, outline: 'rgba(255,255,255,0.92)', fontSize: 64 })
      lbl.position.copy(dir.clone().multiplyScalar(LEN + 0.26))
      root.add(lbl)

      const negMat = new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.42 })
      const neg = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 10), negMat)
      neg.position.copy(dir.clone().multiplyScalar(-0.64))
      root.add(neg)

      // 记录部件供 hover 发光（renderGizmo 每帧驱动插值；正/负端独立发光）
      this.gizmoAxisParts.push({
        dir, shaft, head, label: lbl, neg, mat, negMat,
        baseColor: new THREE.Color(a.color),
        labelScale: lbl.scale.x,
        glowPos: 0,
        glowNeg: 0,
      })
    }

    this.gizmoScene = scene
    this.gizmoCamera = new THREE.OrthographicCamera(-1.55, 1.55, 1.55, -1.55, 0.1, 12)
  }

  /** 每帧叠加渲染：四元数与主相机同步 → 罗盘实时反映视角朝向；scissor 裁剪到右上角小视口；未加载结构时不渲染（空视口保持干净） */
  private renderGizmo(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    if (!this.settings?.showAxes || this.settings.stereo || !this.hasContent) return
    if (!this.gizmoScene) this.buildGizmo()
    const gs = this.gizmoScene
    const gc = this.gizmoCamera
    if (!gs || !gc) return
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    if (w < AXIS_GIZMO.size + AXIS_GIZMO.margin * 2 || h < AXIS_GIZMO.size + AXIS_GIZMO.margin * 2) return

    // hover 发光动画（指数逼近；端点专属——hover 正端亮箭头，hover 负端亮暗点，
    // 同轴另一端跟随轻微提亮保持轴级反馈）
    const hv = this.gizmoHover
    for (const p of this.gizmoAxisParts) {
      const dot = hv ? p.dir.dot(hv) : 0 // +1 = 正端 hover；-1 = 负端 hover
      const tPos = hv ? (dot > 0.5 ? 1 : dot < -0.5 ? 0.3 : 0) : 0
      const tNeg = hv ? (dot < -0.5 ? 1 : dot > 0.5 ? 0.3 : 0) : 0
      p.glowPos += (tPos - p.glowPos) * 0.28
      p.glowNeg += (tNeg - p.glowNeg) * 0.28
      const gp = p.glowPos
      if (gp > 0.004) {
        // 正端：箭头提亮 + 微放大
        p.mat.color.copy(p.baseColor).lerp(MolEngine.GIZMO_WHITE, 0.42 * gp)
        p.shaft.scale.setScalar(1 + 0.16 * gp)
        p.head.scale.setScalar(1 + 0.22 * gp)
        p.label.scale.setScalar(p.labelScale * (1 + 0.18 * gp))
      } else if (gp !== 0) {
        p.glowPos = 0
        p.mat.color.copy(p.baseColor)
        p.shaft.scale.setScalar(1)
        p.head.scale.setScalar(1)
        p.label.scale.setScalar(p.labelScale)
      }
      const gn = Math.max(p.glowNeg, gp * 0.3) // 正端 hover 时负点跟随微亮
      if (gn > 0.004) {
        p.negMat.opacity = 0.42 + 0.5 * gn
        p.neg.scale.setScalar(1 + 0.4 * gn)
      } else if (p.glowNeg !== 0) {
        p.glowNeg = 0
        p.negMat.opacity = 0.42
        p.neg.scale.setScalar(1)
      }
    }

    const q = cam.quaternion
    gc.position.set(0, 0, 4).applyQuaternion(q)
    gc.quaternion.copy(q)

    const x = w - AXIS_GIZMO.size - AXIS_GIZMO.margin
    const y = h - AXIS_GIZMO.size - AXIS_GIZMO.margin // WebGL 视口 y 从底部起算 → 右上角
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(null)
    this.renderer.setScissorTest(true)
    this.renderer.setScissor(x, y, AXIS_GIZMO.size, AXIS_GIZMO.size)
    this.renderer.setViewport(x, y, AXIS_GIZMO.size, AXIS_GIZMO.size)
    this.renderer.clearDepth()
    this.renderer.render(gs, gc)
    this.renderer.setScissorTest(false)
    this.renderer.setViewport(0, 0, w, h)
    this.renderer.autoClear = prevAutoClear
  }

  /** 指示器点击拾取：容器内坐标 → 最近的 ±X/±Y/±Z 轴（屏幕投影距离阈值内）；UI 覆盖层调用 */
  gizmoAxisFromPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.settings?.showAxes || !this.hasContent) return null
    const rect = this.container.getBoundingClientRect()
    const gx = clientX - rect.left
    const gy = clientY - rect.top
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const x0 = w - AXIS_GIZMO.size - AXIS_GIZMO.margin
    const y0 = AXIS_GIZMO.margin
    if (gx < x0 || gx > x0 + AXIS_GIZMO.size || gy < y0 || gy > y0 + AXIS_GIZMO.size) return null
    // 覆盖层局部 NDC（-1..1；DOM y 向下 → 翻转为数学向上）
    const nx = ((gx - x0) / AXIS_GIZMO.size) * 2 - 1
    const ny = -(((gy - y0) / AXIS_GIZMO.size) * 2 - 1)
    const q = this.activeCamera.quaternion
    let best: THREE.Vector3 | null = null
    let bestD = 0.45 * 0.45 // 距轴端投影 < 0.45 才命中（留出空白区误触保护）
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    for (const axis of axes) {
      for (const sign of [1, -1] as const) {
        const v = axis.clone().multiplyScalar(sign).applyQuaternion(q)
        const d = (v.x - nx) ** 2 + (v.y - ny) ** 2
        if (d < bestD) { bestD = d; best = axis.clone().multiplyScalar(sign) }
      }
    }
    return best
  }

  /** 设置罗盘 hover 轴（带符号单位向量；null = 移出）——驱动轴端发光反馈 */
  setGizmoHover(dir: THREE.Vector3 | null) {
    if (dir) {
      if (!this.gizmoHover) this.gizmoHover = dir.clone().normalize()
      else this.gizmoHover.copy(dir).normalize()
    } else {
      this.gizmoHover = null
    }
  }

  /** 沿轴方向对齐视角（点击指示器轴端）：保持目标点与距离，平滑过渡；|Y| 向用 Z 作 up 防退化 */
  orientAlongAxis(dir: THREE.Vector3, dur = 520) {
    const d = dir.clone().normalize()
    const target = this.controls.target.clone()
    const dist = Math.max(this.activeCamera.position.distanceTo(target), 1)
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
    const pos = target.clone().addScaledVector(d, dist)
    this.animateCameraTo({ pos: pos.toArray(), target: target.toArray(), up: up.toArray() }, dur)
  }

  // ---------- GTAO / 轮廓线后处理管线 ----------
  /** 懒建 EffectComposer（RenderPass → GTAOPass → EdgePass，EdgePass 内含色调映射上屏）；相机类型切换时重建；失败时安全降级 */
  private ensureComposer() {
    if (this.composer && this.composerCamera === this.activeCamera) return
    if (this.composer) this.disposeComposer()
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const pr = this.renderer.getPixelRatio()
    try {
      this.composer = new EffectComposer(this.renderer)
      this.composer.addPass(new RenderPass(this.scene, this.activeCamera))
      const gtao = new GTAOPass(this.scene, this.activeCamera, Math.round(w * pr), Math.round(h * pr))
      gtao.output = GTAOPass.OUTPUT.Default
      const s = this.settings
      gtao.blendIntensity = s?.ssaoIntensity ?? 1
      gtao.updateGtaoMaterial({
        radius: s?.ssaoRadius ?? 3,
        distanceExponent: 1,
        thickness: 1,
        scale: 1.25,
        samples: 16,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      })
      // 去噪参数（方法名为 updatePdMaterial，小写 d）
      gtao.updatePdMaterial({ radius: 8, radiusExponent: 2, samples: 16, rings: 2 })
      this.gtaoPass = gtao
      this.composer.addPass(gtao)
      // 架构注：不使用 OutputPass——链条为 RenderPass→GTAO→EdgePass，EdgePass 末位上屏时
      // 在 shader 内完成 ACES+sRGB（见 edge-shader.ts）。旧架构 OutputPass 需把 fsQuad 写回
      // 挂载 depth-stencil 纹理的 rt1，会触发 GL 反馈环（INVALID_OPERATION）并破坏颜色+深度，
      // 且写回后 rt1 双重身份（场景深度源 + 色调映射目标）在任何尺寸变更路径下都极脆弱。
      // 新架构下 RenderPass 之后任何 pass 都不再写 rt1：GTAO 写 rt2，EdgePass 直写屏幕。
      if (!this.edgeFailed) {
        try {
          const dt = new THREE.DepthTexture(Math.round(w * pr), Math.round(h * pr))
          dt.format = THREE.DepthStencilFormat
          dt.type = THREE.UnsignedInt248Type
          this.composer.renderTarget1.depthTexture = dt
          const edge = new ShaderPass(EdgeShader)
          edge.material.depthTest = false
          edge.material.depthWrite = false
          this.edgePass = edge
          this.composer.addPass(edge)
        } catch (e) {
          console.warn('[MolVision] 轮廓线后处理初始化失败，已回退', e)
          this.edgeFailed = true
          this.edgePass = null
          if (this.composer.renderTarget1.depthTexture) {
            this.composer.renderTarget1.depthTexture.dispose()
            this.composer.renderTarget1.depthTexture = null
          }
        }
      }
      this.composer.setPixelRatio(pr)
      this.composer.setSize(w, h)
      // 创建后立即对齐目标尺寸（分数 DPR 下浮点尺寸 → FBO 不完整，见 syncComposerTargets 注释）
      {
        const tw = Math.round(this.composer.renderTarget1.width)
        const th = Math.round(this.composer.renderTarget1.height)
        if (this.composer.renderTarget1.width !== tw || this.composer.renderTarget1.height !== th) {
          this.composer.renderTarget1.setSize(tw, th)
          this.composer.renderTarget2.setSize(tw, th)
          for (const pass of this.composer.passes) pass.setSize?.(tw, th)
        }
        const dt = this.composer.renderTarget1.depthTexture as THREE.DepthTexture | null | undefined
        if (dt && (dt.image.width !== tw || dt.image.height !== th)) {
          dt.image.width = tw
          dt.image.height = th
          dt.dispose()
        }
      }
      this.composerCamera = this.activeCamera
    } catch (e) {
      // 构建失败：清掉半成品，标记禁用并回退直接渲染（避免每帧异常循环）
      console.warn('[MolVision] GTAO 后处理初始化失败，已回退直接渲染', e)
      this.gtaoFailed = true
      this.disposeComposer()
    }
  }

  /** 每帧重置 composer 缓冲指到 rt1：RenderPass 固定渲染进 readBuffer（其 depthTexture 承载场景深度，供轮廓线采样） */
  private resetComposerBuffers() {
    const c = this.composer
    if (!c) return
    c.readBuffer = c.renderTarget1
    c.writeBuffer = c.renderTarget2
  }

  /** 深度纹理尺寸跟随 composer 目标（WebGLRenderTarget.setSize 不自动更新 depthTexture） */
  private syncDepthTextureSize(wPx: number, hPx: number) {
    const dt = this.composer?.renderTarget1.depthTexture as THREE.DepthTexture | null | undefined
    if (!dt) return
    if (dt.image.width !== wPx || dt.image.height !== hPx) {
      dt.image.width = wPx
      dt.image.height = hPx
      dt.dispose() // 触发 GPU 重新分配
    }
  }

  /**
   * 统一同步 composer 目标尺寸（FBO 完整性关键路径）：
   * EffectComposer.setSize 以 w×pr 浮点尺寸设置 rt1/rt2 —— WebGL texImage2D 会把颜色纹理截断为整，
   * 而 depthTexture 若按四舍五入对齐会差 1px → 帧缓冲不完整（GL_FRAMEBUFFER_INCOMPLETE）→
   * composer 全部绘制静默失败（屏幕只剩背景还原 + 陈旧边缘信号，即用户反馈的「灰白线稿」）。
   * 分数 DPR（1.25/1.5）或性能降级 0.6× 时必现。此处统一取整并强制 depthTexture 与 rt1 逐像素一致。
   */
  private syncComposerTargets(w: number, h: number, pr: number) {
    const c = this.composer
    if (!c) return
    c.setPixelRatio(pr)
    c.setSize(w, h)
    const tw = Math.round(c.renderTarget1.width)
    const th = Math.round(c.renderTarget1.height)
    if (c.renderTarget1.width !== tw || c.renderTarget1.height !== th) {
      c.renderTarget1.setSize(tw, th)
      c.renderTarget2.setSize(tw, th)
      for (const pass of c.passes) pass.setSize?.(tw, th)
    }
    const dt = c.renderTarget1.depthTexture as THREE.DepthTexture | null | undefined
    if (dt && (dt.image.width !== tw || dt.image.height !== th)) {
      dt.image.width = tw
      dt.image.height = th
      dt.dispose() // 触发 GPU 重新分配（FBO 重建时按新尺寸上传）
    }
  }

  /** 同步轮廓线 uniforms（分辨率/粗细/强度/相机深度范围/线色+背景色随背景亮度自适应/曝光）
   *  thicknessScale：粗细分辨率补偿（ray 超采样导出用，见 rayRender——WYSIWYG 语义） */
  private syncEdgePass(wPx: number, hPx: number, thicknessScale = 1) {
    const e = this.edgePass
    const s = this.settings
    if (!e || !s) return
    const u = (e.material as THREE.ShaderMaterial).uniforms
    u.uResolution.value.set(wPx, hPx)
    u.uOutlineOn.value = s.outline ? 1 : 0
    u.uThickness.value = s.outlineThickness * thicknessScale
    u.uStrength.value = s.outlineStrength
    u.tDepth.value = this.composer?.renderTarget1.depthTexture ?? null
    u.uBgColor.value.copy(srgbComponents(s.background))
    u.uExposure.value = this.renderer.toneMappingExposure
    // 线色：浅背景配深线 / 深背景配浅线（原始 sRGB 分量，pass 内不做色彩空间转换）
    u.uEdgeColor.value.copy(srgbComponents(isLightBackground(s.background) ? '#1f2933' : '#dfe7ee'))
    const cam = this.activeCamera
    if (cam === this.orthoCamera) {
      u.uIsOrtho.value = 1
      u.uNear.value = cam.near
      u.uFar.value = cam.far
    } else {
      u.uIsOrtho.value = 0
      u.uNear.value = (cam as THREE.PerspectiveCamera).near
      u.uFar.value = (cam as THREE.PerspectiveCamera).far
    }
  }

  private disposeComposer() {
    if (!this.composer) return
    const dt = this.composer.renderTarget1.depthTexture
    if (dt) { dt.dispose(); this.composer.renderTarget1.depthTexture = null }
    for (const pass of this.composer.passes) pass.dispose?.()
    this.composer.dispose()
    this.composer = null
    this.gtaoPass = null
    this.edgePass = null
    this.composerCamera = null
  }

  // ---------- 指针事件 ----------

  private ndcFromEvent(e: PointerEvent | MouseEvent) {
    const rect = this.canvas.getBoundingClientRect()
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.mouseClient = { x: e.clientX, y: e.clientY }
  }

  private onPointerMove = (e: PointerEvent) => {
    // 橡皮带拖拽中：更新覆盖框 + 回调悬停抑制（不旋转、不 hover）
    if (this.boxSelecting?.active) {
      this.boxSelecting.x1 = e.clientX
      this.boxSelecting.y1 = e.clientY
      this.updateRubberBand()
      return
    }
    this.ndcFromEvent(e)
    const now = performance.now()
    if (now - this.lastHoverTime < 40) return
    this.lastHoverTime = now
    const hit = this.pickAt(this.mouse)
    if (hit) {
      this.callbacks.onHover?.({
        structureId: hit.structureId,
        atomIdx: hit.atomIdx,
        residueIdx: hit.residueIdx,
        x: this.mouseClient.x,
        y: this.mouseClient.y,
      })
    } else {
      this.callbacks.onHover?.(null)
    }
  }

  private onPointerLeave = () => {
    this.callbacks.onHover?.(null)
  }

  private onPointerDown = (e: PointerEvent) => {
    this.downPos = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button }
    // PyMOL 橡皮带框选：Ctrl/Cmd + 左键拖拽 → 框选（不旋转相机；轨道控制同步禁用）
    if ((e.ctrlKey || e.metaKey) && e.button === 0) {
      this.boxSelecting = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, additive: e.shiftKey, subtractive: e.altKey, active: true }
      this.controls.enabled = false
      e.preventDefault()
      return
    }
    // 用户接管相机：取消书签过渡/巡航动画
    if (this.camAnim || this.camPath) this.camAnimCancelCount++
    this.camAnim = null
    this.camPath = null
    // rock 摇摆中用户拖动：以拖动后视角为新基准
    if (this.rockBase) this.rockBase = null
  }

  /** 滚轮缩放同样取消书签过渡/巡航（passive：不阻断 OrbitControls） */
  private onCancelCamAnim = () => {
    if (this.camAnim || this.camPath) this.camAnimCancelCount++
    this.camAnim = null
    this.camPath = null
  }

  /** movie 序列播放器用：用户中断相机动画的累计次数 */
  cameraCancelCount(): number {
    return this.camAnimCancelCount
  }

  private onPointerUp = (e: PointerEvent) => {
    // 橡皮带框选收尾：松手提交选择并清除覆盖层
    if (this.boxSelecting?.active) {
      const bs = this.boxSelecting
      this.boxSelecting = null
      this.clearRubberBand()
      this.controls.enabled = true
      const w = Math.abs(bs.x1 - bs.x0), h = Math.abs(bs.y1 - bs.y0)
      if (w > 8 && h > 8) {
        this.callbacks.onBoxSelect?.({
          x0: Math.min(bs.x0, bs.x1), y0: Math.min(bs.y0, bs.y1),
          x1: Math.max(bs.x0, bs.x1), y1: Math.max(bs.y0, bs.y1),
          additive: bs.additive, subtractive: bs.subtractive,
        })
      }
      return
    }
    const dx = e.clientX - this.downPos.x
    const dy = e.clientY - this.downPos.y
    const dt = performance.now() - this.downPos.t
    if (Math.hypot(dx, dy) > 6 || dt > 700) return
    if (e.button !== 0) return
    this.ndcFromEvent(e)
    const hit = this.pickAt(this.mouse)
    if (hit) {
      this.callbacks.onPick?.({
        ...hit,
        x: e.clientX,
        y: e.clientY,
        button: 0,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey || e.metaKey,
        metaKey: e.metaKey,
        doubleClick: false,
      }, false)
    } else {
      this.callbacks.onPick?.(null, true)
    }
  }

  private onDoubleClick = (e: MouseEvent) => {
    this.ndcFromEvent(e)
    const hit = this.pickAt(this.mouse)
    if (hit) {
      this.callbacks.onPick?.({
        ...hit,
        x: e.clientX, y: e.clientY, button: 0,
        shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        doubleClick: true,
      }, false)
    }
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    this.ndcFromEvent(e)
    const hit = this.pickAt(this.mouse)
    this.callbacks.onContext?.(hit ? { ...hit, x: e.clientX, y: e.clientY, button: 2, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, doubleClick: false } : null, e.clientX, e.clientY)
  }

  // ---------- 拾取 ----------

  private collectPickables() {
    if (this.pickablesCache) return this.pickablesCache
    const out: { obj: THREE.Object3D; pick: Pickable; structureId: string }[] = []
    for (const [id, view] of this.views) {
      if (!view.group.visible) continue
      for (const rv of view.reps.values()) {
        // r63-fix-c #1：rep 级可见性参与拾取——three Raycaster.intersect 不检查 visible，
        // 隐藏 rep 的网格若留在列表中仍可 hover/点选/框选（与 rayRender markShadowCasters 的写法对齐）
        if (!rv.build.group.visible) continue
        for (const p of rv.build.pickables) {
          if (p.mesh.visible !== false) out.push({ obj: p.mesh, pick: p, structureId: id })
        }
      }
    }
    this.pickablesCache = out
    return out
  }

  /** 橡皮带覆盖框 DOM 更新（拖拽中每 move 调用） */
  private updateRubberBand() {
    const bs = this.boxSelecting
    if (!bs?.active) return
    if (!this.rubberBandEl) {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;pointer-events:none;z-index:40;border:1.5px solid rgba(20,148,132,0.9);background:rgba(20,148,132,0.12);border-radius:3px;mix-blend-mode:normal;'
      document.body.appendChild(el)
      this.rubberBandEl = el
    }
    const rect = this.canvas.getBoundingClientRect()
    const x = Math.min(bs.x0, bs.x1) - rect.left
    const y = Math.min(bs.y0, bs.y1) - rect.top
    const w = Math.abs(bs.x1 - bs.x0), h = Math.abs(bs.y1 - bs.y0)
    const el = this.rubberBandEl
    el.style.display = 'block'
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.borderColor = bs.subtractive ? 'rgba(220,80,80,0.9)' : bs.additive ? 'rgba(60,140,220,0.9)' : 'rgba(20,148,132,0.9)'
    el.style.background = bs.subtractive ? 'rgba(220,80,80,0.10)' : bs.additive ? 'rgba(60,140,220,0.08)' : 'rgba(20,148,132,0.12)'
  }

  private clearRubberBand() {
    if (this.rubberBandEl) {
      this.rubberBandEl.remove()
      this.rubberBandEl = null
    }
  }

  /** 矩形框选拾取：返回框内可见原子（按各 rep 的拾取几何投影到屏幕像素判定） */
  pickInRect(px0: number, py0: number, px1: number, py1: number): { structureId: string; atomIdx: number }[] {
    const rect = this.canvas.getBoundingClientRect()
    const list = this.collectPickables()
    const out: { structureId: string; atomIdx: number }[] = []
    if (!list.length) return out
    // 相机矩阵（世界→屏幕像素）
    this.activeCamera.updateMatrixWorld()
    const projScreen = new THREE.Matrix4().multiplyMatrices(this.activeCamera.projectionMatrix, this.activeCamera.matrixWorldInverse)
    const v = new THREE.Vector3()
    for (const entry of list) {
      const data = dataRegistry.get(entry.structureId)
      if (!data) continue
      const { pick } = entry
      const pos = data.atoms.positions
      // 各 rep 可拾取的原子集：spheres/cylinders→atomMap；lines→lineAtomMap；cartoon/surface→残基代表原子
      let atomIdxs: Iterable<number>
      if (pick.kind === 'spheres' || pick.kind === 'cylinders') {
        atomIdxs = pick.atomMap ? Array.from(new Set(Array.from(pick.atomMap))) : []
      } else if (pick.kind === 'lines') {
        atomIdxs = pick.lineAtomMap ? Array.from(new Set(Array.from(pick.lineAtomMap))) : []
      } else {
        // cartoon/surface：按残基代表原子（CA 优先）判定——与点选语义一致
        const resSet = new Set<number>()
        const reps: number[] = []
        if (pick.kind === 'cartoon' && pick.resAttr) {
          const geo = (pick.mesh as THREE.Mesh).geometry
          const attr = geo.getAttribute(pick.resAttr)
          if (attr) for (let i = 0; i < attr.count; i++) resSet.add(Math.round(attr.getX(i)))
        }
        for (const ri of resSet) {
          const r = data.residues[ri]
          if (!r) continue
          let rep = r.start
          for (let i = r.start; i < r.end; i++) if (data.atoms.names[i] === 'CA') { rep = i; break }
          reps.push(rep)
        }
        atomIdxs = reps
      }
      for (const ai of atomIdxs) {
        v.set(pos[ai * 3], pos[ai * 3 + 1], pos[ai * 3 + 2])
        v.applyMatrix4(projScreen)
        if (v.z < -0.05 || v.z > 1) continue // 相机后方 / 裁剪外
        // px0..px1 是视口客户区坐标（clientX/clientY 同系）——先减 rect 原点再比对
        const sx = (v.x * 0.5 + 0.5) * rect.width
        const sy = (-v.y * 0.5 + 0.5) * rect.height
        if (sx >= px0 - rect.left && sx <= px1 - rect.left && sy >= py0 - rect.top && sy <= py1 - rect.top) out.push({ structureId: entry.structureId, atomIdx: ai })
      }
    }
    return out
  }

  private pickAt(ndc: THREE.Vector2): { structureId: string; atomIdx: number; residueIdx: number } | null {
    const list = this.collectPickables()
    if (!list.length) return null
    this.raycaster.setFromCamera(ndc, this.activeCamera)
    this.raycaster.params.Line = { threshold: 0.35 }
    const objs = list.map(l => l.obj)
    const hits = this.raycaster.intersectObjects(objs, false)
    for (const hit of hits) {
      const entry = list.find(l => l.obj === hit.object)
      if (!entry) continue
      const data = dataRegistry.get(entry.structureId)
      if (!data) continue
      const { pick } = entry
      if (pick.kind === 'spheres' || pick.kind === 'cylinders') {
        const iid = hit.instanceId
        if (iid === undefined || !pick.atomMap) continue
        const atomIdx = pick.atomMap[iid]
        if (atomIdx === undefined) continue
        return { structureId: entry.structureId, atomIdx, residueIdx: data.atomResidue[atomIdx] }
      }
      if (pick.kind === 'lines') {
        const vi = hit.index
        if (vi === undefined || !pick.lineAtomMap) continue
        const atomIdx = pick.lineAtomMap[vi]
        if (atomIdx === undefined) continue
        return { structureId: entry.structureId, atomIdx, residueIdx: data.atomResidue[atomIdx] }
      }
      if (pick.kind === 'cartoon') {
        const face = hit.face
        if (!face || !pick.resAttr) continue
        const geo = (hit.object as THREE.Mesh).geometry
        const attr = geo.getAttribute(pick.resAttr)
        if (!attr) continue
        const resIdx = Math.round(attr.getX(face.a))
        const r = data.residues[resIdx]
        if (!r) continue
        // 代表原子：CA 优先
        let rep = r.start
        for (let i = r.start; i < r.end; i++) if (data.atoms.names[i] === 'CA') { rep = i; break }
        return { structureId: entry.structureId, atomIdx: rep, residueIdx: resIdx }
      }
      if (pick.kind === 'surface') {
        const pt = hit.point
        const cand = data.grid.queryRadius(pt.x, pt.y, pt.z, 4.5, data.atoms.positions)
        if (!cand.length) continue
        let best = cand[0], bd = Infinity
        for (const c of cand) {
          const d = (data.atoms.positions[c * 3] - pt.x) ** 2 + (data.atoms.positions[c * 3 + 1] - pt.y) ** 2 + (data.atoms.positions[c * 3 + 2] - pt.z) ** 2
          if (d < bd) { bd = d; best = c }
        }
        return { structureId: entry.structureId, atomIdx: best, residueIdx: data.atomResidue[best] }
      }
    }
    return null
  }

  // ---------- 同步 ----------

  sync(state: {
    structures: StructureEntry[]
    activeId: string | null
    selection: { structureId: string | null; indices: number[]; rev: number }
    labels: AtomLabel[]
    measurements: Measurement[]
    measurePicks: { structureId: string; atoms: number[] } | null
    settings: Settings
    hbondScope: { structureId: string; indices: number[]; rev: number } | null
  }) {
    this.applySettings(state.settings)
    const filtersKey = `${state.settings.hideHydrogens}|${state.settings.hideWater}|${state.settings.quality}`

    const seen = new Set<string>()
    for (const entry of state.structures) {
      const data = dataRegistry.get(entry.id)
      if (!data) continue
      seen.add(entry.id)
      let view = this.views.get(entry.id)
      if (!view) {
        view = {
          group: new THREE.Group(),
          reps: new Map(),
          repContainer: new THREE.Group(),
          highlight: null,
          selectionRev: -1,
          labelGroup: new THREE.Group(),
          labelsKey: '',
          symKey: '',
        }
        view.group.add(view.repContainer)
        view.group.add(view.labelGroup)
        this.scene.add(view.group)
        this.views.set(entry.id, view)
      }
      // r59-a1 #1 修复：可见性翻转必须使拾取缓存失效（three Raycaster 不查 visible——
      // 旧版眼睛关闭后鼠标仍能命中不可见原子并触发 setActive 切换）
      if (view.group.visible !== entry.visible) this.pickablesCache = null
      view.group.visible = entry.visible
      // 重建变化的 rep
      const repIds = new Set(entry.reps.map(r => r.id))
      for (const [repId, rv] of view.reps) {
        if (!repIds.has(repId)) {
          view.repContainer.remove(rv.build.group)
          rv.build.dispose()
          view.reps.delete(repId)
          this.pickablesCache = null
        }
      }
      for (const rep of entry.reps) {
        const existing = view.reps.get(rep.id)
        if (existing) {
          const fullHash = JSON.stringify([rep, entry.rev, filtersKey])
          if (existing.hash === fullHash) continue
          // r59-a1 #7 修复：纯 rep.visible 翻转不重建几何（surface/cartoon 秒级重建代价）——
          // 剔除 visible 字段比对，一致则直接切 build.group.visible（不触发秒级重建）
          const repNoVis = JSON.stringify([{ ...rep, visible: 0 }, entry.rev, filtersKey]).replace('"visible":0', '"visible":X')
          const existNoVis = existing.hash.replace(/"visible":(?:true|false)/, '"visible":X')
          if (repNoVis === existNoVis) {
            if (existing.build.group.visible !== rep.visible) {
              existing.build.group.visible = rep.visible
              existing.hash = fullHash
              this.pickablesCache = null
            }
            continue
          }
        }
        const hash = JSON.stringify([rep, entry.rev, filtersKey])
        if (existing) {
          view.repContainer.remove(existing.build.group)
          existing.build.dispose()
          view.reps.delete(rep.id)
        }
        this.buildRep(entry, rep, data, view, state.settings, filtersKey)
      }
      // 高亮
      if (state.selection.structureId === entry.id && state.selection.rev !== view.selectionRev) {
        view.selectionRev = state.selection.rev
        this.updateHighlight(view, data, state.selection.indices)
      } else if (state.selection.structureId !== entry.id && view.highlight) {
        view.highlight.visible = false
      }
      // 对称伴侣（symmetry 命令/面板）：rep 构建完成后再检查（恢复会话时 reps 晚于 updateSymmetry 就绪）
      const symRadius = entry.symmetry?.radius ?? 0
      const symGroup = this.symmetryGroups.get(entry.id)
      if (symRadius > 0) {
        const wantKey = `${entry.rev}|${entry.reps.map(r => r.id + (r.visible ? '1' : '0')).join(',')}|${symRadius}|${filtersKey}`
        if (!symGroup || symGroup.userData.symKey !== wantKey) {
          this.rebuildSymmetry(entry, data, view, wantKey, symRadius)
        }
      } else if (symGroup) {
        view.group.remove(symGroup)
        this.symmetryGroups.delete(entry.id)
        this.pickablesCache = null
      }
    }
    // 移除消失的结构
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        // 若移除的结构正在播放 ensemble，先停止（坐标停在最后一帧→统一失效派生缓存；
        // flush 持 data 引用，结构已出 registry 也能重建，撤销关闭快照拿到的是一致的 grid）
        if (useEnsembleStore.getState().structureId === id) {
          this.ensemblePlay = null
          this.flushEnsembleCaches()
          const es = useEnsembleStore.getState()
          es.setPlaying(false)
          es.setTarget(null, 0)
        }
        this.scene.remove(view.group)
        for (const rv of view.reps.values()) rv.build.dispose()
        if (view.highlight) { view.highlight.geometry.dispose(); (view.highlight.material as THREE.Material).dispose() }
        this.views.delete(id)
        this.symmetryGroups.delete(id)
        this.hbondCache.delete(id)
        this.hbondPending.delete(id)
        this.sasaPending.delete(id)
        if (this.pendingSasaBake === id) this.pendingSasaBake = null
        // SASA 结果归属结构被移除 → 清空面板数据
        const ss = useSasaStore.getState()
        if (ss.structureId === id || ss.buried?.structureId === id) ss.clear()
        this.pickablesCache = null
        // 接触分析归属结构被移除 → 清空连线与结果
        const cs = useContactStore.getState()
        if (cs.structureId === id || cs.cross?.idA === id || cs.cross?.idB === id) {
          cs.clear()
          this.updateContacts()
        }
        // 孔道剖面归属结构被移除 → 清空环带与剖面卡
        if (usePoreStore.getState().result?.structureId === id) {
          usePoreStore.getState().clear()
          this.updatePore()
        }
      }
    }
    // 晶胞盒（show cell）
    this.updateCellBox(state)
    // 脂双层板（membrane 命令：键控重建）
    this.updateMembrane(state)
    // 标签
    const labelsKey = state.labels.map(l => l.id + l.atomIdx).join(',') + '#' + state.labels.length
    if (labelsKey !== this.lastLabelsKey) {
      this.lastLabelsKey = labelsKey
      this.updateLabels(state.labels)
    }
    // 测量
    const measureKey = state.measurements.map(m => m.id).join(',') + '#' + state.measurements.length
    if (measureKey !== this.lastMeasureKey) {
      this.lastMeasureKey = measureKey
      this.updateMeasurements(state.measurements)
    }
    const picksKey = state.measurePicks ? state.measurePicks.structureId + state.measurePicks.atoms.join(',') : ''
    if (picksKey !== this.lastPicksKey) {
      this.lastPicksKey = picksKey
      this.updatePickMarkers(state.measurePicks)
    }
    // 氢键网络（key 含背景色：氢键颜色随背景亮度自适应需重渲）
    const hbondKey = [
      state.settings.showHBonds, state.settings.hbondMaxDist, state.settings.hbondIncludeWater,
      state.settings.hbondSelOnly, state.settings.hideWater, state.settings.background,
      state.structures.filter(s => s.visible).map(s => s.id).join('|'),
      // r59-a1 #2 修复：链显隐签名（isolate / chains hide 后虚线重渲——旧版悬空指向已隐藏链原子）
      state.structures.map(s => `${s.id}:${(s.hiddenChains ?? []).join(',')}`).join('|'),
      state.selection.structureId, state.selection.rev,
      state.hbondScope ? state.hbondScope.structureId + ':' + state.hbondScope.rev : '-',
    ].join('#')
    if (hbondKey !== this.lastHbondKey) {
      this.lastHbondKey = hbondKey
      this.updateHBonds(state)
    }
    this.hasContent = this.views.size > 0
  }

  /** 氢键网络检测与虚线渲染（大结构经 Web Worker 异步）；全局网络仅虚线，
   *  端点球仅选择集范围（hbondSelOnly）时显示 */
  private updateHBonds(state: Parameters<MolEngine['sync']>[0]) {
    this.lastHbondState = state
    // 清空旧渲染
    for (const child of [...this.hbondGroup.children]) {
      this.hbondGroup.remove(child)
      const any = child as THREE.LineSegments & THREE.Mesh
      any.geometry?.dispose()
      const mat = any.material as THREE.Material | THREE.Material[] | undefined
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(m => m.dispose())
    }
    const s = state.settings
    if (!s.showHBonds) {
      this.hbondPending.clear()
      useHBondStore.getState().setStats(0, 0, false)
      useHBondStore.getState().setComputing(false)
      useHBondStore.getState().setPairs([])
      return
    }
    let total = 0, waterTotal = 0
    // 活动结构的残基对汇总（分析面板表格）
    const activeId = useMolStore.getState().activeId
    const pairMap = new Map<string, { donorRes: number; acceptorRes: number; minDist: number; count: number }>()
    for (const entry of state.structures) {
      if (!entry.visible) continue
      const data = dataRegistry.get(entry.id)
      if (!data) continue
      // 检测缓存
      const detKey = `${s.hbondMaxDist}|${s.hbondIncludeWater}|${entry.rev}`
      let hbonds: HBond[] | null = null
      const cached = this.hbondCache.get(entry.id)
      if (cached && cached.key === detKey) {
        hbonds = cached.hbonds
      } else if (data.atoms.count >= HBOND_WORKER_MIN_ATOMS && this.requestHBondDetect(entry.id, detKey, data, s)) {
        // 已投递 worker 异步检测：本轮先跳过，结果到达后重渲
        hbonds = null
      } else {
        const detected = detectHBonds(data, {
          maxHeavyDist: s.hbondMaxDist,
          maxDist: Math.min(2.5, s.hbondMaxDist - 1),
          includeWater: s.hbondIncludeWater,
        })
        this.hbondCache.set(entry.id, { key: detKey, hbonds: detected })
        hbonds = detected
      }
      if (!hbonds) continue
      // 范围过滤优先级：hbondScope（hbonds in <表达式> 烘焙，不随 deselect 清除）>
      // 仅选择集模式（实时跟随 selection）> 全结构网络。虚线与端点球同范围。
      let scoped = false
      const baked = state.hbondScope
      if (baked && baked.structureId === entry.id && baked.indices.length > 0) {
        const scope = new Set(baked.indices)
        hbonds = hbonds.filter(hb => scope.has(hb.donor) || scope.has(hb.acceptor))
        scoped = true
      } else if (baked && baked.structureId === entry.id) {
        continue // 结构被点名但范围空（清除中的过渡态）
      } else if (s.hbondSelOnly) {
        if (state.selection.structureId !== entry.id || !state.selection.indices.length) continue
        const sel = new Set(state.selection.indices)
        hbonds = hbonds.filter(hb => sel.has(hb.donor) || sel.has(hb.acceptor))
        scoped = true
      }
      // 链隔离（isolate / chains hide）：端点落在隐藏链组的氢键不渲染——虚线不得悬空指向已隐藏原子
      if (entry.hiddenChains?.length && hbonds.length) {
        const hiddenGroups = new Set(entry.hiddenChains)
        const cg = atomChainGroups(data)
        hbonds = hbonds.filter(hb => !hiddenGroups.has(cg[hb.donor]) && !hiddenGroups.has(cg[hb.acceptor]))
      }
      if (!hbonds.length) {
        continue
      }
      // 上限保护
      const CAP = 8000
      const truncated = hbonds.length > CAP
      const draw = truncated ? hbonds.slice(0, CAP) : hbonds
      // 虚线几何：H...A 或 D...A（颜色随背景亮度自适应保证对比度）
      const hbColor = isLightBackground(s.background) ? HBOND_COLOR_LIGHT : HBOND_COLOR_DARK
      const pos = data.atoms.positions
      const verts: number[] = []
      const endPts: number[] = []
      let waterN = 0
      for (const hb of draw) {
        const from = hb.hydrogen >= 0 ? hb.hydrogen : hb.donor
        verts.push(pos[from * 3], pos[from * 3 + 1], pos[from * 3 + 2])
        verts.push(pos[hb.acceptor * 3], pos[hb.acceptor * 3 + 1], pos[hb.acceptor * 3 + 2])
        endPts.push(from, hb.acceptor)
        if (data.residues[data.atomResidue[hb.donor]].water || data.residues[data.atomResidue[hb.acceptor]].water) waterN++
      }
      // 残基对汇总（仅活动结构——表格与选择/聚焦联动）
      if (entry.id === activeId) {
        for (const hb of draw) {
          const dr = data.atomResidue[hb.donor]
          const ar = data.atomResidue[hb.acceptor]
          const key = `${dr}:${ar}`
          const agg = pairMap.get(key)
          if (agg) {
            if (hb.dist < agg.minDist) agg.minDist = hb.dist
            agg.count++
          } else {
            pairMap.set(key, { donorRes: dr, acceptorRes: ar, minDist: hb.dist, count: 1 })
          }
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      const mat = new THREE.LineDashedMaterial({
        color: hbColor,
        dashSize: 0.3,
        gapSize: 0.22,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(geo, mat)
      lines.computeLineDistances()
      lines.renderOrder = 8
      this.hbondGroup.add(lines)
      // 端点小标记（InstancedMesh）：仅范围模式（scope 烘焙或选择集）时显示——全局网络的虚线自身已可追溯，
      // 端点球只会加重视觉重量（用户反馈「绿球堆」）；局部分析时球帮助定位两端原子
      if (scoped && endPts.length > 0) {
        const sphereGeo = new THREE.SphereGeometry(0.12, 8, 6)
        const sphereMat = new THREE.MeshBasicMaterial({ color: hbColor, transparent: true, opacity: 0.5, depthWrite: false })
        const marker = new THREE.InstancedMesh(sphereGeo, sphereMat, endPts.length)
        const m4 = new THREE.Matrix4()
        for (let k = 0; k < endPts.length; k++) {
          const i = endPts[k]
          m4.makeTranslation(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
          marker.setMatrixAt(k, m4)
        }
        marker.instanceMatrix.needsUpdate = true
        marker.renderOrder = 9
        this.hbondGroup.add(marker)
      }
      total += draw.length
      waterTotal += waterN
      if (truncated) useMolStore.getState().appendLog('out', tt({ zh: `氢键数量超过 ${CAP}，已截断显示（共 ${hbonds.length}）`, en: `More than ${CAP} H-bonds — display truncated (${hbonds.length} total)` }))
    }
    useHBondStore.getState().setStats(total, waterTotal, true)
    useHBondStore.getState().setComputing(this.hbondPending.size > 0)
    // 距离最近优先，上限 300 行（表格可用性保护）
    const pairs: HBondPairSummary[] = activeId
      ? [...pairMap.values()]
        .sort((a, b) => a.minDist - b.minDist)
        .slice(0, 300)
        .map(p => ({ ...p, structureId: activeId }))
      : []
    useHBondStore.getState().setPairs(pairs)
  }

  // ---------- 接触界面连线（分析面板触发计算，此处渲染） ----------

  /** 接触上限保护（连线渲染用；检测本身不受限） */
  private static readonly CONTACT_CAP = 4000

  /** 渲染/清除接触连线（颜色按距离插值：近红远琥珀；支持跨结构两套坐标） */
  updateContacts() {
    // 清空旧渲染
    for (const child of [...this.contactGroup.children]) {
      this.contactGroup.remove(child)
      const any = child as THREE.LineSegments & THREE.Mesh
      any.geometry?.dispose()
      const mat = any.material as THREE.Material | THREE.Material[] | undefined
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(m => m.dispose())
    }
    const cs = useContactStore.getState()
    if (!cs.visible) return

    // ---------- 跨结构模式：连线端点取自两个结构各自的坐标 ----------
    if (cs.cross && cs.crossPairs.length) {
      const dataA = dataRegistry.get(cs.cross.idA)
      const dataB = dataRegistry.get(cs.cross.idB)
      if (!dataA || !dataB) return
      const posA = dataA.atoms.positions
      const posB = dataB.atoms.positions
      const draw = cs.crossPairs.length > MolEngine.CONTACT_CAP ? cs.crossPairs.slice(0, MolEngine.CONTACT_CAP) : cs.crossPairs
      if (cs.crossPairs.length > MolEngine.CONTACT_CAP) {
        useMolStore.getState().appendLog('out', tt({ zh: `接触连线超过 ${MolEngine.CONTACT_CAP}，仅渲染最近的 ${MolEngine.CONTACT_CAP} 条（共 ${cs.crossPairs.length} 对）`, en: `More than ${MolEngine.CONTACT_CAP} contact lines — only the nearest ${MolEngine.CONTACT_CAP} rendered (${cs.crossPairs.length} pairs total)` }))
      }
      const verts = new Float32Array(draw.length * 6)
      const cols = new Float32Array(draw.length * 6)
      const endPts: { pos: [number, number, number] }[] = []
      const endCols: number[] = []
      const range = Math.max(0.5, cs.cross.cutoff - 2.5)
      for (let k = 0; k < draw.length; k++) {
        const p = draw[k]
        verts[k * 6] = posA[p.atomA * 3]
        verts[k * 6 + 1] = posA[p.atomA * 3 + 1]
        verts[k * 6 + 2] = posA[p.atomA * 3 + 2]
        verts[k * 6 + 3] = posB[p.atomB * 3]
        verts[k * 6 + 4] = posB[p.atomB * 3 + 1]
        verts[k * 6 + 5] = posB[p.atomB * 3 + 2]
        const t = (p.minDist - 2.5) / range
        const [r, g, b] = contactColor(t)
        for (let v = 0; v < 2; v++) {
          cols[k * 6 + v * 3] = r
          cols[k * 6 + v * 3 + 1] = g
          cols[k * 6 + v * 3 + 2] = b
        }
        endPts.push(
          { pos: [posA[p.atomA * 3], posA[p.atomA * 3 + 1], posA[p.atomA * 3 + 2]] },
          { pos: [posB[p.atomB * 3], posB[p.atomB * 3 + 1], posB[p.atomB * 3 + 2]] },
        )
        endCols.push(r, g, b, r, g, b)
      }
      this.buildContactGeometry(verts, cols, endPts, endCols)
      return
    }

    // ---------- 单结构模式 ----------
    if (!cs.structureId || !cs.pairs.length) return
    const data = dataRegistry.get(cs.structureId)
    if (!data) return
    const pos = data.atoms.positions
    const draw = cs.pairs.length > MolEngine.CONTACT_CAP ? cs.pairs.slice(0, MolEngine.CONTACT_CAP) : cs.pairs
    if (cs.pairs.length > MolEngine.CONTACT_CAP) {
      useMolStore.getState().appendLog('out', tt({ zh: `接触连线超过 ${MolEngine.CONTACT_CAP}，仅渲染最近的 ${MolEngine.CONTACT_CAP} 条（共 ${cs.pairs.length} 对）`, en: `More than ${MolEngine.CONTACT_CAP} contact lines — only the nearest ${MolEngine.CONTACT_CAP} rendered (${cs.pairs.length} pairs total)` }))
    }
    // 顶点色连线（近距离红 → 远距离琥珀）
    const verts = new Float32Array(draw.length * 6)
    const cols = new Float32Array(draw.length * 6)
    const endPts: number[] = []
    const endCols: number[] = []
    const range = Math.max(0.5, cs.cutoff - 2.5)
    for (let k = 0; k < draw.length; k++) {
      const p = draw[k]
      verts[k * 6] = pos[p.atomA * 3]
      verts[k * 6 + 1] = pos[p.atomA * 3 + 1]
      verts[k * 6 + 2] = pos[p.atomA * 3 + 2]
      verts[k * 6 + 3] = pos[p.atomB * 3]
      verts[k * 6 + 4] = pos[p.atomB * 3 + 1]
      verts[k * 6 + 5] = pos[p.atomB * 3 + 2]
      const t = (p.minDist - 2.5) / range
      const [r, g, b] = contactColor(t)
      for (let v = 0; v < 2; v++) {
        cols[k * 6 + v * 3] = r
        cols[k * 6 + v * 3 + 1] = g
        cols[k * 6 + v * 3 + 2] = b
      }
      endPts.push(p.atomA, p.atomB)
      endCols.push(r, g, b, r, g, b)
    }
    this.buildContactGeometry(verts, cols, endPts.map(i => ({ pos: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as [number, number, number] })), endCols)
  }

  /** 组装接触连线 + 端点标记（两种模式共用）——虚线（出版惯例：互作用以虚线标示） */
  private buildContactGeometry(verts: Float32Array, cols: Float32Array, endPts: { pos: [number, number, number] }[], endCols: number[]) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3))
    // 虚线：dash/gap 以 Å 计（0.6/0.4 在口袋特写下呈清晰刻度虚线）
    const mat = new THREE.LineDashedMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      dashSize: 0.6,
      gapSize: 0.4,
    })
    const lines = new THREE.LineSegments(geo, mat)
    lines.computeLineDistances() // LineSegments 逐段计算（每段独立起算）
    lines.renderOrder = 7
    this.contactGroup.add(lines)
    // 端点小标记（按各自连线颜色着色）
    const sphereGeo = new THREE.SphereGeometry(0.2, 8, 6)
    const sphereMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false })
    const marker = new THREE.InstancedMesh(sphereGeo, sphereMat, endPts.length)
    const m4 = new THREE.Matrix4()
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(endCols), 3)
    for (let k = 0; k < endPts.length; k++) {
      m4.makeTranslation(endPts[k].pos[0], endPts[k].pos[1], endPts[k].pos[2])
      marker.setMatrixAt(k, m4)
    }
    marker.instanceMatrix.needsUpdate = true
    marker.instanceColor = colorAttr
    colorAttr.needsUpdate = true
    marker.renderOrder = 9
    this.contactGroup.add(marker)
  }

  // ---------- 孔道剖面环带 + 脂双层板（r72：计算在 pore.ts，引擎仅渲染） ----------

  /** 清空组（几何/材质逐一释放，与 updateContacts 同模式） */
  private clearGroupChildren(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child)
      const any = child as THREE.LineSegments & THREE.Mesh
      any.geometry?.dispose()
      const mat = any.material as THREE.Material | THREE.Material[] | undefined
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(m => m.dispose())
    }
  }

  /**
   * 孔道剖面环带（HOLE 式）：全部采样环合并为单 LineSegments（顶点色：红=过窄/
   * 绿=可过/蓝=宽敞，一次 draw call）+ 轴向虚线 + 收缩点细环面（Torus 突出标记）。
   * depthTest 保持开启——环带被蛋白前壁遮挡的半侧自然不可见，产生「嵌在孔内」的真实感。
   */
  updatePore() {
    this.clearGroupChildren(this.poreGroup)
    const ps = usePoreStore.getState()
    if (!ps.result || !ps.visible) return
    const { origin, dir, samples, maxR, constriction, tMin, tMax } = ps.result
    // 正交标架：u ⟂ v ⟂ dir（环所在平面）
    const d = new THREE.Vector3(dir[0], dir[1], dir[2])
    const up = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const u = new THREE.Vector3().crossVectors(d, up).normalize()
    const v = new THREE.Vector3().crossVectors(d, u).normalize()
    const SEG = 48
    const verts: number[] = []
    const cols: number[] = []
    const tmp = new THREE.Color()
    for (const s of samples) {
      const rr = Math.max(0.05, Math.min(s.r, maxR))
      tmp.set(poreZoneColor(s.r))
      const cx = origin[0] + dir[0] * s.t
      const cy = origin[1] + dir[1] * s.t
      const cz = origin[2] + dir[2] * s.t
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2
        const a1 = ((k + 1) / SEG) * Math.PI * 2
        verts.push(
          cx + (u.x * Math.cos(a0) + v.x * Math.sin(a0)) * rr,
          cy + (u.y * Math.cos(a0) + v.y * Math.sin(a0)) * rr,
          cz + (u.z * Math.cos(a0) + v.z * Math.sin(a0)) * rr,
          cx + (u.x * Math.cos(a1) + v.x * Math.sin(a1)) * rr,
          cy + (u.y * Math.cos(a1) + v.y * Math.sin(a1)) * rr,
          cz + (u.z * Math.cos(a1) + v.z * Math.sin(a1)) * rr,
        )
        cols.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b)
      }
    }
    const ringGeo = new THREE.BufferGeometry()
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    ringGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3))
    const ringMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false })
    const rings = new THREE.LineSegments(ringGeo, ringMat)
    rings.renderOrder = 8
    this.poreGroup.add(rings)
    // 通道主轴虚线（两端外延 6Å）
    const axGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(origin[0] + dir[0] * (tMin - 6), origin[1] + dir[1] * (tMin - 6), origin[2] + dir[2] * (tMin - 6)),
      new THREE.Vector3(origin[0] + dir[0] * (tMax + 6), origin[1] + dir[1] * (tMax + 6), origin[2] + dir[2] * (tMax + 6)),
    ])
    const axMat = new THREE.LineDashedMaterial({ color: 0x64748b, transparent: true, opacity: 0.6, dashSize: 1.2, gapSize: 0.8 })
    const axis = new THREE.Line(axGeo, axMat)
    axis.computeLineDistances()
    axis.renderOrder = 8
    this.poreGroup.add(axis)
    // 收缩点细环面（Torus：半径过小时抬到 0.4 保可见；红色强调）
    const rc = Math.max(constriction.r, 0.4)
    const torGeo = new THREE.TorusGeometry(rc, 0.16, 10, 64)
    const torMat = new THREE.MeshBasicMaterial({ color: 0xdc2626, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })
    const torus = new THREE.Mesh(torGeo, torMat)
    torus.position.set(origin[0] + dir[0] * constriction.t, origin[1] + dir[1] * constriction.t, origin[2] + dir[2] * constriction.t)
    torus.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d)
    torus.renderOrder = 8
    this.poreGroup.add(torus)
  }

  /**
   * 脂双层示意板（membrane 命令）：VMD/ChimeraX 惯例——磷脂头基双橙板 + 疏水核心灰板，
   * 沿活动结构主轴（通道轴）定向，中心取蛋白沿轴中点，平面尺寸贴合蛋白投影包围盒 +8Å。
   * 键控重建（settings/活动结构/结构 rev 变化才重建），与晶胞盒同模式。
   */
  private updateMembrane(state: { structures: StructureEntry[]; activeId: string | null; settings: Settings }) {
    const active = state.structures.find(x => x.id === state.activeId)
    const key = state.settings.showMembrane && active
      ? `on|${state.settings.membraneThickness}|${state.activeId}|${active.rev}`
      : 'off'
    if (key === this.membraneKey) return
    this.membraneKey = key
    this.clearGroupChildren(this.membraneGroup)
    if (!state.settings.showMembrane || !active) return
    const data = dataRegistry.get(state.activeId!)
    if (!data) { this.membraneKey = 'off'; return }
    const { origin, dir } = principalAxis(data)
    const n = new THREE.Vector3(dir[0], dir[1], dir[2])
    const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const u = new THREE.Vector3().crossVectors(n, up).normalize()
    const v = new THREE.Vector3().crossVectors(n, u).normalize()
    // 聚合物原子在 (n, u, v) 标架下的范围（膜几何由蛋白壁决定）
    const pos = data.atoms.positions
    const residues = data.residues
    let tLo = Infinity, tHi = -Infinity, uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity
    for (let ri = 0; ri < residues.length; ri++) {
      const r = residues[ri]
      if (!r.polymer || r.water) continue
      for (let i = r.start; i < r.end; i++) {
        const dx = pos[i * 3] - origin[0], dy = pos[i * 3 + 1] - origin[1], dz = pos[i * 3 + 2] - origin[2]
        const tn = dx * n.x + dy * n.y + dz * n.z
        const tu = dx * u.x + dy * u.y + dz * u.z
        const tv = dx * v.x + dy * v.y + dz * v.z
        if (tn < tLo) tLo = tn
        if (tn > tHi) tHi = tn
        if (tu < uLo) uLo = tu
        if (tu > uHi) uHi = tu
        if (tv < vLo) vLo = tv
        if (tv > vHi) vHi = tv
      }
    }
    const pad = 8
    const w = (uHi - uLo) + pad * 2
    const h = (vHi - vLo) + pad * 2
    const tc = (tLo + tHi) / 2
    const T = state.settings.membraneThickness
    const HEAD = 4
    const center = new THREE.Vector3(origin[0] + n.x * tc, origin[1] + n.y * tc, origin[2] + n.z * tc)
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
    const mk = (thickness: number, offset: number, color: string, opacity: number, order: number, edge?: string) => {
      const geo = new THREE.BoxGeometry(w, h, thickness)
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.copy(center).addScaledVector(n, offset)
      mesh.quaternion.copy(quat)
      mesh.renderOrder = order
      this.membraneGroup.add(mesh)
      if (edge) {
        const eg = new THREE.EdgesGeometry(geo)
        const em = new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.55 })
        const wire = new THREE.LineSegments(eg, em)
        wire.position.copy(mesh.position)
        wire.quaternion.copy(quat)
        wire.renderOrder = order
        this.membraneGroup.add(wire)
      }
    }
    // 疏水核心（灰蓝薄雾）+ 头基双板（橙，VMD 惯例）+ 头基描边
    mk(T - HEAD * 2, 0, '#8b98a8', 0.13, 2)
    mk(HEAD, +(T / 2 - HEAD / 2), '#e0913c', 0.42, 3, '#b4772f')
    mk(HEAD, -(T / 2 - HEAD / 2), '#e0913c', 0.42, 3, '#b4772f')
  }

  // ---------- 氢键 Web Worker ----------

  /** 懒建 worker（构造失败则永久回退同步检测） */
  private ensureHBondWorker(): Worker | null {
    if (this.hbondWorkerFailed) return null
    if (this.hbondWorker) return this.hbondWorker
    try {
      const w = new Worker(new URL('./hbond-worker.ts', import.meta.url))
      w.onmessage = (e: MessageEvent) => this.onHBondWorkerResult(e.data)
      w.onerror = () => {
        // worker 异常：标记失败并回退同步路径
        this.hbondWorkerFailed = true
        this.hbondPending.clear()
        this.hbondSlots.releaseAll()
        useHBondStore.getState().setComputing(false)
      }
      this.hbondWorker = w
      return w
    } catch {
      this.hbondWorkerFailed = true
      return null
    }
  }

  /** 投递异步检测（同 key 在飞行中则去重）；返回是否成功投递（排队中视为已投递） */
  private requestHBondDetect(structureId: string, detKey: string, data: StructureData, s: Settings): boolean {
    if (this.hbondPending.get(structureId) === detKey) return true // 同一请求在飞行中 → 视为已投递
    const w = this.ensureHBondWorker()
    if (!w) return false
    const a = data.atoms
    const n = a.count
    // 预编译元素标志（避免传字符串数组）
    const heteroFlag = new Uint8Array(n)
    const isHydrogen = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const e = a.elements[i]
      if (e === 'N' || e === 'O' || e === 'S') heteroFlag[i] = 1
      else if (e === 'H' || e === 'D') isHydrogen[i] = 1
    }
    const resWater = new Uint8Array(data.residues.length)
    for (let r = 0; r < data.residues.length; r++) resWater[r] = data.residues[r].water ? 1 : 0
    const reqId = ++this.hbondReqId
    this.hbondPending.set(structureId, detKey)
    // 并发闸：槽位空出后再投递（排队期间设置又变 → 过期丢弃）
    void this.hbondSlots.acquire(tt({ zh: '氢键检测', en: 'H-bond detection' })).then(release => {
      if (this.hbondPending.get(structureId) !== detKey) { release(); return }
      this.hbondSlots.post(release)
      w.postMessage({
        type: 'detect',
        reqId,
        structureId,
        key: detKey,
        positions: a.positions,
        heteroFlag,
        isHydrogen,
        atomResidue: data.atomResidue,
        resWater,
        bondA: data.bonds.a,
        bondB: data.bonds.b,
        hasH: data.hasHydrogens,
        maxDist: Math.min(2.5, s.hbondMaxDist - 1),
        maxHeavyDist: s.hbondMaxDist,
        minAngle: 120,
        includeWater: s.hbondIncludeWater,
      })
    })
    return true
  }

  /** worker 结果：写入缓存并重渲氢键视觉 */
  private onHBondWorkerResult(msg: {
    type: string
    reqId: number
    structureId: string
    key: string
    count: number
    triplets: Int32Array
    values: Float32Array
  }) {
    if (!msg || msg.type !== 'result') return
    this.hbondSlots.releaseOne() // 并发闸：一条结果释放一个槽（过期结果同样占用过槽）
    // 过期结果（设置已变 → 新 key 已投递）：丢弃
    if (this.hbondPending.get(msg.structureId) !== msg.key) return
    this.hbondPending.delete(msg.structureId)
    const hbonds: HBond[] = []
    for (let i = 0; i < msg.count; i++) {
      hbonds.push({
        donor: msg.triplets[i * 3],
        hydrogen: msg.triplets[i * 3 + 1],
        acceptor: msg.triplets[i * 3 + 2],
        dist: msg.values[i * 2],
        angle: msg.values[i * 2 + 1],
      })
    }
    this.hbondCache.set(msg.structureId, { key: msg.key, hbonds })
    // 用最近一次 state 重渲（异步完成时 sync 不一定会再触发）
    if (this.lastHbondState && this.settings?.showHBonds) {
      this.updateHBonds(this.lastHbondState)
    } else {
      useHBondStore.getState().setComputing(this.hbondPending.size > 0)
    }
  }

  // ---------- NMR ensemble 多构象动画 ----------

  /** 开始播放 ensemble（结构必须有 ensemble 数据） */
  playEnsemble(structureId: string) {
    const data = dataRegistry.get(structureId)
    if (!data?.ensemble || data.ensemble.frames.length < 2) return
    const es = useEnsembleStore.getState()
    this.ensemblePlay = { frame: this.ensemblePlay?.frame ?? es.frame, lastT: performance.now() }
    es.setPlaying(true)
  }

  pauseEnsemble() {
    this.ensemblePlay = null
    useEnsembleStore.getState().setPlaying(false)
    // 播放→停止状态切换点：坐标已定格在最后一帧，一次性重建派生缓存（r63-review-a P2-8）
    this.flushEnsembleCaches()
  }

  /** 跳到指定整数帧（暂停状态下拖动滑块） */
  setEnsembleFrame(structureId: string, frame: number) {
    const data = dataRegistry.get(structureId)
    if (!data?.ensemble) return
    const f = Math.max(0, Math.min(frame, data.ensemble.frames.length - 1))
    this.ensemblePlay = null
    useEnsembleStore.getState().setPlaying(false)
    this.applyEnsembleFrame(data, f, true)
    useEnsembleStore.getState().setFrame(f)
  }

  /** 重置到第 1 帧并刷新几何 */
  resetEnsemble(structureId: string) {
    const data = dataRegistry.get(structureId)
    if (!data?.ensemble) return
    this.ensemblePlay = null
    const es = useEnsembleStore.getState()
    es.setPlaying(false)
    this.applyEnsembleFrame(data, 0, true)
    es.setFrame(0)
  }

  /** 渲染循环驱动：推进插值帧并重建几何 */
  private updateEnsemble() {
    const es = useEnsembleStore.getState()
    if (!es.playing || !es.structureId) return
    const data = dataRegistry.get(es.structureId)
    if (!data?.ensemble) { this.pauseEnsemble(); return }
    if (!this.ensemblePlay) this.ensemblePlay = { frame: es.frame, lastT: performance.now() }
    const ep = this.ensemblePlay
    const now = performance.now()
    const dt = Math.min((now - ep.lastT) / 1000, 0.12)
    ep.lastT = now
    const frames = data.ensemble.frames.length
    ep.frame += dt * es.fps
    if (ep.frame >= frames) {
      if (es.loop) ep.frame %= frames
      else {
        ep.frame = frames - 1
        // 自然播完落末帧：写坐标后立即失效派生缓存（后续 rebuild 即用新 grid），
        // pauseEnsemble 内的 flush 因脏标记已清而为 no-op
        this.applyEnsembleFrame(data, ep.frame, true)
        const store = useEnsembleStore.getState()
        store.setFrame(Math.floor(ep.frame))
        this.pauseEnsemble()
        return
      }
    }
    this.applyEnsembleFrame(data, ep.frame)
    // 节流同步 UI 帧号（避免 60Hz 全量 React 更新）
    if (Math.abs(Math.floor(ep.frame) - useEnsembleStore.getState().frame) >= 1) {
      useEnsembleStore.getState().setFrame(Math.floor(ep.frame))
    }
  }

  /** 应用帧（含插值）到原子坐标并增量重建该结构全部视图。
 *  invalidate=true（seek/reset/播完落帧等“坐标落定点”）在写坐标后、重建视觉前
 *  一次性重建派生缓存；播放路径（每帧 10–60fps）不失效——grid 重建是 O(n) 大分配
 *  不可逐帧承受，只置脏标记，待播放状态切换时统一 flush（见 flushEnsembleCaches） */
  private applyEnsembleFrame(data: StructureData, frameF: number, invalidate = false) {
    if (!data.ensemble) return
    const frames = data.ensemble.frames
    const n = frames.length
    const f = Math.max(0, Math.min(frameF, n - 1))
    const f0 = Math.floor(f)
    const f1 = Math.min(f0 + 1, n - 1)
    const alpha = f - f0
    const pos = data.atoms.positions
    const a = frames[f0]
    const b = frames[f1]
    if (alpha > 1e-4 && f1 !== f0) {
      for (let i = 0; i < pos.length; i++) pos[i] = a[i] + (b[i] - a[i]) * alpha
    } else {
      pos.set(a)
    }
    if (invalidate) this.invalidateDerivedCaches(data)
    else if (this.ensembleDirty?.data !== data) this.ensembleDirty = { id: data.id, data }
    this.rebuildStructureVisuals(data)
  }

  /** 坐标突变后的派生缓存重建（对齐 applyRigidTransform 的失效范式）：
 *  a) SpatialGrid（within 选区/近邻查询/口袋距离场均依赖）；b) 包围盒；
 *  c) data.sasa（构象相关量，失效后由下一次 sasa / color sasa 请求自动重算）；
 *  d) colors.ts 口袋距离场 WeakMap 缓存。 */
  private invalidateDerivedCaches(data: StructureData) {
    this.ensembleDirty = null
    data.grid = new SpatialGrid(data.atoms.positions, data.atoms.count, data.grid.cell)
    recomputeBbox(data)
    data.sasa = undefined
    // 在途 SASA worker 结果基于旧坐标快照：丢弃，防失效后被写回旧构象数据
    this.sasaPending.delete(data.id)
    if (this.sasaPending.size === 0) useSasaStore.getState().setComputing(false)
    invalidatePocketField(data)
  }

  /** 播放状态切换点（暂停/停止/结构移除）的统一失效入口：脏标记闸门保证幂等、
 *  无帧写入时零开销；失效后若存在口袋着色 rep 立即重建（距离场渐变即刻对齐新构象） */
  private flushEnsembleCaches() {
    const dirty = this.ensembleDirty
    if (!dirty) return
    this.invalidateDerivedCaches(dirty.data)
    const entry = useMolStore.getState().structures.find(s => s.id === dirty.id)
    if (entry?.reps.some(r => r.colorScheme === 'pocket')) {
      this.rebuildStructureVisuals(dirty.data)
    }
  }

  /** 坐标变化后重建该结构的全部视觉（reps/高亮/标签/测量/拾取标记/氢键） */
  private rebuildStructureVisuals(data: StructureData) {
    // 找到对应 entry 并重建 reps
    const store = useMolStore.getState()
    const entry = store.structures.find(s => s.id === data.id)
    const view = this.views.get(data.id)
    if (!entry || !view) return
    const filtersKey = `${store.settings.hideHydrogens}|${store.settings.hideWater}|${store.settings.quality}`
    for (const rep of entry.reps) {
      const existing = view.reps.get(rep.id)
      if (existing) {
        view.repContainer.remove(existing.build.group)
        existing.build.dispose()
        view.reps.delete(rep.id)
      }
      this.buildRep(entry, rep, data, view, store.settings, filtersKey)
    }
    this.pickablesCache = null
    // 高亮/标签/测量/拾取标记强制刷新（key 缓存需失效）
    if (store.selection.structureId === data.id) {
      this.updateHighlight(view, data, store.selection.indices)
    }
    this.lastLabelsKey = ''
    this.updateLabels(store.labels)
    this.lastMeasureKey = ''
    this.updateMeasurements(store.measurements)
    this.lastPicksKey = ''
    this.updatePickMarkers(store.measurePicks)
    // 氢键重算（清缓存使 detKey 失效）
    this.hbondCache.delete(data.id)
    this.lastHbondKey = ''
    this.updateHBonds(store)
    // 接触连线坐标已变化 → 重渲染
    this.updateContacts()
    // 对称伴侣跟随重建（ensemble 播放期间节流，避免每帧全量克隆）
    const entrySym = store.structures.find(s => s.id === data.id)?.symmetry
    if (entrySym && entrySym.radius > 0) {
      const now = performance.now()
      if (now - (view.symLastRebuild ?? 0) > 140) {
        view.symLastRebuild = now
        const symKey = `${entry.rev}|${entry.reps.map(r => r.id + (r.visible ? '1' : '0')).join(',')}|${entrySym.radius}|${filtersKey}`
        this.rebuildSymmetry(entry, data, view, symKey, entrySym.radius)
      }
    }
  }

  // ---------- 晶体对称伴侣（PyMOL symmetry / ChimeraX symmates） ----------

  /** 设置/更新对称伴侣；radius ≤ 0 清除。返回 { ok, count, message } */
  updateSymmetry(structureId: string, radius: number): { ok: boolean; count: number; message: string } {
    const data = dataRegistry.get(structureId)
    const store = useMolStore.getState()
    const entry = store.structures.find(s => s.id === structureId)
    if (!data || !entry) return { ok: false, count: 0, message: tt({ zh: '结构不存在', en: 'Structure not found' }) }
    if (radius <= 0) {
      useMolStore.setState(s => ({
        structures: s.structures.map(x => x.id === structureId ? { ...x, symmetry: undefined } : x),
        visualRev: s.visualRev + 1,
      }))
      const g = this.symmetryGroups.get(structureId)
      const view = this.views.get(structureId)
      if (g && view) view.group.remove(g)
      this.symmetryGroups.delete(structureId)
      this.pickablesCache = null
      return { ok: true, count: 0, message: tt({ zh: `已关闭 ${entry.name} 的对称伴侣`, en: `Symmetry mates disabled for ${entry.name}` }) }
    }
    if (!data.crystal) {
      return { ok: false, count: 0, message: tt({ zh: `${entry.name} 无晶胞信息（CRYST1 缺失）——无法生成对称伴侣`, en: `${entry.name} has no unit cell info (CRYST1 missing) — cannot generate symmetry mates` }) }
    }
    const ops = symOpsFor(data.crystal.spaceGroup)
    if (!ops) {
      return { ok: false, count: 0, message: tt({ zh: `空间群 "${data.crystal.spaceGroup.trim()}" 不在支持列表（65 个手性群）内`, en: `Space group "${data.crystal.spaceGroup.trim()}" is not in the supported list (65 chiral groups)` }) }
    }
    const mates = mateTransforms(data.crystal, data.crystal.spaceGroup, data.bbox.center, radius, data.bbox.radius)
    useMolStore.setState(s => ({
      structures: s.structures.map(x => x.id === structureId ? { ...x, symmetry: { radius, count: mates.length } } : x),
      visualRev: s.visualRev + 1,
    }))
    // 视觉重建（symKey 变化由 sync 触发；这里主动调一次确保即时反馈）
    const view = this.views.get(structureId)
    if (view) {
      const symKey = `${entry.rev}|${entry.reps.map(r => r.id + (r.visible ? '1' : '0')).join(',')}|${radius}|${store.settings.hideHydrogens}|${store.settings.hideWater}|${store.settings.quality}`
      this.rebuildSymmetry(entry, data, view, symKey, radius)
    }
    return {
      ok: true, count: mates.length,
      message: tt({
        zh: `${entry.name}：已生成 ${mates.length} 个对称伴侣（空间群 ${data.crystal.spaceGroup.trim()} · 半径 ${radius} Å · ${ops.length} 个对称操作）`,
        en: `${entry.name}: ${mates.length} symmetry mates generated (space group ${data.crystal.spaceGroup.trim()} · radius ${radius} Å · ${ops.length} symmetry operations)`,
      }),
    }
  }

  /** 晶胞盒（show cell）：CRYST1 单胞平行六面体线框——a 红 / b 绿 / c 蓝（PyMOL cell 惯例）。
   *  盒原点取晶格原点对齐包围盒（orthoMatrix 的格矢即笛卡尔方向），结构通常落在 [0,1)^3 分数坐标内。 */
  private updateCellBox(state: { structures: StructureEntry[]; activeId: string | null; settings: Settings }) {
    const on = !!state.settings.showCell
    // r63-fix-c #3：晶胞盒跟随活动结构（与 commands.ts show cell 消息口径对齐，按 st.activeId）；
    // 无活动结构时回退首可见
    const active = state.structures.find(s => s.id === state.activeId) ?? state.structures.find(s => s.visible)
    const crystal = active ? dataRegistry.get(active.id)?.crystal : undefined
    const key = on && crystal ? `${active!.id}|${crystal.a.toFixed(3)}|${crystal.b.toFixed(3)}|${crystal.c.toFixed(3)}|${crystal.alpha.toFixed(2)}|${crystal.beta.toFixed(2)}|${crystal.gamma.toFixed(2)}` : ''
    if (key === this.cellKey) return
    this.cellKey = key
    for (const child of [...this.cellGroup.children]) {
      this.cellGroup.remove(child)
      const line = child as THREE.LineSegments
      line.geometry?.dispose()
      const mat = line.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat?.dispose()
    }
    if (!on || !crystal) return
    // 格矢（笛卡尔）：orthoMatrix 列 = a/b/c 向量
    const { o } = orthoMatrix(crystal)
    const av: [number, number, number] = [o[0], o[3], o[6]]
    const bv: [number, number, number] = [o[1], o[4], o[7]]
    const cv: [number, number, number] = [o[2], o[5], o[8]]
    // 原点：把结构包围盒中心折回最近的格点原点（盒子套住结构，而非飘在原点）
    const data = dataRegistry.get(active!.id)!
    const center = data.bbox.center
    const oi = orthoMatrix(crystal).oi
    const fx = oi[0] * center[0] + oi[1] * center[1] + oi[2] * center[2]
    const fy = oi[3] * center[0] + oi[4] * center[1] + oi[5] * center[2]
    const fz = oi[6] * center[0] + oi[7] * center[1] + oi[8] * center[2]
    const origin: [number, number, number] = [
      (Math.floor(fx)) * av[0] + (Math.floor(fy)) * bv[0] + (Math.floor(fz)) * cv[0],
      (Math.floor(fx)) * av[1] + (Math.floor(fy)) * bv[1] + (Math.floor(fz)) * cv[1],
      (Math.floor(fx)) * av[2] + (Math.floor(fy)) * bv[2] + (Math.floor(fz)) * cv[2],
    ]
    // 12 条棱：a×4 / b×4 / c×4，各自配色
    const edges: { from: [number, number, number]; to: [number, number, number]; color: string }[] = []
    const add = (i0: number, j0: number, k0: number, i1: number, j1: number, k1: number, color: string) => {
      const p = (i: number, j: number, k: number): [number, number, number] => [
        origin[0] + i * av[0] + j * bv[0] + k * cv[0],
        origin[1] + i * av[1] + j * bv[1] + k * cv[1],
        origin[2] + i * av[2] + j * bv[2] + k * cv[2],
      ]
      edges.push({ from: p(i0, j0, k0), to: p(i1, j1, k1), color })
    }
    for (let k = 0; k <= 1; k++) for (let j = 0; j <= 1; j++) {
      add(0, j, k, 1, j, k, '#e05252') // a 边红
      add(j, 0, k, j, 1, k, '#4fae5c') // b 边绿
    }
    for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
      add(i, j, 0, i, j, 1, '#5a8fd8') // c 边蓝
    }
    const positions = new Float32Array(edges.length * 6)
    const colors = new Float32Array(edges.length * 6)
    const col = new THREE.Color()
    edges.forEach((e, idx) => {
      positions.set(e.from, idx * 6)
      positions.set(e.to, idx * 6 + 3)
      col.set(e.color)
      colors.set([col.r, col.g, col.b, col.r, col.g, col.b], idx * 6)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })
    const lines = new THREE.LineSegments(geo, mat)
    lines.renderOrder = 4
    this.cellGroup.add(lines)
  }

  /** 重建对称克隆组：克隆各 rep 的 group（共享几何/材质），挂刚体矩阵（不参与拾取）。radius 显式传入（避免旧 entry 引用读取到未更新的 symmetry） */
  private rebuildSymmetry(entry: StructureEntry, data: StructureData, view: StructureView, symKey: string, radius: number) {
    let symGroup = this.symmetryGroups.get(entry.id)
    if (!symGroup) {
      symGroup = new THREE.Group()
      symGroup.name = 'symmetry'
      this.symmetryGroups.set(entry.id, symGroup)
      view.group.add(symGroup)
    }
    for (const child of [...symGroup.children]) symGroup.remove(child)
    view.symLastRebuild = performance.now()
    const crystal = data.crystal
    // reps 未就绪（会话恢复早期）→ 不缓存 symKey，sync 构建 reps 后会重试
    if (!crystal || radius <= 0 || view.reps.size === 0) return
    const mates = mateTransforms(crystal, crystal.spaceGroup, data.bbox.center, radius, data.bbox.radius)
    const m4 = new THREE.Matrix4()
    for (const mt of mates) {
      m4.set(
        mt.rot[0], mt.rot[1], mt.rot[2], mt.trans[0],
        mt.rot[3], mt.rot[4], mt.rot[5], mt.trans[1],
        mt.rot[6], mt.rot[7], mt.rot[8], mt.trans[2],
        0, 0, 0, 1,
      )
      for (const rv of view.reps.values()) {
        if (!rv.build.group.visible) continue
        const clone = cloneGroupShallowUserData(rv.build.group)
        clone.matrix.copy(m4)
        clone.matrixAutoUpdate = false
        clone.matrixWorldNeedsUpdate = true
        symGroup.add(clone)
      }
    }
    // 成功重建后才缓存 key（失败/清空时 sync 可重试）
    symGroup.userData.symKey = symKey
    // 数量回写（面板显示；读取 store 最新 entry，不触发 sync 循环）
    const cur = useMolStore.getState().structures.find(x => x.id === entry.id)
    if (cur?.symmetry && cur.symmetry.count !== mates.length) {
      useMolStore.setState(s => ({
        structures: s.structures.map(x => x.id === entry.id && x.symmetry
          ? { ...x, symmetry: { ...x.symmetry, count: mates.length } } : x),
      }))
    }
  }

  // ---------- 结构叠合（对标 ChimeraX matchmaker） ----------

  /**
   * 将 mobile 结构叠合到 ref 结构：序列比对 + Horn 四元数刚体拟合 + 变换应用
   * 返回拟合统计（RMSD / 匹配数 / 链对）；失败返回 error
   * 可选链参数：显式指定移动/参考蛋白链（matchmaker 风格）
   */
  superpose(mobileId: string, refId: string, mobileChain?: string, refChain?: string): SuperposeResult {
    const mobile = dataRegistry.get(mobileId)
    const ref = dataRegistry.get(refId)
    if (!mobile || !ref) return { ...NULL_RESULT, error: tt({ zh: '结构不存在', en: 'Structure not found' }) }
    if (mobileId === refId) return { ...NULL_RESULT, error: tt({ zh: '移动与参考结构相同', en: 'Mobile and reference structures are the same' }) }
    const t0 = performance.now()
    const result = superposeStructures(mobile, ref, mobileChain, refChain)
    if (!result.ok) return result
    // 应用变换：positions + ensemble 帧 + 网格/包围盒
    applyRigidTransform(mobile, result.quat, result.translation)
    // 记录累计刚体变换（会话持久化：恢复时重放，保持叠合位姿）
    // p' = R(q2)·(R(q1)·p + t1) + t2 → qTotal = q2⊗q1，tTotal = R(q2)·t1 + t2
    // 注意：superpose/superpose.ts 的 quat 约定为 (w,x,y,z)，THREE.Quaternion 为 (x,y,z,w)
    const store = useMolStore.getState()
    const entry = store.structures.find(s => s.id === mobileId)
    const prev = entry?.transform
    /** (w,x,y,z) → THREE.Quaternion */
    const toThree = (q: [number, number, number, number]) => new THREE.Quaternion(q[1], q[2], q[3], q[0])
    const q2 = toThree(result.quat)
    const t2 = new THREE.Vector3(result.translation[0], result.translation[1], result.translation[2])
    let quatOut: [number, number, number, number]
    let tOut: [number, number, number]
    if (prev) {
      const q1 = toThree(prev.quat)
      const t1 = new THREE.Vector3(prev.translation[0], prev.translation[1], prev.translation[2])
      const qTotal = q2.clone().multiply(q1)
      const tTotal = t1.clone().applyQuaternion(q2).add(t2)
      const [tx, ty, tz, tw] = qTotal.toArray()
      quatOut = [tw, tx, ty, tz]
      tOut = tTotal.toArray() as [number, number, number]
    } else {
      quatOut = [...result.quat] as [number, number, number, number]
      tOut = [...result.translation] as [number, number, number]
    }
    useMolStore.setState(s => ({
      structures: s.structures.map(x => x.id === mobileId
        ? { ...x, transform: { quat: quatOut, translation: tOut } }
        : x),
    }))
    // 重建视觉（reps/标签/测量/氢键等）
    this.rebuildStructureVisuals(mobile)
    // 选择/视图跟随：若当前选中的是 mobile，保持选择不变（高亮已重建）
    const ms = Math.round(performance.now() - t0)
    void ms
    return result
  }

  /** 撤销叠合：用累计变换的逆变换把结构放回原始位姿（ensemble 帧/网格/包围盒同步） */
  resetTransform(structureId: string): { ok: boolean; message: string } {
    const store = useMolStore.getState()
    const entry = store.structures.find(s => s.id === structureId)
    const data = dataRegistry.get(structureId)
    if (!entry || !data) return { ok: false, message: tt({ zh: '结构不存在', en: 'Structure not found' }) }
    if (!entry.transform) return { ok: false, message: tt({ zh: '该结构未应用叠合变换', en: 'No superposition transform applied to this structure' }) }
    const t = entry.transform
    // superpose.ts 约定 (w,x,y,z)；THREE.Quaternion 为 (x,y,z,w)
    const q = new THREE.Quaternion(t.quat[1], t.quat[2], t.quat[3], t.quat[0])
    const tr = new THREE.Vector3(t.translation[0], t.translation[1], t.translation[2])
    const qInv = q.clone().invert()
    const tInv = tr.clone().negate().applyQuaternion(qInv)
    const [qx, qy, qz, qw] = qInv.toArray()
    applyRigidTransform(data, [qw, qx, qy, qz], tInv.toArray() as [number, number, number])
    // 清除累计变换（会话持久化不再重放）+ bump rev 重建
    useMolStore.setState(s => ({
      structures: s.structures.map(x => x.id === structureId
        ? { ...x, transform: undefined, rev: x.rev + 1 }
        : x),
      visualRev: s.visualRev + 1,
    }))
    this.rebuildStructureVisuals(data)
    return { ok: true, message: tt({ zh: `已重置 ${entry.name} 到原始位姿`, en: `${entry.name} reset to its original pose` }) }
  }

  // ---------- SASA 溶剂可及面积（Shrake–Rupley，大结构走 Web Worker） ----------

  /**
   * 计算完整结构 per-atom SASA 并写回 data.sasa。
   * 小结构同步完成返回 true；大结构投递 worker 返回 false（结果到达后自动 bump 重建）。
   */
  requestSasa(structureId: string, opts: SasaComputeOptions = {}): { done: boolean; stats?: SasaStats } {
    const data = dataRegistry.get(structureId)
    if (!data) return { done: false }
    const { probe = 1.4, nPoints = 92 } = opts
    const n = data.atoms.count
    const key = `full|${probe}|${nPoints}|${n}`
    // 小结构：同步计算直接落库
    if (n < SASA_WORKER_MIN_ATOMS) {
      const { perAtom, stats } = computeSasa(data, opts)
      data.sasa = perAtom
      this.applySasaResult(structureId, data, stats, probe, nPoints)
      return { done: true, stats }
    }
    // 大结构：worker 异步
    if (this.sasaPending.get(structureId) === key) return { done: false }
    const w = this.ensureSasaWorker()
    if (!w) {
      const { perAtom, stats } = computeSasa(data, opts)
      data.sasa = perAtom
      this.applySasaResult(structureId, data, stats, probe, nPoints)
      return { done: true, stats }
    }
    const isHydrogen = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const e = data.atoms.elements[i]
      if (e === 'H' || e === 'D') isHydrogen[i] = 1
    }
    this.sasaPending.set(structureId, key)
    useSasaStore.getState().setComputing(true)
    // 并发闸：槽位空出后再投递（排队期间被新请求取代 → 过期丢弃）
    void this.sasaSlots.acquire(tt({ zh: 'SASA 计算', en: 'SASA computation' })).then(release => {
      if (this.sasaPending.get(structureId) !== key) { release(); return }
      this.sasaSlots.post(release)
      w.postMessage({
        type: 'compute',
        reqId: ++this.sasaReqId,
        structureId,
        key,
        kind: 'full',
        positions: data.atoms.positions,
        radii: compileRadii(data.atoms.elements),
        isHydrogen,
        probe,
        nPoints,
      })
    })
    return { done: false }
  }

  /**
   * 界面埋藏面积（ΔSASA）：A/B 掩码三路计算。
   * 小结构同步；大结构 worker（结果写入 sasa-store.buried）。
   */
  requestBuriedSasa(
    structureId: string,
    maskA: Uint8Array,
    maskB: Uint8Array,
    opts: SasaComputeOptions = {},
  ): { done: boolean; result?: BuriedSasaResult } {
    const data = dataRegistry.get(structureId)
    if (!data) return { done: false }
    const { probe = 1.4, nPoints = 92 } = opts
    const n = data.atoms.count
    const key = `buried|${probe}|${nPoints}|${n}`
    if (n < BSA_WORKER_MIN_ATOMS) {
      const result = computeBuriedSasa(data, maskA, maskB, opts)
      this.applyBuriedResult(structureId, data, result, maskA, maskB)
      return { done: true, result }
    }
    if (this.sasaPending.get(structureId) === key) return { done: false }
    const w = this.ensureSasaWorker()
    if (!w) {
      const result = computeBuriedSasa(data, maskA, maskB, opts)
      this.applyBuriedResult(structureId, data, result, maskA, maskB)
      return { done: true, result }
    }
    const isHydrogen = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const e = data.atoms.elements[i]
      if (e === 'H' || e === 'D') isHydrogen[i] = 1
    }
    this.sasaPending.set(structureId, key)
    useSasaStore.getState().setBuriedComputing(true)
    void this.sasaSlots.acquire(tt({ zh: 'ΔSASA 计算', en: 'ΔSASA computation' })).then(release => {
      if (this.sasaPending.get(structureId) !== key) { release(); return }
      this.sasaSlots.post(release)
      w.postMessage({
        type: 'compute',
        reqId: ++this.sasaReqId,
        structureId,
        key,
        kind: 'buried',
        positions: data.atoms.positions,
        radii: compileRadii(data.atoms.elements),
        isHydrogen,
        probe,
        nPoints,
        maskA,
        maskB,
      })
    })
    return { done: false }
  }

  /** SASA 结果落库：统计入 store + 有 sasa 着色 rep 时 bump rev 触发重建 */
  private applySasaResult(structureId: string, data: StructureData, stats: SasaStats, probe: number, nPoints: number) {
    // Top 暴露残基（≤12，降序，跳过水/非聚合物）
    const top: { resIdx: number; area: number }[] = []
    for (let r = 0; r < data.residues.length; r++) {
      const res = data.residues[r]
      if (res.water || !res.polymer) continue
      if (stats.perResidue[r] > 0) top.push({ resIdx: r, area: stats.perResidue[r] })
    }
    top.sort((a, b) => b.area - a.area)
    useSasaStore.getState().setResult({
      structureId,
      total: stats.total,
      hydrophobic: stats.hydrophobic,
      polar: stats.polar,
      het: stats.het,
      ms: stats.ms,
      probe,
      nPoints,
      topResidues: top.slice(0, 12),
    })
    // 若任何 rep 使用 sasa 着色 → bump rev 触发重着色（sasa 数据已就位）
    const entry = useMolStore.getState().structures.find(s => s.id === structureId)
    if (entry?.reps.some(rep => rep.colorScheme === 'sasa')) {
      useMolStore.setState(s => ({
        structures: s.structures.map(x => x.id === structureId ? { ...x, rev: x.rev + 1 } : x),
        visualRev: s.visualRev + 1,
      }))
    }
    // 挂起的 color sasa 烘焙请求（大结构 worker 路径）→ 数据就绪后自动补烘焙
    if (this.pendingSasaBake === structureId) {
      this.pendingSasaBake = null
      const store = useMolStore.getState()
      if (store.activeId === structureId) {
        store.applyColor('sasa')
        store.appendLog('out', tt({ zh: 'SASA 数据就绪——已自动完成暴露度着色（埋藏蓝紫 → 暴露橙红）', en: 'SASA data ready — exposure coloring applied automatically (buried blue-violet → exposed orange-red)' }))
      }
    }
  }

  /** ΔSASA 结果落库（worker / 同步共用） */
  private applyBuriedResult(structureId: string, data: StructureData, result: BuriedSasaResult, maskA: Uint8Array, maskB: Uint8Array) {
    void maskA; void maskB
    useSasaStore.getState().setBuried({
      computing: false,
      structureId,
      atomsA: result.atomsA,
      atomsB: result.atomsB,
      buriedA: result.buriedA,
      buriedB: result.buriedB,
      coreA: result.coreA,
      coreB: result.coreB,
      ms: result.ms,
      cross: null,
    })
  }

  // ---------- 跨结构 ΔSASA（两个独立 PDB 条目间的界面埋藏面积） ----------

  /**
   * 跨结构界面埋藏面积：把 A/B 两结构的原子拼接为联合坐标集做三路 SASA
   * （A alone / B alone / A∪B）。当前位姿（superpose 变换已写入 positions）即为计算基准。
   * 小结构同步；大结构 worker（kind='buried'，key 前缀 xburied 区分单结构路径）。
   */
  requestCrossBuriedSasa(
    idA: string,
    maskA: Uint8Array,
    idB: string,
    maskB: Uint8Array,
    opts: SasaComputeOptions = {},
  ): { done: boolean; result?: { buriedA: number; buriedB: number; coreA: number[]; coreB: number[]; atomsA: number; atomsB: number; ms: number } } {
    const dataA = dataRegistry.get(idA)
    const dataB = dataRegistry.get(idB)
    if (!dataA || !dataB) return { done: false }
    const { probe = 1.4, nPoints = 92 } = opts
    const nA = dataA.atoms.count
    const nB = dataB.atoms.count
    const n = nA + nB
    if (maskA.length !== nA || maskB.length !== nB) return { done: false }
    // 联合数组（当前位姿）
    const positions = new Float32Array(n * 3)
    positions.set(dataA.atoms.positions, 0)
    positions.set(dataB.atoms.positions, nA * 3)
    const radii = new Float32Array(n)
    radii.set(compileRadii(dataA.atoms.elements), 0)
    radii.set(compileRadii(dataB.atoms.elements), nA)
    const isHydrogen = new Uint8Array(n)
    for (let i = 0; i < nA; i++) {
      const e = dataA.atoms.elements[i]
      if (e === 'H' || e === 'D') isHydrogen[i] = 1
    }
    for (let i = 0; i < nB; i++) {
      const e = dataB.atoms.elements[i]
      if (e === 'H' || e === 'D') isHydrogen[nA + i] = 1
    }
    const aMask = new Uint8Array(n)
    aMask.set(maskA, 0)
    const bMask = new Uint8Array(n)
    bMask.set(maskB, nA)
    // 重原子计数
    let heavyA = 0, heavyB = 0
    for (let i = 0; i < n; i++) {
      if (aMask[i] && !isHydrogen[i]) heavyA++
      if (bMask[i] && !isHydrogen[i]) heavyB++
    }
    const store = useMolStore.getState()
    const labelA = store.structures.find(s => s.id === idA)?.meta.pdbId ?? idA
    const labelB = store.structures.find(s => s.id === idB)?.meta.pdbId ?? idB

    const key = `xburied|${idA}|${idB}|${probe}|${nPoints}|${n}`
    if (n < BSA_WORKER_MIN_ATOMS) {
      const t0 = performance.now()
      const r = computeBuriedSasaArrays(positions, radii, isHydrogen, aMask, bMask, probe, nPoints)
      this.applyCrossBuriedResult(idA, dataA, idB, dataB, r.delta, performance.now() - t0, heavyA, heavyB, labelA, labelB)
      return { done: true, result: this.crossBuriedSummary(idA, dataA, idB, dataB, r.delta) }
    }
    if (this.sasaPending.get(idA) === key) return { done: false }
    const w = this.ensureSasaWorker()
    if (!w) {
      const t0 = performance.now()
      const r = computeBuriedSasaArrays(positions, radii, isHydrogen, aMask, bMask, probe, nPoints)
      this.applyCrossBuriedResult(idA, dataA, idB, dataB, r.delta, performance.now() - t0, heavyA, heavyB, labelA, labelB)
      return { done: true, result: this.crossBuriedSummary(idA, dataA, idB, dataB, r.delta) }
    }
    this.xbsaMeta = { idA, idB, labelA, labelB, heavyA, heavyB }
    this.sasaPending.set(idA, key)
    // 占位结果：面板立即可见「计算中」状态（worker 完成后替换）
    useSasaStore.getState().setBuried({
      computing: true,
      structureId: idA,
      atomsA: heavyA,
      atomsB: heavyB,
      buriedA: 0, buriedB: 0, coreA: [], coreB: [], ms: 0,
      cross: { idA, idB, labelA, labelB },
    })
    void this.sasaSlots.acquire(tt({ zh: '跨结构 ΔSASA', en: 'cross-structure ΔSASA' })).then(release => {
      if (this.sasaPending.get(idA) !== key) { release(); return }
      this.sasaSlots.post(release)
      w.postMessage({
        type: 'compute',
        reqId: ++this.sasaReqId,
        structureId: idA,
        key,
        kind: 'buried',
        positions,
        radii,
        isHydrogen,
        probe,
        nPoints,
        maskA: aMask,
        maskB: bMask,
      })
    })
    return { done: false }
  }

  /** 跨结构 ΔSASA 结果落库：delta 拆回两侧结构 + 各自残基聚合 + 核心残基（>1 Å²） */
  private applyCrossBuriedResult(
    idA: string, dataA: StructureData, idB: string, dataB: StructureData,
    delta: Float32Array, ms: number, atomsA: number, atomsB: number,
    labelA: string, labelB: string,
  ) {
    const nA = dataA.atoms.count
    const deltaA = delta.subarray(0, nA)
    const deltaB = delta.subarray(nA)
    const perResA = new Float32Array(dataA.residues.length)
    for (let i = 0; i < deltaA.length; i++) {
      if (deltaA[i] > 0) perResA[dataA.atomResidue[i]] += deltaA[i]
    }
    const perResB = new Float32Array(dataB.residues.length)
    for (let i = 0; i < deltaB.length; i++) {
      if (deltaB[i] > 0) perResB[dataB.atomResidue[i]] += deltaB[i]
    }
    let buriedA = 0, buriedB = 0
    for (let i = 0; i < deltaA.length; i++) buriedA += deltaA[i]
    for (let i = 0; i < deltaB.length; i++) buriedB += deltaB[i]
    const coreA: number[] = [], coreB: number[] = []
    for (let r = 0; r < perResA.length; r++) if (perResA[r] > 1) coreA.push(r)
    for (let r = 0; r < perResB.length; r++) if (perResB[r] > 1) coreB.push(r)
    useSasaStore.getState().setBuried({
      computing: false,
      structureId: idA,
      atomsA, atomsB, buriedA, buriedB, coreA, coreB, ms,
      cross: { idA, idB, labelA, labelB },
    })
    useMolStore.getState().appendLog('out', tt({
      zh: `跨结构 ΔSASA 完成（Web Worker）：合计 ${(buriedA + buriedB).toFixed(0)} Å²（${labelA} ${buriedA.toFixed(0)} + ${labelB} ${buriedB.toFixed(0)}）· 核心残基 ${labelA} ${coreA.length} / ${labelB} ${coreB.length} · ${ms.toFixed(0)} ms`,
      en: `Cross-structure ΔSASA complete (Web Worker): total ${(buriedA + buriedB).toFixed(0)} Å² (${labelA} ${buriedA.toFixed(0)} + ${labelB} ${buriedB.toFixed(0)}) · core residues ${labelA} ${coreA.length} / ${labelB} ${coreB.length} · ${ms.toFixed(0)} ms`,
    }))
  }

  /** 同步路径返回摘要（不动 store——applyCrossBuriedResult 已写入） */
  private crossBuriedSummary(idA: string, dataA: StructureData, idB: string, dataB: StructureData, delta: Float32Array) {
    const nA = dataA.atoms.count
    const deltaA = delta.subarray(0, nA)
    const deltaB = delta.subarray(nA)
    const perResA = new Float32Array(dataA.residues.length)
    for (let i = 0; i < deltaA.length; i++) {
      if (deltaA[i] > 0) perResA[dataA.atomResidue[i]] += deltaA[i]
    }
    const perResB = new Float32Array(dataB.residues.length)
    for (let i = 0; i < deltaB.length; i++) {
      if (deltaB[i] > 0) perResB[dataB.atomResidue[i]] += deltaB[i]
    }
    const coreA: number[] = [], coreB: number[] = []
    let buriedA = 0, buriedB = 0
    for (let i = 0; i < deltaA.length; i++) buriedA += deltaA[i]
    for (let i = 0; i < deltaB.length; i++) buriedB += deltaB[i]
    for (let r = 0; r < perResA.length; r++) if (perResA[r] > 1) coreA.push(r)
    for (let r = 0; r < perResB.length; r++) if (perResB[r] > 1) coreB.push(r)
    let heavyA = 0, heavyB = 0
    for (let i = 0; i < deltaA.length; i++) if (deltaA[i] > 0) heavyA++
    for (let i = 0; i < deltaB.length; i++) if (deltaB[i] > 0) heavyB++
    return { buriedA, buriedB, coreA, coreB, atomsA: heavyA, atomsB: heavyB, ms: 0 }
  }

  /** 懒建 SASA worker（失败永久回退同步） */
  private ensureSasaWorker(): Worker | null {
    if (this.sasaWorkerFailed) return null
    if (this.sasaWorker) return this.sasaWorker
    try {
      const w = new Worker(new URL('./sasa-worker.ts', import.meta.url))
      w.onmessage = (e: MessageEvent) => this.onSasaWorkerResult(e.data)
      w.onerror = () => {
        this.sasaWorkerFailed = true
        this.sasaPending.clear()
        this.sasaSlots.releaseAll()
        useSasaStore.getState().setComputing(false)
        // ΔSASA（含跨结构 xbsa）computing 占位清理——防「计算中…」永久残留
        this.xbsaMeta = null
        const b = useSasaStore.getState().buried
        if (b?.computing) {
          useSasaStore.getState().setBuried(null)
          useMolStore.getState().appendLog('err', tt({ zh: 'SASA Worker 异常终止——ΔSASA 计算已取消（可重试；后续计算将回退主线程）', en: 'SASA Worker terminated abnormally — ΔSASA computation cancelled (you can retry; later computations fall back to the main thread)' }))
        }
      }
      this.sasaWorker = w
      return w
    } catch {
      this.sasaWorkerFailed = true
      return null
    }
  }

  /** worker 结果：full → 写 data.sasa + 统计 + 重建着色；buried → 写 store（xburied 前缀走跨结构拆分） */
  private onSasaWorkerResult(msg: {
    type: string
    reqId: number
    structureId: string
    key: string
    kind: 'full' | 'buried'
    sasa?: Float32Array
    delta?: Float32Array
    ms: number
  }) {
    if (!msg || msg.type !== 'result') return
    this.sasaSlots.releaseOne() // 并发闸：一条结果释放一个槽（过期结果同样占用过槽）
    if (this.sasaPending.get(msg.structureId) !== msg.key) return
    this.sasaPending.delete(msg.structureId)
    // 跨结构 ΔSASA：delta 是两结构拼接后的联合数组，拆回各自结构落库
    if (msg.kind === 'buried' && msg.delta && msg.key.startsWith('xburied|')) {
      const meta = this.xbsaMeta
      this.xbsaMeta = null
      const dataA = dataRegistry.get(meta?.idA ?? '')
      const dataB = dataRegistry.get(meta?.idB ?? '')
      if (!meta || !dataA || !dataB) {
        // 飞行元信息丢失（结构被删/覆盖）——清除可能残留的 computing 占位，防卡死
        const b = useSasaStore.getState().buried
        if (b?.computing && b.cross) useSasaStore.getState().setBuried(null)
        if (this.sasaPending.size === 0) useSasaStore.getState().setComputing(false)
        return
      }
      this.applyCrossBuriedResult(meta.idA, dataA, meta.idB, dataB, msg.delta, msg.ms, meta.heavyA, meta.heavyB, meta.labelA, meta.labelB)
      return
    }
    const data = dataRegistry.get(msg.structureId)
    if (!data) {
      if (this.sasaPending.size === 0) useSasaStore.getState().setComputing(false)
      return
    }
    if (msg.kind === 'full' && msg.sasa) {
      data.sasa = msg.sasa
      const stats = sasaStats(data, msg.sasa)
      stats.ms = msg.ms
      const probe = parseFloat(msg.key.split('|')[1]) || 1.4
      const nPoints = parseInt(msg.key.split('|')[2]) || 92
      this.applySasaResult(msg.structureId, data, stats, probe, nPoints)
      useMolStore.getState().appendLog('out', tt({
        zh: `SASA 完成（Web Worker，probe ${probe} Å，${nPoints} 点）：总计 ${stats.total.toFixed(0)} Å² · 疏水 ${stats.hydrophobic.toFixed(0)} · 极性 ${stats.polar.toFixed(0)} · ${stats.ms.toFixed(0)} ms`,
        en: `SASA complete (Web Worker, probe ${probe} Å, ${nPoints} points): total ${stats.total.toFixed(0)} Å² · hydrophobic ${stats.hydrophobic.toFixed(0)} · polar ${stats.polar.toFixed(0)} · ${stats.ms.toFixed(0)} ms`,
      }))
    } else if (msg.kind === 'buried' && msg.delta) {
      // 残基聚合 + 核心界面残基（>1 Å²）
      const perResidue = new Float32Array(data.residues.length)
      for (let i = 0; i < msg.delta.length; i++) {
        if (msg.delta[i] > 0) perResidue[data.atomResidue[i]] += msg.delta[i]
      }
      const coreA: number[] = [], coreB: number[] = []
      let buriedA = 0, buriedB = 0
      // 侧别判定：A 掩码不可得（未回传）——用 contacts 结果掩码重建
      const cs = useContactStore.getState()
      let maskA: Uint8Array | null = null
      if (cs.structureId === msg.structureId && cs.pairs.length) {
        maskA = new Uint8Array(data.atoms.count)
        for (const ri of cs.residuesA) {
          const res = data.residues[ri]
          for (let i = res.start; i < res.end; i++) maskA[i] = 1
        }
      }
      for (let r = 0; r < data.residues.length; r++) {
        if (perResidue[r] <= 1) continue
        const res = data.residues[r]
        if (maskA && maskA[res.start]) coreA.push(r)
        else coreB.push(r)
      }
      for (let i = 0; i < msg.delta.length; i++) {
        if (msg.delta[i] > 0) {
          if (maskA && maskA[i]) buriedA += msg.delta[i]
          else buriedB += msg.delta[i]
        }
      }
      useSasaStore.getState().setBuried({
        computing: false,
        structureId: msg.structureId,
        atomsA: cs.structureId === msg.structureId ? cs.atomsA : 0,
        atomsB: cs.structureId === msg.structureId ? cs.atomsB : 0,
        buriedA, buriedB, coreA, coreB, ms: msg.ms,
        cross: null,
      })
      useMolStore.getState().appendLog('out', tt({
        zh: `ΔSASA 完成（Web Worker）：合计 ${(buriedA + buriedB).toFixed(0)} Å²（A ${buriedA.toFixed(0)} + B ${buriedB.toFixed(0)}）· 界面核心残基 A ${coreA.length} / B ${coreB.length} · ${msg.ms.toFixed(0)} ms`,
        en: `ΔSASA complete (Web Worker): total ${(buriedA + buriedB).toFixed(0)} Å² (A ${buriedA.toFixed(0)} + B ${buriedB.toFixed(0)}) · interface core residues A ${coreA.length} / B ${coreB.length} · ${msg.ms.toFixed(0)} ms`,
      }))
    }
  }

  // ---------- 电子密度图（isomesh / isosurface，对标 PyMOL map+isomesh/isosurface） ----------

  /** 安装/替换密度图层（grid + 晶胞分数几何 → 世界位置由 PDB 正交化矩阵确定） */
  setDensityMap(def: {
    name: string
    grid: Float32Array
    dims: [number, number, number]
    fracOrigin: [number, number, number]
    fracStep: [number, number, number]
    cell: CrystalCell
    mean: number; rms: number; min: number; max: number
    iso?: number
    /** 差图负峰独立 σ（缺省同 iso） */
    isoNeg?: number
    mode?: 'surface' | 'mesh' | 'both'
    difference?: boolean
    color?: string
    negColor?: string
    opacity?: number
    visible?: boolean
  }) {
    this.disposeMapGeometry()
    const iso = def.iso ?? (def.difference ? 3 : 2)
    this.mapLayer = {
      name: def.name, grid: def.grid, dims: def.dims,
      fracOrigin: def.fracOrigin, fracStep: def.fracStep, cell: def.cell,
      mean: def.mean, rms: def.rms, min: def.min, max: def.max,
      iso,
      isoNeg: def.isoNeg ?? iso,
      mode: def.mode ?? (def.difference ? 'mesh' : 'both'),
      difference: def.difference ?? false,
      color: def.color ?? (def.difference ? '#2e9e44' : '#3d7ab8'),
      negColor: def.negColor ?? '#d64545',
      opacity: def.opacity ?? 0.38, visible: def.visible ?? true,
      meshes: [], wires: [], triangles: 0, truncated: false,
    }
    this.rebuildMapMesh()
  }

  /** 调整密度图外观（σ 级别 / 模式 / 颜色 / 不透明度 / 可见性；差图正负峰 σ 可独立设置） */
  setMapAppearance(patch: { iso?: number; isoNeg?: number; mode?: 'surface' | 'mesh' | 'both'; color?: string; negColor?: string; opacity?: number; visible?: boolean }) {
    const l = this.mapLayer
    if (!l) return
    let needRebuild = false
    if (patch.iso !== undefined && patch.iso !== l.iso) { l.iso = patch.iso; needRebuild = true }
    if (patch.isoNeg !== undefined && patch.isoNeg !== l.isoNeg) { l.isoNeg = patch.isoNeg; needRebuild = true }
    if (patch.mode !== undefined && patch.mode !== l.mode) { l.mode = patch.mode; needRebuild = true }
    if (patch.color !== undefined) l.color = patch.color
    if (patch.negColor !== undefined) l.negColor = patch.negColor
    if (patch.opacity !== undefined) l.opacity = patch.opacity
    if (patch.visible !== undefined) l.visible = patch.visible
    if (needRebuild) {
      this.rebuildMapMesh()
    } else {
      for (let i = 0; i < l.meshes.length; i++) {
        const mesh = l.meshes[i]
        mesh.visible = l.visible && l.mode !== 'mesh'
        const m = mesh.material as THREE.MeshStandardMaterial
        m.color.set(i === 0 ? l.color : l.negColor)
        m.opacity = l.opacity
      }
      for (let i = 0; i < l.wires.length; i++) {
        const wire = l.wires[i]
        wire.visible = l.visible && l.mode !== 'surface'
        ;(wire.material as THREE.LineBasicMaterial).color.set(i === 0 ? l.color : l.negColor)
      }
    }
  }

  /** 移除密度图层 */
  removeDensityMap() {
    this.disposeMapGeometry()
  }

  /** 密度图信息（UI 镜像用） */
  getMapInfo() {
    const l = this.mapLayer
    if (!l) return null
    return {
      name: l.name, dims: l.dims, iso: l.iso, isoNeg: l.isoNeg, mode: l.mode, difference: l.difference,
      color: l.color, negColor: l.negColor,
      opacity: l.opacity, visible: l.visible, triangles: l.triangles, truncated: l.truncated,
      mean: l.mean, rms: l.rms, min: l.min, max: l.max, cell: l.cell,
      // 体素尺寸 = 晶轴长 × 分数步长（裁剪后步长不变，不能用 cell/dims）
      voxel: [l.cell.a * l.fracStep[0], l.cell.b * l.fracStep[1], l.cell.c * l.fracStep[2]] as [number, number, number],
    }
  }

  private disposeMapGeometry() {
    const l = this.mapLayer
    if (!l) return
    for (const mesh of l.meshes) {
      this.mapGroup.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    l.meshes = []
    for (const wire of l.wires) {
      this.mapGroup.remove(wire)
      wire.geometry.dispose()
      ;(wire.material as THREE.Material).dispose()
    }
    l.wires = []
  }

  /** marching cubes 等值面/网格重建：常规 mean+iso·rms；差图 ±iso·rms 正负双面；网格模式三角上限调低控内存 */
  private rebuildMapMesh() {
    const l = this.mapLayer
    if (!l) return
    this.disposeMapGeometry()
    const isoDefs: { level: number; color: string }[] = l.difference
      ? [
          { level: l.mean + l.iso * l.rms, color: l.color },     // 正峰（模型缺失处；σ=iso）
          { level: l.mean - l.isoNeg * l.rms, color: l.negColor }, // 负峰（模型多余/错位处；σ=isoNeg 独立）
        ]
      : [{ level: l.mean + l.iso * l.rms, color: l.color }]
    // grid 索引 → 世界笛卡尔（PDB 正交化）：cart = O·(fracOrigin + step·grid)
    const o = orthoMatrix(l.cell).o
    const [fx, fy, fz] = l.fracOrigin
    const [sx, sy, sz] = l.fracStep
    const m = new THREE.Matrix4().set(
      o[0] * sx, o[1] * sy, o[2] * sz, o[0] * fx + o[1] * fy + o[2] * fz,
      o[3] * sx, o[4] * sy, o[5] * sz, o[3] * fx + o[4] * fy + o[5] * fz,
      o[6] * sx, o[7] * sy, o[8] * sz, o[6] * fx + o[7] * fy + o[8] * fz,
      0, 0, 0, 1,
    )
    const [nx, ny, nz] = l.dims
    let tris = 0
    let truncated = false
    let skipWire = false
    // 面模式上限 60 万；网格模式上限 15 万（纯线渲染轻）；差图双面上限减半防内存峰值
    const cap = (l.mode === 'mesh' ? 150_000 : 600_000) / isoDefs.length
    for (const def of isoDefs) {
      let res = marchingCubes(l.grid, nx, ny, nz, def.level, cap)
      // 自适应上限：差图低 σ（尤其负面）等值面可远超默认上限（如 3EKJ 负面 2σ≈35 万、1.5σ>60 万三角形），
      // 截断会造成大面积缺角——mesh 模式重试 8×（线缓冲较轻），surface/both 重试 2×（实体面本已高上限）
      if (res.truncated) {
        res = marchingCubes(l.grid, nx, ny, nz, def.level, cap * (l.mode === 'mesh' ? 8 : 2))
      }
      tris += Math.floor(res.count / 3)
      truncated = truncated || res.truncated
      if (!res.count) continue
      // 叠加模式在高三角数时省略网格线（线段过重视觉噪声也大；差图已双面再减半阈值）
      if (l.mode === 'both' && res.count / 3 > 250_000 / isoDefs.length) skipWire = true
      if (l.mode !== 'mesh') {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3))
        geo.applyMatrix4(m)
        const mat = new THREE.MeshStandardMaterial({
          color: def.color, transparent: true, opacity: l.opacity, depthWrite: false,
          side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
        })
        mat.clippingPlanes = this.clippingPlanes
        const mesh = new THREE.Mesh(geo, mat)
        mesh.renderOrder = 4
        mesh.visible = l.visible
        this.mapGroup.add(mesh)
        l.meshes.push(mesh)
      }
      if (l.mode !== 'surface' && !skipWire) {
        // 三角边 → LineSegments（每三角 3 边 6 顶点；与 isomesh 等价）
        const trisN = Math.floor(res.count / 3)
        const linePos = new Float32Array(trisN * 18)
        for (let t = 0; t < trisN; t++) {
          const p = t * 9
          const q = t * 18
          for (let e = 0; e < 3; e++) {
            const a = p + e * 3
            const b = p + ((e + 1) % 3) * 3
            linePos[q + e * 6] = res.positions[a]
            linePos[q + e * 6 + 1] = res.positions[a + 1]
            linePos[q + e * 6 + 2] = res.positions[a + 2]
            linePos[q + e * 6 + 3] = res.positions[b]
            linePos[q + e * 6 + 4] = res.positions[b + 1]
            linePos[q + e * 6 + 5] = res.positions[b + 2]
          }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(linePos, 3))
        geo.applyMatrix4(m)
        const mat = new THREE.LineBasicMaterial({
          color: def.color, transparent: true, opacity: Math.min(1, l.opacity + 0.5), depthWrite: false,
        })
        mat.clippingPlanes = this.clippingPlanes
        const wire = new THREE.LineSegments(geo, mat)
        wire.renderOrder = 5
        wire.visible = l.visible
        this.mapGroup.add(wire)
        l.wires.push(wire)
      }
    }
    l.triangles = tris
    l.truncated = truncated
  }

  // ---------- 动画录制（WebM） ----------

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording'
  }

  get recordingElapsed(): number {
    return this.isRecording ? (performance.now() - this.recordStartT) / 1000 : 0
  }

  /** 开始录制画布（30fps WebM）；返回是否成功 */
  startRecording(): boolean {
    if (this.isRecording) return true
    try {
      const stream = this.canvas.captureStream(30)
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m))
      if (!mime) return false
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
      this.recordChunks = []
      rec.ondataavailable = e => {
        if (e.data.size > 0) this.recordChunks.push(e.data)
      }
      rec.start(250)
      this.recorder = rec
      this.recordStartT = performance.now()
      return true
    } catch {
      return false
    }
  }

  /** 停止录制并返回 WebM Blob（未在录制返回 null） */
  stopRecording(): Promise<Blob | null> {
    const rec = this.recorder
    if (!rec || rec.state !== 'recording') return Promise.resolve(null)
    return new Promise(resolve => {
      this.recordResolve = resolve
      rec.onstop = () => {
        const blob = this.recordChunks.length ? new Blob(this.recordChunks, { type: 'video/webm' }) : null
        this.recorder = null
        this.recordResolve = null
        resolve(blob)
      }
      rec.stop()
    })
  }

  private buildRep(entry: StructureEntry, rep: RepConfig, data: StructureData, view: StructureView, settings: Settings, filtersKey: string) {
    const named = buildNamedMasks(entry.id, data)
    const res = evaluateSelection(rep.selection, { structure: data, named })
    const store = useMolStore
    if (res.error) {
      // 静默写回错误（不 bump visualRev，避免循环）
      if (rep.error !== res.error) {
        store.setState(s => ({
          structures: s.structures.map(x => x.id === entry.id
            ? { ...x, reps: x.reps.map(r => r.id === rep.id ? { ...r, error: res.error } : r) }
            : x),
        }))
      }
      const build: RepBuild = { group: new THREE.Group(), pickables: [], dispose: () => {} }
      view.reps.set(rep.id, { hash: JSON.stringify([rep, entry.rev, filtersKey]), build })
      return
    }
    if (rep.error) {
      store.setState(s => ({
        structures: s.structures.map(x => x.id === entry.id
          ? { ...x, reps: x.reps.map(r => r.id === rep.id ? { ...r, error: undefined } : r) }
          : x),
      }))
    }
    // 过滤氢 / 水 / 隐藏链组（isolate / chains hide 链隔离：隐藏链组原子不进几何）
    const mask = res.mask
    const hiddenGroups = entry.hiddenChains?.length ? new Set(entry.hiddenChains) : null
    if (settings.hideHydrogens || settings.hideWater || hiddenGroups) {
      const cg = hiddenGroups ? atomChainGroups(data) : null
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue
        if (cg && hiddenGroups!.has(cg[i])) { mask[i] = 0; continue }
        if (settings.hideHydrogens) {
          const e = data.atoms.elements[i]
          if (e === 'H' || e === 'D') { mask[i] = 0; continue }
        }
        if (settings.hideWater && data.residues[data.atomResidue[i]].water) mask[i] = 0
      }
    }
    const atomIdx: number[] = []
    for (let i = 0; i < mask.length; i++) if (mask[i]) atomIdx.push(i)
    // 颜色
    const colors = computeAtomColors(data, rep.colorScheme, { uniformColor: rep.uniformColor })
    const overrides = Object.keys(entry.colorOverrides)
    if (overrides.length) {
      const c = new THREE.Color()
      for (const k of overrides) {
        const i = Number(k)
        if (i >= data.atoms.count) continue
        c.set(entry.colorOverrides[i])
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      }
    }
    const opts = { quality: settings.quality }
    let build: RepBuild
    switch (rep.type) {
      case 'spacefill':
        build = buildSpheres(data, atomIdx, colors, 'vdw', rep.ballScale, opts)
        break
      case 'ballstick':
      case 'sticks': {
        const group = new THREE.Group()
        const pickables: Pickable[] = []
        const disposes: (() => void)[] = []
        if (rep.type === 'ballstick') {
          const b = buildSpheres(data, atomIdx, colors, 'fixed', 0.22 * rep.ballScale, opts)
          group.add(b.group); pickables.push(...b.pickables); disposes.push(b.dispose)
        }
        const s = buildSticks(data, mask, atomIdx.length, colors, rep.stickRadius, opts)
        group.add(s.group); pickables.push(...s.pickables); disposes.push(s.dispose)
        build = { group, pickables, dispose: () => disposes.forEach(d => d()) }
        break
      }
      case 'lines':
        build = buildLines(data, mask, colors)
        break
      case 'cartoon':
        build = buildCartoon(data, mask, colors, rep.cartoonWidth, opts)
        break
      case 'putty':
        build = buildCartoon(data, mask, colors, rep.cartoonWidth, opts, { putty: true, puttyRange: rep.puttyRange })
        break
      case 'surface':
        build = buildSurface(data, atomIdx, colors, rep)
        break
      default:
        build = { group: new THREE.Group(), pickables: [], dispose: () => {} }
    }
    build.group.visible = rep.visible
    for (const p of build.pickables) {
      p.mesh.userData.enginePick = { pick: p, structureId: entry.id }
    }
    view.repContainer.add(build.group)
    // 存储哈希与 sync() 侧计算保持一致（否则 rep 永不命中缓存逐帧重建）
    view.reps.set(rep.id, { hash: JSON.stringify([rep, entry.rev, filtersKey]), build })
    this.pickablesCache = null
    // 材质统一挂裁剪平面；同时应用当前高光设置（新建材质也遵循 specular 开关）
    build.group.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          ;(m as THREE.Material).clippingPlanes = this.clippingPlanes
          // 切层封盖：背面平面色补丁（side 在遍历后统一按当前生效状态设置）
          patchCapMaterial(m as THREE.Material)
          const std = m as THREE.MeshStandardMaterial
          if ('roughness' in std && this.settings) {
            if (std.userData.rough0 === undefined) std.userData.rough0 = std.roughness
            std.roughness = this.settings.specular ? std.userData.rough0 : 1
            std.envMapIntensity = this.settings.specular ? 1 : 0
          }
        }
      }
    })
    // 新建材质按当前封盖生效状态切 side（封盖开启时 FrontSide 材质转双面）
    if (capState.on) applyCapSides(build.group, true)
  }

  private updateHighlight(view: StructureView, data: StructureData, indices: number[]) {
    if (view.highlight) {
      view.repContainer.remove(view.highlight)
      view.highlight.geometry.dispose()
      ;(view.highlight.material as THREE.Material).dispose()
      view.highlight = null
    }
    if (indices.length === 0 || indices.length > 40000) return
    // 自适应高亮厚度：少量原子（点选/测量）用醒目光晕便于定位；
    // 大选择集（残基/链/结构级）退化为轻薄薄纱——避免整个结构被「厚裹」包裹
    const n = indices.length
    const halo = n <= 32 ? { scale: 1.06, pad: 0.26, opacity: 0.5 }
      : n <= 2000 ? { scale: 1.03, pad: 0.14, opacity: 0.3 }
      : { scale: 1.01, pad: 0.07, opacity: 0.18 }
    const geo = new THREE.SphereGeometry(1, 14, 10)
    const mat = new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: halo.opacity, depthWrite: false,
    })
    const mesh = new THREE.InstancedMesh(geo, mat, indices.length)
    const m = new THREE.Matrix4()
    const pos = data.atoms.positions
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      const r = elementInfo(data.atoms.elements[i]).vdw * halo.scale + halo.pad
      m.makeScale(r, r, r)
      m.setPosition(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      mesh.setMatrixAt(k, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.renderOrder = 6
    view.highlight = mesh
    view.repContainer.add(mesh)
  }

  private updateLabels(labels: AtomLabel[]) {
    // 清空各结构 labelGroup
    for (const view of this.views.values()) {
      for (const child of [...view.labelGroup.children]) {
        view.labelGroup.remove(child)
        disposeSprite(child as THREE.Sprite)
      }
    }
    for (const label of labels) {
      const data = dataRegistry.get(label.structureId)
      const view = this.views.get(label.structureId)
      if (!data || !view || !view.group.visible) continue
      // 链隔离：隐藏链组上的标签同步隐藏（否则悬浮文字指向空白处）
      const entry = useMolStore.getState().structures.find(x => x.id === label.structureId)
      if (entry?.hiddenChains?.length && entry.hiddenChains.includes(atomChainGroups(data)[label.atomIdx])) continue
      const h = Math.max(1.4, Math.min(5, data.bbox.radius * 0.055))
      const sprite = makeTextSprite(label.text, h, { color: '#f5f7fa', outline: 'rgba(10,12,16,0.85)' })
      sprite.position.set(
        data.atoms.positions[label.atomIdx * 3],
        data.atoms.positions[label.atomIdx * 3 + 1] + h * 0.6,
        data.atoms.positions[label.atomIdx * 3 + 2],
      )
      view.labelGroup.add(sprite)
    }
  }

  private updateMeasurements(measurements: Measurement[]) {
    for (const child of [...this.measureGroup.children]) {
      this.measureGroup.remove(child)
      if ((child as THREE.Sprite).isSprite) disposeSprite(child as THREE.Sprite)
      else {
        const m = child as THREE.Mesh
        m.geometry?.dispose()
        ;(m.material as THREE.Material)?.dispose()
      }
    }
    for (const meas of measurements) {
      const data = dataRegistry.get(meas.structureId)
      if (!data) continue
      const pos = data.atoms.positions
      const pts = meas.atoms.map(i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]))
      const colorMap: Record<string, number> = { distance: 0xffd166, angle: 0x4fd1c5, dihedral: 0xc39bd3 }
      const color = colorMap[meas.type]
      const h = Math.max(1.3, Math.min(5, data.bbox.radius * 0.05))
      // 连线（细圆柱）
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1]
        const dir = new THREE.Vector3().subVectors(b, a)
        const len = dir.length()
        if (len < 1e-4) continue
        const geo = new THREE.CylinderGeometry(0.09, 0.09, len, 8)
        const mat = new THREE.MeshBasicMaterial({ color })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.copy(a).addScaledVector(dir, 0.5)
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
        this.measureGroup.add(mesh)
      }
      // 值标签
      const text = meas.type === 'distance'
        ? `${meas.value.toFixed(2)} Å`
        : `${meas.value.toFixed(1)}°`
      const sprite = makeTextSprite(text, h, { color: '#ffffff', outline: 'rgba(10,12,16,0.9)' })
      const center = new THREE.Vector3()
      for (const p of pts) center.add(p)
      center.divideScalar(pts.length)
      sprite.position.copy(center).add(new THREE.Vector3(0, h * 0.8, 0))
      this.measureGroup.add(sprite)
    }
  }

  private updatePickMarkers(picks: { structureId: string; atoms: number[] } | null) {
    for (const child of [...this.pickMarkerGroup.children]) {
      this.pickMarkerGroup.remove(child)
      const m = child as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material)?.dispose()
    }
    if (!picks) return
    const data = dataRegistry.get(picks.structureId)
    if (!data) return
    const geo = new THREE.SphereGeometry(0.65, 16, 12)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, depthTest: false })
    for (const i of picks.atoms) {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2])
      mesh.renderOrder = 15
      this.pickMarkerGroup.add(mesh)
    }
    // 共享 geo/mat 由上面统一 dispose（仅清 children）
  }

  // ---------- 设置 ----------

  private applySettings(settings: Settings) {
    const prev = this.settings
    const changed = JSON.stringify(settings) !== JSON.stringify(prev)
    this.settings = settings
    // 切层封盖：生效态（slab && slabCap）或颜色/明暗变化时同步 uniform + 场景材质 side
    //（置于 changed 判断之前：首次应用 prev=null 与后续切换均能落地）
    const capOn = settings.slab && settings.slabCap
    const prevCapOn = prev ? prev.slab && prev.slabCap : null
    if (prevCapOn !== capOn || (prev && (prev.capColor !== settings.capColor || prev.capShading !== settings.capShading))
      || capUniforms.uCapOn.value !== (capOn ? 1 : 0)
      || capUniforms.uCapShadeOn.value !== (capOn && settings.capShading ? 1 : 0)) {
      syncCapSettings(this.scene, capOn, settings.capColor, settings.capShading)
    }
    // 自动性能模式：降级期间用户重新开启后处理 → 交还控制权并退出自动模式（用户优先，避免反复覆盖手动选择）
    if (this.perfBaseline && (settings.ssao || settings.outline)) {
      this.perfBaseline = null
      this.perfLowStreak = 0
      this.perfHighStreak = 0
      this.perfPrFactor = 1
      this.applyPixelRatio()
      usePerfStore.getState().setDegraded(false)
      useMolStore.getState().appendLog('out', tt({ zh: '自动性能模式：检测到手动开启后处理，已交还控制权并退出（perf on 可重新开启）', en: 'Auto performance mode: manual post-processing detected — control handed back and mode exited (perf on to re-enable)' }))
      useMolStore.getState().updateSettings({ autoPerf: false })
    }
    // 自动模式被关闭（perf off / 开关/会话恢复）→ 立即还原基线，不等下一个统计窗口
    if (prev && prev.autoPerf && !settings.autoPerf && this.perfBaseline) {
      this.restorePerfBaseline(tt({ zh: '自动性能模式已关闭，画质设置已还原', en: 'Auto performance mode off — quality settings restored' }))
    }
    if (!changed) return
    // 背景
    this.scene.background = new THREE.Color(settings.background)
    // 灯光（倍率；环境贴图贡献 0.45× —— 满档总照度≈1.6，避免 ACES 高光去饱和褪色）
    this.ambientLight.intensity = 0.08 * settings.lightAmbient
    this.keyLight.intensity = 1.1 * settings.lightKey
    this.fillLight.intensity = 0.35 * settings.lightFill
    this.scene.environmentIntensity = 0.45 * settings.lightAmbient
    // 高光开关切换 → 遍历已有材质调整（新 rep 构建时也会应用）
    if (prev && prev.specular !== settings.specular) this.applySpecularAll(settings.specular)
    // 雾
    if (settings.fog) {
      if (!this.scene.fog) this.scene.fog = new THREE.Fog(new THREE.Color(settings.background), 50, 200)
      ;(this.scene.fog as THREE.Fog).color.set(settings.background)
    } else {
      this.scene.fog = null
    }
    // FOV / 正交
    this.camera.fov = settings.fov
    this.camera.updateProjectionMatrix()
    const wantOrtho = settings.ortho
    if (wantOrtho && this.activeCamera !== this.orthoCamera) {
      // r63-fix-c #2：激活瞬间一次性位姿同步（透视 → 正交）+ zoom 重置；
      // 此后 resize/设置变更只走 updateOrthoFrustum 的纯 frustum 更新，不再覆盖用户位姿与缩放
      this.orthoCamera.position.copy(this.camera.position)
      this.orthoCamera.quaternion.copy(this.camera.quaternion)
      this.orthoCamera.up.copy(this.camera.up)
      this.orthoCamera.zoom = 1
      this.updateOrthoFrustum()
      this.activeCamera = this.orthoCamera
      this.controls.object = this.orthoCamera
    } else if (!wantOrtho && this.activeCamera !== this.camera) {
      this.activeCamera = this.camera
      this.controls.object = this.camera
    } else if (wantOrtho) {
      // 已在正交：设置变更（fov 等）只重算 frustum 尺寸——zoom/位姿不碰
      this.updateOrthoFrustum()
    }
    // 旋转
    this.controls.autoRotate = settings.spin && !settings.rock
    this.controls.autoRotateSpeed = settings.spinSpeed
    if (!settings.rock) this.rockBase = null
    // slab
    if (!settings.slab) this.setClippingInfinite()
    // 画质（像素比统一入口：quality 上限 × 自动降级因子）
    this.applyPixelRatio()
    this.pickablesCache = null
  }

  /** 俯仰限位（动态，每帧在 controls.update 前评估）：相机极角在范围内时收紧 [12°,168°]——
  * 拖拽不能过顶/过底（防无限制翻滚与过极点后的方位反转错觉）；
  * 极点位姿（view top/bottom 轴视角、极点视角恢复）由 orbitExempt 显式豁免（保持精确轴视角，
  * 不被吸到 12° 边界），拖回范围内后限位自动重新武装（无缝不回跳）；
  * orbitClamp=false 时全开（自由全向翻转，PyMOL 行为） */
  private orbitExempt = false
  /** 豁免登记时间：动画飞行途中（≤900ms，覆盖 650ms 过渡+落位）不因短暂入界而解除；之后回到范围内才重新武装 */
  private orbitExemptT = 0
  private updateOrbitClampDynamic() {
    const c = this.controls
    if (this.settings?.orbitClamp === false) {
      if (c.minPolarAngle !== 0 || c.maxPolarAngle !== Math.PI) {
        c.minPolarAngle = 0
        c.maxPolarAngle = Math.PI
      }
      this.orbitExempt = false
      return
    }
    // 飞行中（书签过渡/巡航路径）：动画完全接管轨迹——限位全程啠开，
    // 免得 controls.update 每帧把飞行中途的极角钳回边界（穿越极区的路径互相打架产生抖动）；
    // 用户输入会取消飞行（cancel 计数递增）且重武装逻辑因 camAnim 非空不会触发——安全
    if (this.camAnim || this.camPath) {
      if (c.minPolarAngle !== 0 || c.maxPolarAngle !== Math.PI) {
        c.minPolarAngle = 0
        c.maxPolarAngle = Math.PI
      }
      return
    }
    const off = TMP_ORBIT_V.subVectors(this.activeCamera.position, c.target)
    const r = off.length()
    if (r < 1e-6) return
    const phi = Math.acos(THREE.MathUtils.clamp(off.y / r, -1, 1))
    const inRange = phi >= ORBIT_CLAMP_RAD && phi <= Math.PI - ORBIT_CLAMP_RAD
    if (this.orbitExempt && inRange && !this.camAnim && performance.now() - this.orbitExemptT > 900) {
      // 豁免中且相机已回到限位范围内（非飞行途中、非刚落位）→ 重新武装（从极点方向抵达 12° 边界，不回跳）
      this.orbitExempt = false
    }
    const open = this.orbitExempt
    const wantMin = open ? 0 : ORBIT_CLAMP_RAD
    const wantMax = open ? Math.PI : Math.PI - ORBIT_CLAMP_RAD
    if (Math.abs(c.minPolarAngle - wantMin) > 1e-9 || Math.abs(c.maxPolarAngle - wantMax) > 1e-9) {
      c.minPolarAngle = wantMin
      c.maxPolarAngle = wantMax
    }
  }

  /** 极点位姿豁免登记：目标位置距极点 <10° 时显式豁免（view top/bottom、极点视角书签/场景/会话恢复）。
  * 豁免在相机回到限位范围内后自动解除（updateOrbitClampDynamic 每帧评估） */
  private maybeExemptOrbit(px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    const dy = py - ty
    const r = Math.hypot(px - tx, dy, pz - tz)
    if (r < 1e-6) return
    const phi = Math.acos(THREE.MathUtils.clamp(dy / r, -1, 1))
    if (phi < THREE.MathUtils.degToRad(10) || phi > Math.PI - THREE.MathUtils.degToRad(10)) {
      this.orbitExempt = true
      this.orbitExemptT = performance.now()
    }
  }

  /** 高光开关：遍历场景材质（粗糙度→1 且环境贴图贡献→0 消除镜面高光） */
  private applySpecularAll(specular: boolean) {
    this.scene.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial
        if (!('roughness' in std)) continue
        if (std.userData.rough0 === undefined) std.userData.rough0 = std.roughness
        std.roughness = specular ? std.userData.rough0 : 1
        std.envMapIntensity = specular ? 1 : 0
      }
    })
  }

  private setClippingInfinite() {
    // 可见条件：n·p + c ≥ 0 → c 取 +∞ 使所有点可见
    this.clippingPlanes[0].normal.set(0, 0, 1)
    this.clippingPlanes[0].constant = 1e9
    this.clippingPlanes[1].normal.set(0, 0, -1)
    this.clippingPlanes[1].constant = 1e9
  }

  // ---------- 视角 ----------

  fitView(refs?: { structureId: string; indices?: number[] }[], opts: { animate?: boolean; buffer?: number } = {}) {
    // r55：默认缓动（zoom/聚焦/双击 fitView 在录制中不再瞬时跳变，与 view 书签同一路径）；
    // buffer 并入缓动终点（zoom ligand, 5 的后退距离——避免旧「动画后瞬时 moveCamera」互相覆盖）
    const animate = opts.animate !== false
    const buffer = Number.isFinite(opts.buffer) ? Math.max(-200, Math.min(200, opts.buffer as number)) : 0
    const state = useMolStore.getState()
    const pts: number[][] = []
    if (refs && refs.length) {
      for (const ref of refs) {
        const data = dataRegistry.get(ref.structureId)
        if (!data) continue
        if (ref.indices && ref.indices.length) {
          for (const i of ref.indices) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        } else {
          for (let i = 0; i < data.atoms.count; i++) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        }
      }
    } else {
      for (const entry of state.structures) {
        if (!entry.visible) continue
        const data = dataRegistry.get(entry.id)
        if (!data) continue
        // 隐藏链组的原子不参与取景（zoom/orient/viewFrom/ray 阴影相机随显隐收缩）
        if (entry.hiddenChains?.length) {
          const hiddenRes = new Set<number>()
          for (let k = 0; k < data.chains.length; k++) {
            if (!entry.hiddenChains.includes(k)) continue
            for (const ri of data.chains[k].residueIdx) hiddenRes.add(ri)
          }
          for (let i = 0; i < data.atoms.count; i++) {
            if (hiddenRes.has(data.atomResidue[i])) continue
            pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
          }
        } else {
          for (let i = 0; i < data.atoms.count; i++) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        }
      }
    }
    if (!pts.length) return
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (const p of pts) {
      for (let d = 0; d < 3; d++) {
        if (p[d] < min[d]) min[d] = p[d]
        if (p[d] > max[d]) max[d] = p[d]
      }
    }
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    const radius = Math.max(2, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
    const dir = new THREE.Vector3().subVectors(this.activeCamera.position, this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.35, 1)
    dir.normalize()
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.18 + buffer
    const dest = center.clone().addScaledVector(dir, dist)
    if (animate) {
      // 平滑过渡：animateCameraTo（up 球面 slerp / 极点豁免 / 过渡手感三档均由 r54 管线统一处理）
      this.animateCameraTo({ pos: dest.toArray(), target: center.toArray() })
      return
    }
    this.controls.target.copy(center)
    this.activeCamera.position.copy(dest)
    if (this.activeCamera === this.orthoCamera) {
      // r63-fix-c #2：正交取景——zoom 重置（取景语义）+ frustum 按新距离重建；
      // 位姿已写入 orthoCamera（frustum 距离以其为准），旧版此处会被透视机位覆盖回去
      this.orthoCamera.zoom = 1
      this.updateOrthoFrustum()
    }
    this.syncCameraPeer()
    this.controls.update()
  }

  resetView() {
    // r55：平滑归位——有结构 → 缓动到全量适配位姿；空场景 → 缓动到默认机位
    // （瞬时 set 在录制中表现为「视角突变」；用户拖拽/滚轮可随时中断，复用 camAnimCancel）
    const hasStructures = useMolStore.getState().structures.some(x => x.visible)
    if (hasStructures) {
      this.fitView()
      return
    }
    this.animateCameraTo({ pos: [40, 30, 60], target: [0, 0, 0] })
  }

  /** view from <选择>：沿「结构质心 → 选择质心」方向观察——配体在前景、口袋开口正对相机
   *  （结合位点出版图的标准视角）；叠加 ~17° 仰角增加纵深。距离按「选择 + 4.5Å 口袋上下文」
   *  包围球自适应（小体积选择自动并入邻域原子——口袋残基完整入画不被画框裁切；配体+口袋
   *  集群约占画面 1/2 的特写构图）。方向无意义（选择贴近全局质心，如多配体均布）
   *  时返回 false 由调用方回退（命令层会自动挑离相机目标最近的配体实例重试）。 */
  viewFrom(refs?: { structureId: string; indices?: number[] }[]): boolean {
    let selPts = this.collectFitPoints(refs)
    const allPts = this.collectFitPoints()
    if (selPts.length < 1 || allPts.length < 4) return false
    const centroid = (pts: number[][]) => {
      const c = new THREE.Vector3()
      for (const p of pts) c.add(new THREE.Vector3(p[0], p[1], p[2]))
      return c.multiplyScalar(1 / pts.length)
    }
    // 小体积选择（包围球 < 12Å——单个配体/残基）自动并入 4.5Å 口袋上下文原子：
    // 特写取景按「配体 + 口袋残基」集群计算，口袋完整入画（O(n·m) 近邻，毫秒级）
    const bboxOf = (pts: number[][]): { min: [number, number, number]; max: [number, number, number] } => {
      const min: [number, number, number] = [Infinity, Infinity, Infinity]
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
      for (const p of pts) {
        for (let d = 0; d < 3; d++) {
          if (p[d] < min[d]) min[d] = p[d]
          if (p[d] > max[d]) max[d] = p[d]
        }
      }
      return { min, max }
    }
    const selRadius0 = 0.5 * Math.hypot(...(([0, 1, 2] as const).map(d => bboxOf(selPts).max[d] - bboxOf(selPts).min[d]) as [number, number, number]))
    if (selRadius0 < 12 && allPts.length > selPts.length) {
      const near: number[][] = []
      for (const p of allPts) {
        let d2 = Infinity
        for (const q of selPts) {
          const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
          const dd = dx * dx + dy * dy + dz * dz
          if (dd < d2) d2 = dd
          if (d2 <= 20.25) break // ≤4.5² 已命中，提前出
        }
        if (d2 <= 20.25) near.push(p)
      }
      if (near.length) selPts = selPts.concat(near)
    }
    const selC = centroid(selPts)
    const allC = centroid(allPts)
    const dir = selC.clone().sub(allC)
    if (dir.length() < 6) return false // 方向无意义：选择就在结构中心附近
    dir.normalize()
    // 仰角 ~17°（tan≈0.3）：打破纯正视的扁平感；dir 近竖直时换参考轴避免退化
    const upRef = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
    dir.addScaledVector(upRef, 0.3).normalize()
    // 距离：选择+口袋包围球半径 + 4Å 呼吸余量（fov 适配；口袋集群约占画面 1/2 的特写构图）
    const { min, max } = bboxOf(selPts)
    const selRadius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
    const radius = Math.max(4, selRadius + 4)
    const dist = Math.max(10, (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 0.95)
    const pos = selC.clone().addScaledVector(dir, dist)
    this.animateCameraTo({ pos: pos.toArray(), target: selC.toArray(), up: upRef.toArray() })
    return true
  }

  /** 对标 PyMOL orient：按 PCA 主轴对齐视角（最长轴→屏幕水平，次轴→垂直）再适配 */
  orient(refs?: { structureId: string; indices?: number[] }[]): boolean {
    const pts = this.collectFitPoints(refs)
    if (pts.length < 3) return false
    // 质心 + 协方差（3x3 对称）
    const c = [0, 0, 0]
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2] }
    c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (const p of pts) {
      const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2]
      cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz
      cov[4] += dy * dy; cov[5] += dy * dz
      cov[8] += dz * dz
    }
    cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5]
    const { vals, vecs } = eigenSymmetric3(cov)
    if (!(vals[0] > 1e-9)) { this.fitView(refs); return true }
    // 正交右手系：v1（最大方差）→屏幕 X，v2→Y(up)，v3 = v1×v2 →相机方向
    const v1 = new THREE.Vector3(vecs[0][0], vecs[0][1], vecs[0][2]).normalize()
    const v2 = new THREE.Vector3(vecs[1][0], vecs[1][1], vecs[1][2]).normalize()
    const v3 = new THREE.Vector3().crossVectors(v1, v2).normalize()
    const center = new THREE.Vector3(c[0], c[1], c[2])
    // r55：适配距离与 fitView 同式，主轴对齐走缓动（up 球面 slerp 由 animateCameraTo 处理；
    // 极点豁免也在其内部登记——主轴竖直的 PCA 对齐仍能精确落位）；录制中 orient 不再跳变
    const rmin: [number, number, number] = [Infinity, Infinity, Infinity]
    const rmax: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (const p of pts) {
      for (let d = 0; d < 3; d++) {
        if (p[d] < rmin[d]) rmin[d] = p[d]
        if (p[d] > rmax[d]) rmax[d] = p[d]
      }
    }
    const radius = Math.max(2, 0.5 * Math.hypot(rmax[0] - rmin[0], rmax[1] - rmin[1], rmax[2] - rmin[2]))
    const dist = Math.max(2, (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.18)
    const pos = center.clone().addScaledVector(v3, dist)
    this.animateCameraTo({ pos: pos.toArray(), target: center.toArray(), up: v2.toArray() })
    return true
  }

  /** 相机动画是否进行中（视觉自查截图前等待落位——ray 阻塞期间 tween 被冻结需等渲染循环追上） */
  isCameraAnimating(): boolean {
    return !!this.camAnim
  }

  /** 相机状态导出（get_view） */
  getCameraState(): { pos: number[]; target: number[]; up: number[]; fov: number; ortho: boolean } {
    const cam = this.activeCamera
    return {
      pos: cam.position.toArray().map(v => +v.toFixed(4)),
      target: this.controls.target.toArray().map(v => +v.toFixed(4)),
      up: cam.up.toArray().map(v => +v.toFixed(4)),
      fov: this.camera.fov,
      ortho: this.settings?.ortho ?? false,
    }
  }

  /** 相机状态导入（set_view；JSON 文本解析后调用） */
  setCameraState(s: { pos?: number[]; target?: number[]; up?: number[]; fov?: number; ortho?: boolean }) {
    // 显式相机操作接管：停掉飞行中动画
    this.camAnim = null
    this.camPath = null
    if (Array.isArray(s.pos) && s.pos.length === 3) this.activeCamera.position.fromArray(s.pos)
    if (Array.isArray(s.target) && s.target.length === 3) this.controls.target.fromArray(s.target)
    if (Array.isArray(s.up) && s.up.length === 3) {
      this.activeCamera.up.fromArray(s.up).normalize()
      this.orthoCamera.up.copy(this.activeCamera.up)
    }
    if (typeof s.fov === 'number' && s.fov > 5 && s.fov < 120) {
      this.camera.fov = s.fov
      this.camera.updateProjectionMatrix()
    }
    // 极点位姿（轴视角/极点书签恢复）显式豁免俯仰限位，保持精确落位（先登记豁免再 update，免被旧限位吸走）
    if (Array.isArray(s.pos) && Array.isArray(s.target)) {
      this.maybeExemptOrbit(s.pos[0], s.pos[1], s.pos[2], s.target[0], s.target[1], s.target[2])
    }
    this.updateOrbitClampDynamic()
    this.controls.update()
    if (this.activeCamera === this.orthoCamera) {
      // r63-fix-c #2：正交位姿直写后 frustum 需按新距离重算（zoom 保持用户值），并镜像透视 peer
      this.syncCameraPeer()
      this.updateOrthoFrustum()
    }
    if (typeof s.ortho === 'boolean' && this.settings && s.ortho !== this.settings.ortho) {
      useMolStore.getState().updateSettings({ ortho: s.ortho })
    }
  }

  /** 非活动相机位姿同步（turn/move/dolly 修改 activeCamera 后调用，与 fitView 同策略） */
  private syncCameraPeer() {
    if (this.activeCamera === this.orthoCamera) {
      this.camera.position.copy(this.orthoCamera.position)
      this.camera.up.copy(this.orthoCamera.up)
    } else {
      this.orthoCamera.position.copy(this.camera.position)
      this.orthoCamera.up.copy(this.camera.up)
    }
  }

  /** 相机屏幕坐标系基向量（x=屏幕右 y=屏幕上 z=视线向外） */
  private cameraBasis() {
    const dir = new THREE.Vector3().subVectors(this.activeCamera.position, this.controls.target).normalize()
    const right = new THREE.Vector3().crossVectors(dir, this.activeCamera.up).normalize()
    const up = new THREE.Vector3().crossVectors(right, dir).normalize()
    return { dir, right, up }
  }

  /** 对标 PyMOL turn：绕屏幕轴旋转相机（x=俯仰 y=水平方位 z=滚转），target 不动 */
  turnCamera(axis: 'x' | 'y' | 'z', deg: number) {
    // 先取消进行中的相机动画（orient/view 飞行）：命令序列中 turn 紧跟 orient 时
    // （模板 120ms 微间隔），不取消则动画后续帧会把本次旋转覆盖回 orient 目标位
    if (this.camAnim || this.camPath) this.camAnimCancelCount++
    this.camAnim = null
    this.camPath = null
    const { dir, right, up } = this.cameraBasis()
    const worldAxis = axis === 'x' ? right : axis === 'y' ? up : dir
    const q = new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180)
    const offset = new THREE.Vector3().subVectors(this.activeCamera.position, this.controls.target)
    offset.applyQuaternion(q)
    this.activeCamera.position.copy(this.controls.target).add(offset)
    this.activeCamera.up.applyQuaternion(q).normalize()
    this.syncCameraPeer()
    this.controls.update()
  }

  /** 对标 PyMOL move：沿屏幕轴平移相机与目标（x=右 y=上 z=推拉，正 z=远离主体） */
  moveCamera(axis: 'x' | 'y' | 'z', dist: number) {
    // 与 turnCamera 同源：取消飞行中动画，命令序列的叠加平移不被覆盖回目标位
    if (this.camAnim || this.camPath) this.camAnimCancelCount++
    this.camAnim = null
    this.camPath = null
    const { dir, right, up } = this.cameraBasis()
    const worldAxis = axis === 'x' ? right : axis === 'y' ? up : dir
    const delta = worldAxis.multiplyScalar(dist)
    this.activeCamera.position.add(delta)
    this.controls.target.add(delta)
    this.syncCameraPeer()
    this.controls.update()
  }

  /** 推拉镜头（factor<1 拉近 · >1 拉远；zoom in / zoom out） */
  dollyCamera(factor: number) {
    const offset = new THREE.Vector3().subVectors(this.activeCamera.position, this.controls.target)
    const len = Math.max(3, Math.min(800, offset.length() * factor))
    this.activeCamera.position.copy(this.controls.target).addScaledVector(offset.normalize(), len)
    this.syncCameraPeer()
    this.controls.update()
  }

  /** 正交视角预设（front/back/top/bottom/left/right · x/y/z 别名）——保持 target 与距离，平滑过渡 */
  setAxisView(name: string): boolean {
    const dirs: Record<string, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1],
      top: [0, 1, 0], bottom: [0, -1, 0],
      left: [-1, 0, 0], right: [1, 0, 0],
      x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
    }
    const d = dirs[name.toLowerCase()]
    if (!d) return false
    const dist = Math.max(3, this.activeCamera.position.distanceTo(this.controls.target))
    // 视线平行 up 时换 up（top/bottom 视角）
    const vertical = Math.abs(d[1]) > 0.99
    const up: [number, number, number] = vertical ? [0, 0, d[1] > 0 ? -1 : 1] : [0, 1, 0]
    const pos = this.controls.target.clone().add(new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(dist))
    this.animateCameraTo({ pos: pos.toArray(), target: this.controls.target.toArray(), up })
    return true
  }

  /** 视角书签平滑过渡：easeInOutCubic 插值 pos/target/fov，up 全程球面插值（结尾零跳变）；
   *  spin/rock 开启或参数非法时直接落位（每帧改相机的模式与过渡动画互相打架）；
   *  dur 缺省时按 camTransition 手感设置（quick 350 · normal 650 · cinematic 1200ms） */
  animateCameraTo(s: { pos?: number[]; target?: number[]; up?: number[]; fov?: number; ortho?: boolean }, dur?: number) {
    const valid = Array.isArray(s.pos) && s.pos.length === 3 && Array.isArray(s.target) && s.target.length === 3
    if (!valid || this.settings?.spin || this.settings?.rock) {
      this.setCameraState(s)
      return
    }
    const d = dur ?? CAM_TRANSITION_MS[this.settings?.camTransition ?? 'normal']
    // 投影模式先行切换（正交/透视过渡期间保持目标模式）
    if (typeof s.ortho === 'boolean' && this.settings && s.ortho !== this.settings.ortho) {
      useMolStore.getState().updateSettings({ ortho: s.ortho })
    }
    const fov1 = typeof s.fov === 'number' && s.fov > 5 && s.fov < 120 ? s.fov : this.camera.fov
    // r63-fix-c #2：起飞位姿取自当前活动相机（正交模式下 OrbitControls 驱动的是 orthoCamera，
    // 透视相机位姿已陈旧——旧版 p0 取透视机位导致正交模式触发书签/适配时开场跳变）
    const startCam = this.activeCamera
    const up0 = startCam.up.clone().normalize()
    const up1 = Array.isArray(s.up) && s.up.length === 3
      ? new THREE.Vector3().fromArray(s.up).normalize()
      : up0.clone()
    // up0→up1 旋转（无变化时 null：跳过每帧插值）
    const upQ = Math.abs(up0.dot(up1)) < 0.99999
      ? new THREE.Quaternion().setFromUnitVectors(up0, up1)
      : null
    // 目标极点位姿（view top/bottom / 极点书签）→ 豁免俯仰限位（动画全程啠开，精确落位）
    if (Array.isArray(s.pos) && Array.isArray(s.target)) {
      this.maybeExemptOrbit((s.pos as number[])[0], (s.pos as number[])[1], (s.pos as number[])[2],
        (s.target as number[])[0], (s.target as number[])[1], (s.target as number[])[2])
    }
    this.camPath = null
    this.camAnim = {
      t0: performance.now(),
      dur: Math.max(120, d),
      p0: startCam.position.clone(),
      p1: new THREE.Vector3().fromArray(s.pos as number[]),
      g0: this.controls.target.clone(),
      g1: new THREE.Vector3().fromArray(s.target as number[]),
      fov0: this.camera.fov,
      fov1,
      up0,
      up1,
      upQ,
    }
  }

  /** 相机巡航路径（movie 平滑模式）：关键帧序列 Catmull-Rom 连续插值——
   *  关键帧处速度不归零（区别于逐段 easeInOut 的驻留式巡航），录像连贯无顿挫；
   *  up 逐段球面插值 + 每帧 lookAt，路径穿越极区也无退化帧；全局 easeInOutCubic 柔和起停。
   *  首帧自动取当前相机位姿（无缝起飞），poses 为全部要途经的关键帧；
   *  @param segDurs 每段时长 ms（段 i = 「起飞/上一关键帧 → poses[i]」，segDurs.length = poses.length） */
  animateCameraPath(poses: { pos: number[]; target: number[]; up?: number[]; fov?: number }[], segDurs: number[]) {
    if (poses.length < 2 || this.settings?.spin || this.settings?.rock) return false
    for (const p of poses) {
      if (!Array.isArray(p.pos) || p.pos.length !== 3 || !Array.isArray(p.target) || p.target.length !== 3) return false
    }
    // 首帧自动前置当前位姿（活动相机，正交模式同理）：起飞无缝，poses 全部关键帧都会被途经
    const keys = [
      { p: this.activeCamera.position.clone(), g: this.controls.target.clone(), up: this.activeCamera.up.clone().normalize(), fov: this.camera.fov },
      ...poses.map(p => ({
        p: new THREE.Vector3().fromArray(p.pos),
        g: new THREE.Vector3().fromArray(p.target),
        up: Array.isArray(p.up) && p.up.length === 3
          ? new THREE.Vector3().fromArray(p.up).normalize()
          : UP_VECTOR.clone(),
        fov: typeof p.fov === 'number' && p.fov > 5 && p.fov < 120 ? p.fov : this.camera.fov,
      })),
    ]
    const nSeg = keys.length - 1
    const cum: number[] = []
    let acc = 0
    for (let i = 0; i < nSeg; i++) {
      acc += Math.max(120, segDurs[i] ?? 1500)
      cum.push(acc)
    }
    const upQ: (THREE.Quaternion | null)[] = []
    for (let i = 0; i < nSeg; i++) {
      upQ.push(Math.abs(keys[i].up.dot(keys[i + 1].up)) < 0.99999
        ? new THREE.Quaternion().setFromUnitVectors(keys[i].up, keys[i + 1].up)
        : null)
    }
    // 目标含极点位姿（top/bottom 机位）→ 豁免俯仰限位（路径全程接管）
    for (const k of keys) this.maybeExemptOrbit(k.p.x, k.p.y, k.p.z, k.g.x, k.g.y, k.g.z)
    this.camAnim = null
    this.camPath = { t0: performance.now(), cum, keys, upQ, total: acc }
    return true
  }

  /** 巡航路径状态（UI 同步当前段/进度）：非巡航中返回 null */
  getCameraPathState(): { seg: number; total: number; progress: number } | null {
    if (!this.camPath) return null
    const a = this.camPath
    const s = Math.min(1, (performance.now() - a.t0) / a.total)
    const se = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2
    const tMs = se * a.total
    let i = 0
    while (i < a.cum.length - 1 && tMs >= a.cum[i]) i++
    return { seg: i, total: a.cum.length, progress: s }
  }

  /** fitView 取点抽出（orient 复用） */
  private collectFitPoints(refs?: { structureId: string; indices?: number[] }[]): number[][] {
    const state = useMolStore.getState()
    const pts: number[][] = []
    if (refs && refs.length) {
      for (const ref of refs) {
        const data = dataRegistry.get(ref.structureId)
        if (!data) continue
        if (ref.indices && ref.indices.length) {
          for (const i of ref.indices) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        } else {
          for (let i = 0; i < data.atoms.count; i++) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        }
      }
    } else {
      for (const entry of state.structures) {
        if (!entry.visible) continue
        const data = dataRegistry.get(entry.id)
        if (!data) continue
        // r55：隐藏链组的原子不参与取景（viewFrom 方向/特写距离/ray 阴影相机随显隐收缩）
        if (entry.hiddenChains?.length) {
          const hiddenRes = new Set<number>()
          for (let k = 0; k < data.chains.length; k++) {
            if (!entry.hiddenChains.includes(k)) continue
            for (const ri of data.chains[k].residueIdx) hiddenRes.add(ri)
          }
          for (let i = 0; i < data.atoms.count; i++) {
            if (hiddenRes.has(data.atomResidue[i])) continue
            pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
          }
        } else {
          for (let i = 0; i < data.atoms.count; i++) pts.push([data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2]])
        }
      }
    }
    return pts
  }

  // ---------- 截图 ----------

  capture(opts: { scale?: number; transparent?: boolean } = {}): string {
    const scale = opts.scale ?? 1
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 600
    const prevRatio = this.renderer.getPixelRatio()
    const prevBg = this.scene.background
    const prevFog = this.scene.fog
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(Math.round(w * scale), Math.round(h * scale), false)
    if (opts.transparent) {
      // 透明底：绕过 composer 直接渲染（AO 需要不透明底）
      this.scene.background = null
      this.scene.fog = null
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.render(this.scene, this.activeCamera)
    } else if ((this.settings?.ssao && !this.gtaoFailed) || (this.settings?.outline && !this.edgeFailed)) {
      // 开启 AO / 轮廓线时截图走 composer（与视口渲染路径一致；尺寸同步防 FBO 不完整）
      this.ensureComposer()
      if (this.composer) {
        const cw = Math.round(w * scale)
        const ch = Math.round(h * scale)
        this.composer.setPixelRatio(1)
        this.composer.setSize(cw, ch)
        this.syncDepthTextureSize(cw, ch)
        // 轮廓线 uniforms 同步到截图尺寸（否则沿用视口分辨率 → 描边粗细在截图中失准）；
        // 粗细按截图/视口像素比等比补偿（与 ray 超采样补偿同式，WYSIWYG）
        if (this.edgePass) {
          const thicknessScale = Math.max(1, Math.min(4, cw / Math.max(1, w * prevRatio)))
          this.syncEdgePass(cw, ch, thicknessScale)
        }
        this.composer.render()
      } else {
        this.renderer.render(this.scene, this.activeCamera)
      }
    } else {
      this.renderer.render(this.scene, this.activeCamera)
    }
    const url = this.renderer.domElement.toDataURL('image/png')
    this.scene.background = prevBg
    this.scene.fog = prevFog
    this.renderer.setPixelRatio(prevRatio)
    this.renderer.setSize(w, h, false)
    if (this.composer) {
      // 恢复时必须同步 depthTexture（否则目标尺寸/深度尺寸错位 → FBO 不完整 → composer 静默空帧）
      this.syncComposerTargets(w, h, prevRatio)
    }
    return url
  }

  /**
   * PyMOL ray 风格高质量静帧渲染：软阴影（PCFSoft 2048²）+ 真超采样（内部 ss× 渲染后高质量降采样）+
   * 场景包围盒自适应阴影相机。大场景可能阻塞数秒；完成后恢复全部状态（阴影/光照/画布尺寸），返回 PNG dataURL。
   */
  async rayRender(opts: { width?: number; supersample?: number; transparent?: boolean } = {}): Promise<{ url: string; w: number; h: number; ms: number }> {
    const t0 = performance.now()
    const cw = this.container.clientWidth || 800
    const ch = this.container.clientHeight || 600
    // 目标尺寸：默认视口 2×（上限 2560）；高度按视口纵横比推导
    const targetW = Math.max(320, Math.min(2560, Math.round(opts.width ?? cw * 2)))
    const targetH = Math.max(240, Math.round((targetW * ch) / cw))
    const ss = Math.max(1, Math.min(2, opts.supersample ?? 1.5))
    const w = Math.round(targetW * ss)
    const h = Math.round(targetH * ss)

    // 场景包围盒（可见结构原子）→ 阴影相机范围
    const pts = this.collectFitPoints(undefined)
    let center = new THREE.Vector3()
    let radius = 40
    if (pts.length) {
      const min = [Infinity, Infinity, Infinity] as [number, number, number]
      const max = [-Infinity, -Infinity, -Infinity] as [number, number, number]
      for (const p of pts) {
        for (let d = 0; d < 3; d++) {
          if (p[d] < min[d]) min[d] = p[d]
          if (p[d] > max[d]) max[d] = p[d]
        }
      }
      center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
      radius = Math.max(8, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
    }

    // —— 保存现场 ——
    const prevRatio = this.renderer.getPixelRatio()
    const prevW = cw, prevH = ch
    const prevBg = this.scene.background
    const prevFog = this.scene.fog
    const prevShadowEnabled = this.renderer.shadowMap.enabled
    const prevShadowType = this.renderer.shadowMap.type
    const prevKeyPos = this.keyLight.position.clone()
    const prevKeyCast = this.keyLight.castShadow
    const prevAmbIntensity = this.ambientLight.intensity
    const prevFillIntensity = this.fillLight.intensity
    const prevTargetInScene = this.keyLight.target.parent === this.scene
    const prevTargetPos = this.keyLight.target.position.clone()

    // —— 开启阴影 ——
    // 主光方向保持不变（方向光只看 position→target 方向），把光源推远到包围盒外以容纳阴影相机
    const keyDir = new THREE.Vector3().subVectors(prevKeyPos, new THREE.Vector3(0, 0, 0))
    if (keyDir.lengthSq() < 1e-6) keyDir.set(4, 8, 5)
    keyDir.normalize()
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.keyLight.castShadow = true
    this.keyLight.target.position.copy(center)
    this.scene.add(this.keyLight.target)
    this.keyLight.position.copy(center).addScaledVector(keyDir, radius * 3.2)
    this.keyLight.shadow.mapSize.set(2048, 2048)
    this.keyLight.shadow.bias = -0.0004
    this.keyLight.shadow.normalBias = Math.max(0.03, radius * 0.002)
    const scam = this.keyLight.shadow.camera as THREE.OrthographicCamera
    const ext = radius * 1.9
    scam.left = -ext; scam.right = ext; scam.top = ext; scam.bottom = -ext
    scam.near = 1
    scam.far = radius * 6.5
    scam.updateProjectionMatrix()
    // 阴影期间抬一点环境光抵消投影变暗，压一点填充光突出阴影层次
    this.ambientLight.intensity = prevAmbIntensity + 0.18
    this.fillLight.intensity = Math.max(0.1, prevFillIntensity * 0.7)
    // PyMOL ray 语义：阴影落在分子自身与分子之间（螺旋互投影/配体投口袋），无接影地平面。
    // 旧版曾在此添加 ShadowMaterial 接影板 emulate「底部暗影」——但透明平面写深度后
    // 与 composer 路径相容性差（边缘检测把它当几何体 → ACES 映射成灰色矩形 + Sobel 描出硬边框，
    // 即用户反馈的「看到了 box 的边界」），且平面自身被误标 castShadow 产生自阴影噪声，已移除。

    // 阴影投射/接收者限定为分子 rep（含对称伴侣克隆）；测量线/氢键/接触标记/密度图/高亮球
    // 不参与投射（旧版全场景 traverse 会把它们一并标 castShadow——标记球在阴影图上留下小黑斑）
    const touched: THREE.Object3D[] = []
    const mats = new Set<THREE.Material>()
    const markShadowCasters = (root: THREE.Object3D) => {
      root.traverse(o => {
        const m = o as THREE.Mesh | THREE.InstancedMesh
        if ((m as THREE.Mesh).isMesh || (m as THREE.InstancedMesh).isInstancedMesh) {
          if (!m.visible) return
          m.castShadow = true
          m.receiveShadow = true
          touched.push(m)
          const mm = m.material
          if (Array.isArray(mm)) mm.forEach(x => mats.add(x))
          else if (mm) mats.add(mm)
        }
      })
    }
    for (const [id, view] of this.views) {
      for (const rv of view.reps.values()) {
        if (!rv.build.group.visible) continue
        markShadowCasters(rv.build.group)
      }
      const sym = this.symmetryGroups.get(id)
      if (sym) markShadowCasters(sym)
    }
    for (const m of mats) m.needsUpdate = true

    // —— 超采样渲染 ——
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(w, h, false)
    this.renderer.shadowMap.needsUpdate = true
    let url = ''
    try {
      if (opts.transparent) {
        this.scene.background = null
        this.scene.fog = null
        this.renderer.setClearColor(0x000000, 0)
        this.renderer.render(this.scene, this.activeCamera)
      } else if ((this.settings?.ssao && !this.gtaoFailed) || (this.settings?.outline && !this.edgeFailed)) {
        // ray 静帧同样享用 GTAO / 轮廓线（超采样尺寸下同步 uniforms）
        this.ensureComposer()
        if (this.composer && (this.gtaoPass || this.edgePass)) {
          const wantSsao = !!this.settings?.ssao && !this.gtaoFailed
          const wantOutline = !!this.settings?.outline && !this.edgeFailed
          // 尺寸同步：整数化 + depthTexture 对齐（分数尺寸 → FBO 不完整）
          this.syncComposerTargets(w, h, 1)
          if (this.gtaoPass) {
            this.gtaoPass.enabled = wantSsao
            this.gtaoPass.blendIntensity = this.settings?.ssaoIntensity ?? 1
            this.gtaoPass.updateGtaoMaterial({ radius: this.settings?.ssaoRadius ?? 3 })
          }
          // 轮廓线 pass 常开（背景还原 + 可选描边）
          if (this.edgePass) {
            this.edgePass.enabled = true
            // 轮廓线 WYSIWYG：粗细按超采样倍率等比补偿——导出图缩回视口尺寸时线条视觉重量与实时视口一致。
            // 旧实现用固定 px（3600px 导出里 1px 线缩回后近不可见；用户为补偿而调大参数又让视口变成线稿感
            // ——多轮遗留「ray+outline 线稿化」的根因）。补偿上限 4×，防极端宽导出线条过粗。
            const outlineScale = Math.max(1, Math.min(4, w / Math.max(1, cw * prevRatio)))
            this.syncEdgePass(w, h, outlineScale)
          }
          this.resetComposerBuffers()
          this.composer.render()
        } else {
          this.renderer.render(this.scene, this.activeCamera)
        }
      } else {
        this.renderer.render(this.scene, this.activeCamera)
      }
      // toDataURL 必须在恢复尺寸前读取（setSize 会清空画布）
      const hiUrl = this.renderer.domElement.toDataURL('image/png')
      // —— 真超采样（SSAA）：内部以 ss 倍分辨率渲染，高质量降采样回目标尺寸 ——
      // 旧实现直接导出高分辨率画布（文件名却标目标尺寸），超采样倍率从未真正发挥抗锯齿作用——
      // 导出图像素级锯齿与未超采样完全一致（用户反馈「清晰度比较低」的根因）。
      // 降采样后：边缘阶梯破 1.5× 重采样平滑，导出尺寸与文件名/返回值诚实一致。
      if (ss > 1.001 && hiUrl) {
        const src = new Image()
        await new Promise<void>((res, rej) => {
          src.onload = () => res()
          src.onerror = () => rej(new Error('ssaa-decode'))
          src.src = hiUrl
        })
        const off = document.createElement('canvas')
        off.width = targetW
        off.height = targetH
        const octx = off.getContext('2d')
        if (octx) {
          octx.imageSmoothingEnabled = true
          octx.imageSmoothingQuality = 'high'
          octx.drawImage(src, 0, 0, targetW, targetH)
          url = off.toDataURL('image/png')
        } else {
          url = hiUrl
        }
      } else {
        url = hiUrl
      }
    } finally {
      // —— 恢复现场（无论渲染成败） ——
      for (const o of touched) { o.castShadow = false; o.receiveShadow = false }
      for (const m of mats) m.needsUpdate = true
      this.renderer.shadowMap.enabled = prevShadowEnabled
      this.renderer.shadowMap.type = prevShadowType
      this.keyLight.castShadow = prevKeyCast
      this.keyLight.position.copy(prevKeyPos)
      this.keyLight.target.position.copy(prevTargetPos)
      if (!prevTargetInScene) this.scene.remove(this.keyLight.target)
      this.ambientLight.intensity = prevAmbIntensity
      this.fillLight.intensity = prevFillIntensity
      this.scene.background = prevBg
      this.scene.fog = prevFog
      this.renderer.setPixelRatio(prevRatio)
      this.renderer.setSize(prevW, prevH, false)
      if (this.composer) {
        // 恢复时同步目标尺寸（含 depthTexture 对齐，防 FBO 不完整 → composer 静默空帧）
        this.syncComposerTargets(prevW, prevH, prevRatio)
      }
    }
    return { url, w: targetW, h: targetH, ms: performance.now() - t0 }
  }

  get hasStructures() {
    return this.hasContent
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onCancelCamAnim)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.clearRubberBand()
    this.controls.dispose()
    for (const view of this.views.values()) {
      for (const rv of view.reps.values()) rv.build.dispose()
    }
    this.views.clear()
    this.symmetryGroups.clear()
    this.clearGroupChildren(this.poreGroup)
    this.clearGroupChildren(this.membraneGroup)
    this.disposeMapGeometry()
    this.stereoEffect?.dispose()
    this.stereoEffect = null
    this.disposeComposer()
    if (this.recorder && this.recorder.state === 'recording') {
      try { this.recorder.stop() } catch { /* ignore */ }
    }
    this.recorder = null
    this.hbondWorker?.terminate()
    this.sasaWorker?.terminate()
    this.sasaWorker = null
    this.hbondWorker = null
    // 并发闸销毁：释放全部在飞槽（防排队任务死等）
    this.hbondSlots.dispose()
    this.sasaSlots.dispose()
    this.hbondPending.clear()
    this.sasaPending.clear()
    this.ensemblePlay = null
    this.ensembleDirty = null
    // 坐标轴指示器资源释放（几何/材质/圆盘纹理；轴字母纹理走全局缓存不单独释放）
    if (this.gizmoScene) {
      const seen = new Set<THREE.Material>()
      this.gizmoScene.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
        const sprite = o as THREE.Sprite
        const mat = (sprite.isSprite ? sprite.material : (mesh.isMesh ? mesh.material : null)) as THREE.Material | THREE.Material[] | null
        if (mat && !Array.isArray(mat) && !seen.has(mat)) { seen.add(mat); mat.dispose() }
      })
      this.gizmoDiscTex?.dispose()
      this.gizmoDiscTex = null
      this.gizmoScene = null
      this.gizmoCamera = null
      this.gizmoAxisParts = []
      this.gizmoHover = null
    }
    this.renderer.dispose()
    if (this.canvas.parentElement === this.container) this.container.removeChild(this.canvas)
  }
}
