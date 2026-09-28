// 接触分析轻量 store（独立于主 store，避免 visualRev 循环）
import { create } from 'zustand'
import type { ContactPair, CrossContactPair } from './contacts'

/** 跨结构接触上下文（xcontacts 命令产生；连线渲染需要两侧结构） */
export interface CrossContext {
  idA: string
  idB: string
  labelA: string
  labelB: string
  exprA: string
  exprB: string
  cutoff: number
  maskA: Uint8Array
  maskB: Uint8Array
}

interface ContactStore {
  /** A/B 组选择表达式 */
  aExpr: string
  bExpr: string
  /** 接触距离上限（Å） */
  cutoff: number
  /** 3D 接触连线可见 */
  visible: boolean
  /** 结果归属结构 */
  structureId: string | null
  pairs: ContactPair[]
  residuesA: number[]
  residuesB: number[]
  atomsA: number
  atomsB: number
  /** 表达式求值错误 */
  errors: { a?: string; b?: string }
  /** 是否已按结构填充默认表达式（切换结构后重新默认） */
  defaulted: boolean
  /** 跨结构模式上下文（null = 单结构 contacts） */
  cross: CrossContext | null
  /** 跨结构残基对（cross 非空时有效，局部索引） */
  crossPairs: CrossContactPair[]
  setExpr: (side: 'a' | 'b', expr: string) => void
  setCutoff: (cutoff: number) => void
  setVisible: (visible: boolean) => void
  setResult: (r: {
    structureId: string | null
    pairs: ContactPair[]
    residuesA: number[]
    residuesB: number[]
    atomsA: number
    atomsB: number
    errors?: { a?: string; b?: string }
  }) => void
  /** 跨结构结果（清空单结构结果，切换渲染路径） */
  setCrossResult: (ctx: CrossContext, pairs: CrossContactPair[], residuesA: number[], residuesB: number[], atomsA: number, atomsB: number) => void
  clear: () => void
}

export const useContactStore = create<ContactStore>()(set => ({
  aExpr: '',
  bExpr: '',
  cutoff: 4.5,
  visible: true,
  structureId: null,
  pairs: [],
  residuesA: [],
  residuesB: [],
  atomsA: 0,
  atomsB: 0,
  errors: {},
  defaulted: false,
  cross: null,
  crossPairs: [],
  setExpr: (side, expr) => set(s => ({
    [side === 'a' ? 'aExpr' : 'bExpr']: expr,
    defaulted: true,
    errors: side === 'a' ? { ...s.errors, a: undefined } : { ...s.errors, b: undefined },
  }) as Partial<ContactStore>),
  setCutoff: cutoff => set({ cutoff }),
  setVisible: visible => set({ visible }),
  setResult: r => set({
    structureId: r.structureId,
    pairs: r.pairs,
    residuesA: r.residuesA,
    residuesB: r.residuesB,
    atomsA: r.atomsA,
    atomsB: r.atomsB,
    errors: r.errors ?? {},
    cross: null,
    crossPairs: [],
  }),
  setCrossResult: (ctx, pairs, residuesA, residuesB, atomsA, atomsB) => set({
    cross: ctx,
    crossPairs: pairs,
    // 同步 residues/atoms 供面板显示（局部索引语义 + 两侧结构各自解读）
    residuesA,
    residuesB,
    atomsA,
    atomsB,
    structureId: ctx.idA,
    pairs: [],
    errors: {},
    aExpr: ctx.exprA,
    bExpr: ctx.exprB,
    cutoff: ctx.cutoff,
  }),
  clear: () => set({
    structureId: null, pairs: [], residuesA: [], residuesB: [],
    atomsA: 0, atomsB: 0, errors: {}, cross: null, crossPairs: [],
  }),
}))
