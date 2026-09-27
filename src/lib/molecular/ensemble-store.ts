// NMR ensemble 多构象动画状态（独立轻量 store，避免与主 store visualRev 循环）
import { create } from 'zustand'

interface EnsembleStore {
  /** 播放目标结构（有 ensemble 数据的结构才可播） */
  structureId: string | null
  playing: boolean
  /** 当前帧（整数，UI 显示/跳帧用；插值帧由引擎内部维护） */
  frame: number
  total: number
  fps: number
  interp: boolean
  loop: boolean
  setTarget: (structureId: string | null, total: number) => void
  setPlaying: (playing: boolean) => void
  setFrame: (frame: number) => void
  setFps: (fps: number) => void
  setInterp: (interp: boolean) => void
  setLoop: (loop: boolean) => void
}

export const useEnsembleStore = create<EnsembleStore>(set => ({
  structureId: null,
  playing: false,
  frame: 0,
  total: 0,
  fps: 8,
  interp: true,
  loop: true,
  setTarget: (structureId, total) => set(s =>
    s.structureId === structureId ? { total } : { structureId, total, frame: 0, playing: false },
  ),
  setPlaying: playing => set({ playing }),
  setFrame: frame => set({ frame }),
  setFps: fps => set({ fps }),
  setInterp: interp => set({ interp }),
  setLoop: loop => set({ loop }),
}))
