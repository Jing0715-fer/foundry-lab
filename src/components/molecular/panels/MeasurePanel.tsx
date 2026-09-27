'use client'

// 测量面板：模式、当前拾取、测量列表
import { Ruler, Triangle, Rotate3d, Trash2, Zap, MousePointer2 } from 'lucide-react'
import { dataRegistry, useMolStore } from '@/lib/molecular/store'
import { cn } from '@/lib/utils'
import { useI18n, type DualText } from '@/i18n'
import { SectionTitle, PanelHint } from '../LeftPanel'
import type { MeasureMode } from '@/lib/molecular/types'

const MODES: { mode: MeasureMode; label: DualText; icon: typeof Ruler; need: number; hint: DualText }[] = [
  { mode: 'off', label: { zh: '关闭', en: 'Off' }, icon: MousePointer2, need: 0, hint: { zh: '', en: '' } },
  { mode: 'distance', label: { zh: '距离', en: 'Distance' }, icon: Ruler, need: 2, hint: { zh: '在 3D 视图中点击 2 个原子', en: 'Click 2 atoms in the 3D view' } },
  { mode: 'angle', label: { zh: '键角', en: 'Angle' }, icon: Triangle, need: 3, hint: { zh: '依次点击 3 个原子（中间为顶点）', en: 'Click 3 atoms in order (the middle one is the vertex)' } },
  { mode: 'dihedral', label: { zh: '二面角', en: 'Dihedral' }, icon: Rotate3d, need: 4, hint: { zh: '依次点击 4 个原子', en: 'Click 4 atoms in order' } },
]

export function MeasurePanel() {
  const { t } = useI18n()
  const measureMode = useMolStore(s => s.measureMode)
  const setMeasureMode = useMolStore(s => s.setMeasureMode)
  const measurePicks = useMolStore(s => s.measurePicks)
  const clearMeasurePicks = useMolStore(s => s.clearMeasurePicks)
  const measurements = useMolStore(s => s.measurements)
  const removeMeasurement = useMolStore(s => s.removeMeasurement)
  const clearMeasurements = useMolStore(s => s.clearMeasurements)

  const current = MODES.find(m => m.mode === measureMode)!
  const picks = measurePicks
  const pickInfo = (() => {
    if (!picks) return null
    const data = dataRegistry.get(picks.structureId)
    if (!data) return null
    return picks.atoms.map(i => {
      const a = data.atoms
      return `${a.chainIds[i].trim() || '?'}:${a.resNames[i]}${a.resSeqs[i]}.${a.names[i]}`
    })
  })()

  return (
    <div className="pb-4">
      <SectionTitle>{t({ zh: '测量模式', en: 'Measurement mode' })}</SectionTitle>
      <div className="grid grid-cols-2 gap-1.5 px-2">
        {MODES.map(m => (
          <button
            key={m.mode}
            onClick={() => setMeasureMode(m.mode)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-medium transition',
              measureMode === m.mode
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            <m.icon className="h-3.5 w-3.5" />
            {t(m.label)}
          </button>
        ))}
      </div>

      {measureMode !== 'off' && (
        <div className="mx-2 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <Zap className="h-3.5 w-3.5" />
            {t(current.hint)}
          </div>
          {pickInfo && (
            <div className="mt-1.5 space-y-0.5">
              {pickInfo.map((p, i) => (
                <div key={i} className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/20 text-[9px] font-bold text-amber-600 dark:text-amber-400">{i + 1}</span>
                  <span className="text-foreground/80">{p}</span>
                </div>
              ))}
            </div>
          )}
          {picks && picks.atoms.length > 0 && (
            <button onClick={clearMeasurePicks} className="mt-1.5 text-[10px] text-muted-foreground underline-offset-2 hover:underline">
              {t({ zh: '重新开始', en: 'Start over' })}
            </button>
          )}
        </div>
      )}

      <SectionTitle right={
        measurements.length > 0 ? (
          <button onClick={clearMeasurements} className="text-[10px] text-muted-foreground transition hover:text-destructive">
            {t({ zh: '全部清除', en: 'Clear all' })}
          </button>
        ) : undefined
      }>
        {t({ zh: `测量结果 (${measurements.length})`, en: `Measurements (${measurements.length})` })}
      </SectionTitle>
      <div className="mol-scroll max-h-64 space-y-1 overflow-y-auto px-2">
        {measurements.map(m => {
          const data = dataRegistry.get(m.structureId)
          const label = m.type === 'distance' ? t({ zh: '距离', en: 'Distance' }) : m.type === 'angle' ? t({ zh: '键角', en: 'Angle' }) : t({ zh: '二面角', en: 'Dihedral' })
          const color = m.type === 'distance' ? '#ffd166' : m.type === 'angle' ? '#4fd1c5' : '#c39bd3'
          const atomNames = data ? m.atoms.map(i => `${data.atoms.chainIds[i].trim()}:${data.atoms.resNames[i]}${data.atoms.resSeqs[i]}.${data.atoms.names[i]}`).join(' → ') : ''
          return (
            <div key={m.id} className="panel-card group flex items-center gap-2 px-2.5 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                  <span className="font-mono text-xs font-bold tabular-nums">
                    {m.type === 'distance' ? `${m.value.toFixed(2)} Å` : `${m.value.toFixed(1)}°`}
                  </span>
                </div>
                <div className="truncate font-mono text-[9px] tabular-nums text-muted-foreground/70" title={atomNames}>{atomNames}</div>
              </div>
              <button
                onClick={() => removeMeasurement(m.id)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {measurements.length === 0 && (
          <p className="px-1 text-[11px] text-muted-foreground">{t({ zh: '暂无测量。选择模式后在 3D 视图中点击原子。', en: 'No measurements yet. Pick a mode, then click atoms in the 3D view.' })}</p>
        )}
      </div>
      <PanelHint>{t({ zh: '测量值实时显示为 3D 标注；右键菜单「测距：从此原子开始」可快速进入测量。', en: 'Measured values are shown live as 3D labels; the context-menu "Distance: from this atom" starts a measurement instantly.' })}</PanelHint>
    </div>
  )
}
