// 视口聚焦状态：引擎按相机/切层状态计算活动结构「残基级在视野内」掩码
// 序列条据此高亮当前视口可见的残基（Mol* 风格 viewport 指示）
import { create } from 'zustand'

interface ViewportState {
  /** 计算所针对的结构（与序列条活动结构一致才生效） */
  structureId: string | null
  /** 残基可见性（1 = 视野内；索引对应 StructureData.residues） */
  visible: Uint8Array | null
  /** 计算帧号（调试/测试用） */
  rev: number
  set: (structureId: string | null, visible: Uint8Array | null) => void
}

export const useViewportStore = create<ViewportState>(set => ({
  structureId: null,
  visible: null,
  rev: 0,
  set: (structureId, visible) => set(s => ({ structureId, visible, rev: s.rev + 1 })),
}))
