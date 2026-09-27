'use client'

// 横向滚动行 + 动态双缘渐隐（mask 实现，不依赖背景色）：
// 内容超宽时右缘渐隐提示可滚动；已滚动时左缘渐隐；滚到头自动摘除对应侧
// ——解决「序列条/时间轴等长内容横向滚动无提示，看起来像内容被裁掉」的可用性问题
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function FadeEdge({
  children,
  className,
  edge = 24,
}: {
  children: ReactNode
  className?: string
  /** 渐隐宽度（px），与 globals.css 的 .mol-fade-* 渐变宽度保持一致 */
  edge?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [fadeL, setFadeL] = useState(false)
  const [fadeR, setFadeR] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const remaining = el.scrollWidth - el.clientWidth - el.scrollLeft
      setFadeL(el.scrollLeft > 4)
      setFadeR(remaining > 4)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // 内容/容器尺寸变化（结构切换、面板拖宽、窗口缩放）时重估
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  return (
    <div
      ref={ref}
      style={{ '--mol-fade-w': `${edge}px` } as React.CSSProperties}
      className={cn(
        'mol-scroll-x flex min-w-0 flex-1 overflow-x-auto',
        fadeL && 'mol-fade-l',
        fadeR && 'mol-fade-r',
        className,
      )}
    >
      {children}
    </div>
  )
}
