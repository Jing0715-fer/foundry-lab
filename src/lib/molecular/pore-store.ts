// 孔道剖面轻量 store（独立于主 store，避免 visualRev 循环——与 contacts-store 同模式）
import { create } from 'zustand'

/** 单个采样点：轴向位置 t（Å，沿通道主轴）+ 孔半径 r（Å，球拟合） */
export interface PoreSample {
  t: number
  r: number
}

/** HOLE 式孔道剖面结果（世界坐标；结构叠合/位移后需重算） */
export interface PoreResult {
  structureId: string
  structureName: string
  /** 通道主轴（主方差轴）：过质心的原点 + 单位方向 */
  origin: [number, number, number]
  dir: [number, number, number]
  samples: PoreSample[]
  /** 显示封顶半径（Å） */
  maxR: number
  /** 最窄处（收缩点） */
  constriction: { t: number; r: number }
  /** 蛋白沿轴跨度（Å） */
  span: number
  /** 轴向投影范围（含端点） */
  tMin: number
  tMax: number
  /** 参与计算的聚合物原子数 */
  nAtoms: number
  /** 计算耗时（ms） */
  ms: number
}

interface PoreState {
  result: PoreResult | null
  /** 3D 环带可见（剖面卡上的眼睛开关） */
  visible: boolean
  set: (r: PoreResult) => void
  setVisible: (v: boolean) => void
  clear: () => void
}

export const usePoreStore = create<PoreState>()(set => ({
  result: null,
  visible: true,
  set: r => set({ result: r, visible: true }),
  setVisible: v => set({ visible: v }),
  clear: () => set({ result: null, visible: true }),
}))
