// 引擎就绪队列：欢迎页首发加载时结构先于 MolViewer 挂载就位（dynamic chunk 异步加载），
// 相机取景 / 会话相机恢复 / 对称伴侣重建等 engineRef 依赖操作需入队，引擎挂载后统一冲刷。
// 引擎已挂载（常规工作台流程）时行为退化为立即执行——与原 rAF 调用路径等价。
import { engineRef } from './store'

const queue: (() => void)[] = []

/** engineRef 可用时立即执行，否则入队等待 MolViewer 挂载冲刷 */
export function whenEngineReady(cb: () => void) {
  if (engineRef.current) {
    cb()
    return
  }
  queue.push(cb)
}

/** MolViewer 挂载并完成首次 sync 后调用：冲刷排队操作 */
export function flushEngineReady() {
  if (!queue.length) return
  const cbs = queue.splice(0, queue.length)
  for (const cb of cbs) cb()
}
