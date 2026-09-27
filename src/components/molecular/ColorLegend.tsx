'use client'

// 颜色标尺图例（视口左下角浮层）：B 因子/putty 渐变条 + 管径映射；SASA 暴露度条
// 出现条件：活动结构存在可见 putty 表示法、或 bfactor/sasa 配色的可见表示法
import { useMemo } from 'react'
import { useMolStore, dataRegistry } from '@/lib/molecular/store'
import { useI18n } from '@/i18n'
import { BFACTOR_STOPS, SASA_STOPS, stopsToGradient } from '@/lib/molecular/colors'
import type { RepConfig } from '@/lib/molecular/types'

type LegendKind = 'putty' | 'bfactor' | 'sasa'

/** putty 管径 SVG 路径：与 representations.ts 同映射 r = rMin + (rMax−rMin)·sqrt(t)，
 *  半高按 (r−rMin)/(rMax−rMin) = sqrt(t) 归一化到 1.1..5.5px（viewBox 高 12） */
function puttyTubePath(width = 128, height = 12): string {
  const n = 32
  const hMin = 1.1
  const hMax = height / 2 - 0.5
  const mid = height / 2
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = (t * width).toFixed(1)
    const h = (hMin + (hMax - hMin) * Math.sqrt(t)).toFixed(2)
    top.push(`${x},${(mid - Number(h)).toFixed(2)}`)
    bottom.push(`${x},${(mid + Number(h)).toFixed(2)}`)
  }
  return `M${top.join(' L')} L${bottom.reverse().join(' L')} Z`
}

export function ColorLegend() {
  const { t } = useI18n()
  const structures = useMolStore(s => s.structures)
  const activeId = useMolStore(s => s.activeId)
  // 控制台打开时隐藏（底部命令行覆盖层会遮挡图例，避免残缺显示）
  const consoleOpen = useMolStore(s => s.ui.consoleOpen)

  const st = structures.find(x => x.id === activeId)

  const legend = useMemo(() => {
    if (!st) return null
    // 优先级：putty（管径+颜色双映射）> bfactor > sasa（需已有 SASA 数据）
    const visible = st.reps.filter((r: RepConfig) => r.visible)
    const puttyRep = visible.find(r => r.type === 'putty')
    const bfactorRep = visible.find(r => r.colorScheme === 'bfactor')
    const sasaRep = visible.find(r => r.colorScheme === 'sasa')
    const data = dataRegistry.get(st.id)

    let kind: LegendKind | null = null
    let rep: RepConfig | null = null
    if (puttyRep) { kind = 'putty'; rep = puttyRep }
    else if (bfactorRep) { kind = 'bfactor'; rep = bfactorRep }
    else if (sasaRep && data?.sasa) { kind = 'sasa'; rep = sasaRep }
    if (!kind || !rep) return null

    // B 范围（着色用全原子；putty 管径用 CA + puttyRange 钳制）
    let bRange: { min: number; max: number; cap?: number } | null = null
    if (kind !== 'sasa' && data) {
      let min = Infinity, max = -Infinity
      const b = data.atoms.bfactors
      const n = data.atoms.count
      for (let i = 0; i < n; i++) {
        const v = b[i]
        if (!Number.isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
      if (min <= max && Number.isFinite(min)) {
        const cap = kind === 'putty' && rep.puttyRange && rep.puttyRange > min ? rep.puttyRange : undefined
        bRange = { min, max, cap }
      }
    }
    return { kind, bRange }
  }, [st])

  if (!legend || consoleOpen) return null
  const { kind, bRange } = legend

  return (
    <div
      className="pointer-events-none w-44 select-none rounded-lg border border-border bg-card p-2 mol-elevate"
      aria-label={t({ zh: '颜色标尺图例', en: 'Color scale legend' })}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-wide text-foreground/80">
          {kind === 'sasa' ? t({ zh: 'SASA 暴露度', en: 'SASA exposure' }) : t({ zh: 'B 因子 (Å²)', en: 'B-factor (Å²)' })}
        </span>
        {kind === 'putty' && (
          <span className="text-[9px] text-muted-foreground/80">{t({ zh: 'putty 管径', en: 'putty tube radius' })}</span>
        )}
      </div>

      {/* 渐变条 */}
      <div
        className="h-2.5 w-full rounded-[3px] border border-border/50"
        style={{ background: stopsToGradient(kind === 'sasa' ? SASA_STOPS : BFACTOR_STOPS) }}
      />

      {/* 数值刻度 */}
      <div className="mt-0.5 flex items-baseline justify-between font-mono text-[9px] leading-none text-muted-foreground">
        {kind === 'sasa'
          ? <><span>{t({ zh: '埋藏 0%', en: 'buried 0%' })}</span><span className="text-[8px]">{t({ zh: '暴露分数', en: 'exposure' })}</span><span>{t({ zh: '100% 暴露', en: '100% exposed' })}</span></>
          : <>
            <span>{bRange ? bRange.min.toFixed(1) : '—'}</span>
            <span>{bRange ? ((bRange.min + (bRange.cap ?? bRange.max)) / 2).toFixed(0) : ''}</span>
            <span>
              {bRange ? (bRange.cap ?? bRange.max).toFixed(1) : '—'}
              {bRange?.cap != null && <span className="text-[8px] text-amber-600 dark:text-amber-400" title={t({ zh: `已钳制（实际最大 ${bRange.max.toFixed(0)}+）`, en: `clamped (actual max ${bRange.max.toFixed(0)}+)` })}>*</span>}
            </span>
          </>}
      </div>

      {/* putty 管径可视化（细→粗，与渲染同 sqrt 映射） */}
      {kind === 'putty' && (
        <>
          <svg viewBox="0 0 128 12" className="mt-1.5 h-3 w-full" aria-hidden>
            <defs>
              <linearGradient id="mv-putty-grad" x1="0" y1="0" x2="1" y2="0">
                {BFACTOR_STOPS.map(([t, c], i) => (
                  <stop key={i} offset={t} stopColor={c} />
                ))}
              </linearGradient>
            </defs>
            <path d={puttyTubePath()} fill="url(#mv-putty-grad)" stroke="rgba(0,0,0,0.18)" strokeWidth="0.4" />
          </svg>
          <div className="mt-0.5 flex items-center justify-between text-[9px] leading-none text-muted-foreground/80">
            <span>{t({ zh: '刚性（细）', en: 'rigid (thin)' })}</span>
            <span>{t({ zh: '柔性（粗）', en: 'flexible (thick)' })}</span>
          </div>
        </>
      )}
    </div>
  )
}
