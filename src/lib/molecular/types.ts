// 共享类型定义
import type { ColorScheme } from './colors'
import type { ChainType } from './parser'
import type { DualText } from '@/i18n'

export type RepType = 'cartoon' | 'putty' | 'ballstick' | 'sticks' | 'spacefill' | 'lines' | 'surface'

export const REP_LABELS: Record<RepType, DualText> = {
  cartoon: { zh: 'Cartoon 带状', en: 'Cartoon ribbon' },
  putty: { zh: 'Putty B 因子管', en: 'Putty B-factor tube' },
  ballstick: { zh: '球棍', en: 'Ball-and-stick' },
  sticks: { zh: '棍状', en: 'Sticks' },
  spacefill: { zh: '空间填充', en: 'Space fill' },
  lines: { zh: '线框', en: 'Wireframe' },
  surface: { zh: '分子表面', en: 'Surface' },
}

export interface RepConfig {
  id: string
  type: RepType
  /** 选择表达式 */
  selection: string
  colorScheme: ColorScheme
  uniformColor: string
  visible: boolean
  // 参数
  ballScale: number      // spacefill 半径倍率
  stickRadius: number    // 棍半径 (Å)
  cartoonWidth: number   // cartoon 宽度倍率
  probe: number          // surface 探针半径 (Å)
  opacity: number        // surface 不透明度
  /** putty：管径映射 B 因子上限（Å²，仅 putty 用；0=自动取结构分位） */
  puttyRange: number
  /** 表达式求值错误 */
  error?: string
}

export function defaultRep(type: RepType, selection = 'all', colorScheme: ColorScheme = 'element'): RepConfig {
  return {
    id: Math.random().toString(36).slice(2, 10),
    type,
    selection,
    colorScheme,
    uniformColor: '#c9cdd4',
    visible: true,
    ballScale: 1,
    stickRadius: 0.16,
    cartoonWidth: 1,
    probe: 1.2,
    opacity: 1,
    puttyRange: 0,
  }
}

export interface ChainSummary {
  id: string
  type: ChainType
  residues: number
  atoms: number
  color: string
}

export interface LigandSummary {
  resName: string
  count: number
  chainIds: string
}

/** 刚体变换（叠合累计，会话持久化用） */
export interface RigidTransform {
  quat: [number, number, number, number]
  translation: [number, number, number]
}

export interface StructureEntry {
  id: string
  name: string
  format: 'pdb' | 'cif'
  visible: boolean
  /** 链组级隔离（isolate / chains hide / 面板眼睛开关）：被隐藏的链组索引列表。
   *  空/undefined = 全部可见（默认态）；引擎构建 rep 时过滤这些链组的原子 */
  hiddenChains?: number[]
  /** 重建版本号（reps / overrides 变化时递增） */
  rev: number
  reps: RepConfig[]
  /** 原子级颜色覆盖 atomIdx → css color */
  colorOverrides: Record<number, string>
  /** 累计刚体变换（superpose 应用后记录，会话恢复时重放） */
  transform?: RigidTransform
  /** 晶体对称伴侣（symmetry 命令/面板触发；radius=0 表示关闭） */
  symmetry?: { radius: number; count: number }
  summary: {
    atoms: number; residues: number; chains: number; bonds: number
    hydrogens: number; waters: number; ligandResidues: number
    /** 独立配体分子数（连通分量，多残基配体计为 1） */
    ligandMolecules: number
  }
  chains: ChainSummary[]
  ligands: LigandSummary[]
  meta: { title: string; method: string; resolution: number | null; pdbId: string | null }
  hasSS: boolean
  loadMs: number
}

export interface SelectionState {
  structureId: string | null
  indices: number[]
  rev: number
}

export interface NamedSelection {
  name: string
  structureId: string
  expr: string | null
  indices: number[] | null
  count: number
}

export type MeasureMode = 'off' | 'distance' | 'angle' | 'dihedral'

export interface Measurement {
  id: string
  structureId: string
  type: 'distance' | 'angle' | 'dihedral'
  atoms: number[]
  value: number
}

export interface AtomLabel {
  id: string
  structureId: string
  atomIdx: number
  text: string
}

