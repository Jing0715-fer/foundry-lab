'use client'

// MolVision 面板共享组件（foundry-lab 内嵌版）
// 自 MolVision LeftPanel 抽出的两个共享原语：面板内所有分栏（Analysis/Reps/Colors/
// Measure/Selection）以同一「精密仪器」设计语言渲染分区标题与提示条。
// foundry-lab 不内嵌完整图标栏/分栏容器，仅承载这些共享件。

export function PanelHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mx-3 mb-2 rounded-md border border-border/50 bg-muted/40 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** 分区标题：primary 刻线锚点 + 大写微标签（与工具栏/仪表条同一仪器语言） */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
      <h3 className="mol-micro flex items-center gap-1.5 text-muted-foreground/85">
        <span className="h-2.5 w-[2px] rounded-full bg-primary/70" aria-hidden />
        {children}
      </h3>
      {right}
    </div>
  )
}
