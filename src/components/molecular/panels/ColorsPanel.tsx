'use client'

// 颜色面板：配色方案应用到当前选择、自定义颜色、重置
import { useState } from 'react'
import { Paintbrush, RotateCcw, Palette } from 'lucide-react'
import { toast } from 'sonner'
import { useMolStore } from '@/lib/molecular/store'
import { COLOR_SCHEME_LABELS, NAMED_COLORS, type ColorScheme } from '@/lib/molecular/colors'
import { cn } from '@/lib/utils'
import { useI18n, tt } from '@/i18n'
import { SectionTitle, PanelHint } from '../LeftPanel'
import { Input } from '@/components/ui/input'

const SCHEMES: { key: ColorScheme; swatches: string[] }[] = [
  { key: 'element', swatches: ['#909090', '#3050f8', '#ff0d0d', '#ffff30', '#ff8000'] },
  { key: 'pocket', swatches: ['#4caf50', '#a02fd0', '#c76fdd', '#f4b6e4', '#3050f8'] },
  { key: 'chain', swatches: ['#e35d5d', '#6bbf6b', '#5da5e0', '#d5a54a', '#a06bd8'] },
  { key: 'spectrum', swatches: ['#e05d5d', '#e8c17a', '#8fd694', '#4fb3c6', '#9a5fd4'] },
  { key: 'residue', swatches: ['#f2c46d', '#8fd694', '#4fb3c6', '#e05d5d', '#c39bd3'] },
  { key: 'ss', swatches: ['#ff5e5b', '#ffd166', '#9aa3ad'] },
  { key: 'bfactor', swatches: ['#2c7bb6', '#66c2a5', '#f2c46d', '#e05d5d', '#b61515'] },
]

export function ColorsPanel() {
  const { t, locale } = useI18n()
  const applyColor = useMolStore(s => s.applyColor)
  const resetColors = useMolStore(s => s.resetColors)
  const selection = useMolStore(s => s.selection)
  const activeId = useMolStore(s => s.activeId)
  const structures = useMolStore(s => s.structures)
  const [custom, setCustom] = useState('#e05d5d')

  const st = structures.find(x => x.id === activeId)
  const hasSelection = selection.structureId === activeId && selection.indices.length > 0
  const overrideCount = st ? Object.keys(st.colorOverrides).length : 0

  if (!st) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <Palette className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">{t({ zh: '加载结构后可在此上色。', en: 'Load a structure to color it here.' })}</p>
      </div>
    )
  }

  return (
    <div className="pb-4">
      <SectionTitle>{t({ zh: '配色方案', en: 'Color schemes' })}</SectionTitle>
      <div className="space-y-1 px-2">
        {SCHEMES.map(sc => (
          <button
            key={sc.key}
            onClick={() => { applyColor(sc.key); toast.success(tt({ zh: `已应用配色：${tt(COLOR_SCHEME_LABELS[sc.key])}`, en: `Applied: ${tt(COLOR_SCHEME_LABELS[sc.key])}` })) }}
            className="panel-card flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
          >
            <div className="flex -space-x-1">
              {sc.swatches.map((c, i) => (
                <span key={i} className="h-4 w-4 rounded-full border border-background shadow-xs" style={{ background: c }} />
              ))}
            </div>
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={t(COLOR_SCHEME_LABELS[sc.key])}>{t(COLOR_SCHEME_LABELS[sc.key])}</span>
            <Paintbrush className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          </button>
        ))}
      </div>

      <SectionTitle>{t({ zh: '自定义颜色', en: 'Custom color' })}</SectionTitle>
      <div className="flex items-center gap-2 px-3">
        <input
          type="color"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded-md border border-border bg-background p-0.5"
        />
        <Input
          value={custom}
          onChange={e => setCustom(e.target.value)}
          className="h-8 min-w-0 flex-1 border-border bg-background font-mono text-xs"
          placeholder="#hex"
        />
        <button
          onClick={() => { applyColor(custom); toast.success(tt({ zh: `已上色 ${custom}`, en: `Applied ${custom}` })) }}
          className="mol-btn-primary flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Paintbrush className="h-3 w-3" /> {t({ zh: '上色', en: 'Apply' })}
        </button>
      </div>

      <SectionTitle>{t({ zh: '常用色', en: 'Named colors' })}</SectionTitle>
      <div className="flex flex-wrap gap-1.5 px-3">
        {Object.entries(NAMED_COLORS).slice(0, 18).map(([name, hex]) => (
          <button
            key={name}
            onClick={() => { applyColor(hex); toast.success(tt({ zh: `已上色 ${name}`, en: `Applied ${name}` })) }}
            className="group relative flex items-center gap-1.5 rounded-md border border-border py-1 pl-1 pr-2 transition hover:border-primary/40"
            title={t({ zh: `上色 ${name}`, en: `Apply ${name}` })}
          >
            <span className="h-3.5 w-3.5 rounded-sm border border-black/10" style={{ background: hex }} />
            <span className="text-[10px] text-muted-foreground group-hover:text-foreground">{name}</span>
          </button>
        ))}
      </div>

      <SectionTitle>{t({ zh: '覆盖管理', en: 'Overrides' })}</SectionTitle>
      <div className="flex items-center gap-2 px-3">
        <button
          onClick={() => resetColors('selection')}
          disabled={!hasSelection}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[11px] transition',
            hasSelection ? 'hover:bg-accent' : 'opacity-40',
          )}
        >
          <RotateCcw className="h-3 w-3" /> {t({ zh: '重置所选', en: 'Reset selection' })}
        </button>
        <button
          onClick={() => resetColors('structure')}
          disabled={overrideCount === 0}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[11px] transition',
            overrideCount > 0 ? 'hover:bg-accent' : 'opacity-40',
          )}
        >
          <RotateCcw className="h-3 w-3" /> {t({ zh: '重置全部', en: 'Reset all' })} (<span className="font-mono tabular-nums">{overrideCount.toLocaleString(locale)}</span>)
        </button>
      </div>

      <PanelHint>
        {t({ zh: '上色会覆盖所选原子（无选择时作用于整个结构）的配色，优先级高于表示法的配色方案。', en: 'Coloring overrides the scheme of the selected atoms (the whole structure if nothing is selected), taking priority over representation color schemes.' })}
      </PanelHint>
    </div>
  )
}
