// 性能指示器状态（引擎每 500ms 上报；状态栏订阅渲染）
import { create } from 'zustand'

export interface PerfSnapshot {
  fps: number
  /** 帧耗时均值（ms） */
  frameMs: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
}

interface PerfState extends PerfSnapshot {
  /** 自动性能模式当前处于降级状态（后处理已临时关闭、像素比已降低） */
  degraded: boolean
  set: (snap: PerfSnapshot) => void
  setDegraded: (v: boolean) => void
}

export const usePerfStore = create<PerfState>()(set => ({
  fps: 0,
  frameMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  degraded: false,
  set: snap => set(snap),
  setDegraded: v => set({ degraded: v }),
}))

/** FPS 分级颜色（≥55 绿 / ≥30 琥珀 / <30 红） */
export function fpsTone(fps: number): 'green' | 'amber' | 'red' {
  return fps >= 55 ? 'green' : fps >= 30 ? 'amber' : 'red'
}
