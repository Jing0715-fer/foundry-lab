// SASA 分析轻量 store（独立于主 store，避免 visualRev 循环）
import { create } from 'zustand'

export interface TopResidue {
  resIdx: number
  /** 残基 SASA（Å²） */
  area: number
}

interface SasaStore {
  /** 计算中（结构级 SASA） */
  computing: boolean
  /** 结果归属结构 */
  structureId: string | null
  /** 总 SASA（Å²） */
  total: number
  hydrophobic: number
  polar: number
  het: number
  /** 计算耗时 ms */
  ms: number
  /** 采样参数（复算/展示） */
  probe: number
  nPoints: number
  /** Top 暴露残基（降序，≤ 12 条） */
  topResidues: TopResidue[]
  /** 界面埋藏面积（ΔSASA）结果 */
  buried: {
    computing: boolean
    structureId: string | null
    /** 掩码快照来源（contacts 结果） */
    atomsA: number
    atomsB: number
    buriedA: number
    buriedB: number
    /** 界面核心残基（ΔSASA > 1 Å²；跨结构时索引各自结构的残基表） */
    coreA: number[]
    coreB: number[]
    ms: number
    /** 跨结构模式（null = 单结构 contacts；核心残基索引语义见上） */
    cross: { idA: string; idB: string; labelA: string; labelB: string } | null
  } | null
  setComputing: (v: boolean) => void
  setResult: (r: {
    structureId: string | null
    total: number
    hydrophobic: number
    polar: number
    het: number
    ms: number
    probe: number
    nPoints: number
    topResidues: TopResidue[]
  }) => void
  setBuried: (r: SasaStore['buried']) => void
  setBuriedComputing: (v: boolean) => void
  clear: () => void
}

export const useSasaStore = create<SasaStore>()(set => ({
  computing: false,
  structureId: null,
  total: 0,
  hydrophobic: 0,
  polar: 0,
  het: 0,
  ms: 0,
  probe: 1.4,
  nPoints: 92,
  topResidues: [],
  buried: null,
  setComputing: v => set({ computing: v }),
  setResult: r => set({
    computing: false,
    structureId: r.structureId,
    total: r.total,
    hydrophobic: r.hydrophobic,
    polar: r.polar,
    het: r.het,
    ms: r.ms,
    probe: r.probe,
    nPoints: r.nPoints,
    topResidues: r.topResidues,
  }),
  setBuried: r => set(s => ({ buried: r ? { ...r, cross: r.cross ?? null } : null })),
  setBuriedComputing: v => set(s => (s.buried ? { buried: { ...s.buried, computing: v } } : {})),
  clear: () => set({
    computing: false, structureId: null, total: 0, hydrophobic: 0, polar: 0, het: 0,
    ms: 0, topResidues: [], buried: null,
  }),
}))
