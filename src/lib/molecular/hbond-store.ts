// 氢键统计轻量 store（独立于主 store，避免 visualRev 循环）
import { create } from 'zustand'

/** 残基级氢键对汇总（分析面板「氢键网络」表格用；residue 为结构内残基表索引） */
export interface HBondPairSummary {
  structureId: string
  donorRes: number
  acceptorRes: number
  minDist: number
  count: number
}

interface HBondStore {
  count: number
  waterCount: number
  visible: boolean
  /** 大结构异步检测中（Web Worker） */
  computing: boolean
  /** 活动结构的残基对汇总（空数组 = 无数据/未开启） */
  pairs: HBondPairSummary[]
  setStats: (count: number, waterCount: number, visible: boolean) => void
  setComputing: (computing: boolean) => void
  setPairs: (pairs: HBondPairSummary[]) => void
}

export const useHBondStore = create<HBondStore>()(set => ({
  count: 0,
  waterCount: 0,
  visible: false,
  computing: false,
  pairs: [],
  setStats: (count, waterCount, visible) => set({ count, waterCount, visible }),
  setComputing: computing => set({ computing }),
  setPairs: pairs => set({ pairs }),
}))
