// 悬停信息轻量 store（避免整页重渲染）
import { create } from 'zustand'

interface HoverStore {
  text: string | null
  setText: (t: string | null) => void
}

export const useHoverStore = create<HoverStore>()(set => ({
  text: null,
  setText: text => set({ text }),
}))