export interface Settings {
  background: string
  /** 背景已由用户/agent 显式设定（bg / set background）——主题切换不再跟随覆盖，尊重显式选择 */
  backgroundPinned: boolean
  fog: boolean
  fogStrength: number
  fov: number
  ortho: boolean
  spin: boolean
  spinSpeed: number
  /** 相机摇摆（ChimeraX rock）：左右正弦摆动 ±25° */
  rock: boolean
  /** 俯仰限位：拖拽旋转限制在 ±78° 仰角内（不过顶/不过底，防无限制翻滚；view top/bottom 轴视角不受影响） */
  orbitClamp: boolean
  /** 视角过渡手感：quick=敏锐 350ms · normal=标准 650ms · cinematic=电影 1200ms（书签/正交视角/场景恢复的平滑飞行时长） */
  camTransition: 'quick' | 'normal' | 'cinematic'
  slab: boolean
  slabThickness: number
  /** 切层中心沿视线的偏移（Å；0 = 环绕目标处，正 = 远离相机） */
  slabOffset: number
  /** 切层截面封闭（cap）：背面渲染统一平面色，剖面呈实心（出版级截面图） */
  slabCap: boolean
  /** 截面封盖颜色（CSS hex；随会话持久化） */
  capColor: string
  /** 封盖深度明暗：剖面按视深由亮到暗渐变（远端加深），呈现立体层次 */
  capShading: boolean
  hideHydrogens: boolean
  hideWater: boolean
  quality: 'low' | 'medium' | 'high'
  /** 氢键网络 */
  showHBonds: boolean
  hbondMaxDist: number
  hbondIncludeWater: boolean
  hbondSelOnly: boolean
  /** GTAO 环境光遮蔽（提升立体感） */
  ssao: boolean
  ssaoIntensity: number
  ssaoRadius: number
  /** 灯光：环境光倍率（含环境贴图贡献） */
  lightAmbient: number
  /** 灯光：主光（平行光）倍率 */
  lightKey: number
  /** 灯光：补光倍率 */
  lightFill: number
  /** 高光（镜面反射/环境反射）开关 */
  specular: boolean
  /** 红蓝立体（Anaglyph）渲染 */
  stereo: boolean
  /** 视口右上角 3D 坐标轴指示器（朝向罗盘；点击轴可对齐视角） */
  showAxes: boolean
  /** 晶胞盒（CRYST1 单胞平行六面体线框；show cell 开启） */
  showCell: boolean
  /** 状态栏 FPS/性能指示器（引擎每 500ms 上报） */
  showFps: boolean
  /** 自动性能模式：帧率持续偏低时自动降级（关后处理/降像素比），恢复后自动还原 */
  autoPerf: boolean
  /** 出版级轮廓线（Sobel 深度+亮度边缘检测后处理） */
  outline: boolean
  /** 轮廓线强度（0-3：线条不透明度倍率） */
  outlineStrength: number
  /** 轮廓线粗细（1-4 px 采样步长） */
  outlineThickness: number
  /** 脂双层示意板（membrane 命令：沿活动结构主轴定向的 VMD 惯例橙头基+灰核心） */
  showMembrane: boolean
  /** 脂膜厚度（Å，20-60；典型生物膜 ~30-40） */
  membraneThickness: number
  /** 序列条展开高度档位（紧凑/标准/加高；随会话持久化） */
  sequenceHeight: 'compact' | 'normal' | 'tall'
  /** 序列条视口聚焦指示：当前相机视野内残基高亮（引擎按视锥+切层计算） */
  seqFocus: boolean
  /** 控制台日志区高度档位（紧凑/标准/加高；随会话持久化） */
  consoleHeight: 'compact' | 'normal' | 'tall'
}

export function defaultSettings(): Settings {
  return {
    background: '#ffffff',
    backgroundPinned: false,
    fog: false,
    fogStrength: 0.5,
    fov: 45,
    ortho: false,
    spin: false,
    spinSpeed: 2,
    rock: false,
    orbitClamp: true,
    camTransition: 'normal',
    slab: false,
    slabThickness: 18,
    slabOffset: 0,
    slabCap: true,
    capColor: '#ccd2d9',
    capShading: true,
    hideHydrogens: false,
    hideWater: false,
    quality: 'high',
    showHBonds: false,
    hbondMaxDist: 3.5,
    hbondIncludeWater: false,
    /** 默认仅选择集：全局网络对大结构是视觉噪声（用户两轮反馈）；PyMOL 专业工作流同样按范围显示 */
    hbondSelOnly: true,
    ssao: false,
    ssaoIntensity: 1,
    ssaoRadius: 3,
    lightAmbient: 1,
    lightKey: 1,
    lightFill: 1,
    specular: true,
    stereo: false,
    showAxes: true,
    showCell: false,
    showFps: false,
    autoPerf: true,
    outline: false,
    outlineStrength: 1,
    outlineThickness: 1.5,
    showMembrane: false,
    membraneThickness: 34,
    sequenceHeight: 'normal',
    seqFocus: true,
    consoleHeight: 'normal',
  }
}
