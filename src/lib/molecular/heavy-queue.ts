// 全局重计算并发闸：氢键 / SASA / ΔSASA / 跨结构 ΔSASA / 密度图合成等 Worker 任务
// 共享最多 2 个并发槽——第三个重任务自动排队等待，避免多 Worker 同时满载
// 造成内存尖峰与 CPU 争抢（用户仍可继续操作视图，队列空出后自动继续）。
// 投递侧：await lane.acquire(label) →（过期检查，过期则直接 release）→ lane.post(release) → postMessage
// 结果侧：lane.releaseOne()（每条结果消息）；worker 异常 / 引擎销毁：lane.releaseAll()
import { tt } from '@/i18n'
import { useMolStore } from './store'

const MAX_CONCURRENT = 2
let active = 0
const waiting: Array<() => void> = []

/**
 * 获取一个重计算并发槽（可能排队等待）。返回释放函数（幂等）。
 * @param label 排队时写控制台的提示名（如「SASA 计算」）
 */
export async function acquireHeavySlot(label: string): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    useMolStore.getState().appendLog('out', tt({ zh: `${label} 排队等待（重计算并发已满，空出后自动继续）…`, en: `${label} queued (heavy-compute concurrency full, resumes automatically when a slot frees)…` }))
    await new Promise<void>(resolve => { waiting.push(resolve) })
  }
  active++
  let released = false
  return () => {
    if (released) return
    released = true
    active--
    const next = waiting.shift()
    if (next) next()
  }
}

/**
 * 单 worker 的槽位通道：跟踪「已实际 postMessage」的槽。
 * acquire 后若任务过期（不投递），调用方直接 release()——不进入通道，
 * 保证 releaseOne 与实际投递消息一一对应。
 */
export class SlotLane {
  private releases: Array<() => void> = []
  private disposed = false

  /** 获取槽（排队等待）。返回释放函数；投递成功后须调 post() 登记 */
  async acquire(label: string): Promise<() => void> {
    if (this.disposed) return () => {}
    const release = await acquireHeavySlot(label)
    if (this.disposed) { release(); return () => {} }
    return release
  }

  /** 登记已投递消息的槽（worker 结果到达时由 releaseOne 释放） */
  post(release: () => void) {
    if (this.disposed) { release(); return }
    this.releases.push(release)
  }

  /** worker 收到一条结果消息：释放最早投递的槽（与消息序一致，FIFO） */
  releaseOne() {
    const r = this.releases.shift()
    r?.()
  }

  /** worker 异常 / 引擎销毁：释放全部在飞槽（防死锁） */
  releaseAll() {
    const all = this.releases.splice(0)
    for (const r of all) r()
  }

  /** 引擎销毁标记（此后 acquire 立即空操作） */
  dispose() {
    this.disposed = true
    this.releaseAll()
  }
}
