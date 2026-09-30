'use client'

// 孔道剖面卡（r72：pore 命令的读图面板，视口右侧非模态叠加）
// ─────────────────────────────────────────────────────────────────────────────
// 与 3D 环带「同屏共阅」：HOLE 式剖面曲线（红/绿/蓝分区着色面积 + 深色描边）+
// 收缩点标注（虚线 + 半径读数）+ 关键统计（收缩半径/位置/孔长/原子数）。
// 非模态（不挡 3D 视线——与密度图 σ 卡/颜色标尺同族）；右上角轴指示器左侧停靠
// （right-[104px]：避开 84px gizmo 与右缘竖排视角书签条）。
// 动作：眼睛=环带显隐（剖面卡保留）· 折叠=只留标题行 · 关闭=pore off 一并清除。
import { useState } from 'react'
import { ChevronDown, ChevronUp, Cylinder, Eye, EyeOff, X } from 'lucide-react'
import { usePoreStore, type PoreResult } from '@/lib/molecular/pore-store'
import { clearPore, HOLE_MAX_GREEN, HOLE_NARROW, poreZoneColor } from '@/lib/molecular/pore'
import { engineRef } from '@/lib/molecular/store'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/** 图表内边距与尺寸（SVG 用户单位 = px） */
const W = 288
const H = 158
const PL = 34 // y 轴标签
const PR = 10
const PT = 10
const PB = 22 // x 轴标签

function fmt(n: number, d = 1): string {
  return n.toFixed(d)
}

/** 剖面 SVG（分区着色面积带 + 收缩点标注 + 双轴刻度） */
function ProfileChart({ result }: { result: PoreResult }) {
  const { samples, maxR, constriction } = result
  const n = samples.length
  if (n < 2) return null
  const t0 = samples[0].t
  const t1 = samples[n - 1].t
  const x = (t: number) => PL + ((t - t0) / (t1 - t0 || 1)) * (W - PL - PR)
  const y = (r: number) => H - PB - (Math.max(0, Math.min(r, maxR)) / maxR) * (H - PT - PB)

  // 分区着色面积带：相邻采样点间的梯形按区间平均半径取分区色（HOLE 剖面惯例）
  const bands: { d: string; fill: string }[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const rm = (a.r + b.r) / 2
    bands.push({
      d: `M${x(a.t).toFixed(1)},${(H - PB).toFixed(1)} L${x(a.t).toFixed(1)},${y(a.r).toFixed(1)} L${x(b.t).toFixed(1)},${y(b.r).toFixed(1)} L${x(b.t).toFixed(1)},${(H - PB).toFixed(1)} Z`,
      fill: poreZoneColor(rm),
    })
  }
  // 剖面描边（深色，压在色带上方读形）
  const line = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.r).toFixed(1)}`).join(' ')
  // 轴刻度
  const yTicks = Array.from({ length: Math.floor(maxR / 2) + 1 }, (_, k) => k * 2).filter(v => v <= maxR)
  const xTicks = Array.from({ length: 4 }, (_, k) => t0 + ((t1 - t0) * k) / 3)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Pore radius profile"
    >
      {/* 网格（浅） */}
      {yTicks.map(v => (
        <g key={`y${v}`}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
          <text x={PL - 5} y={y(v) + 3} textAnchor="end" fontSize="8" fill="currentColor" fillOpacity="0.55" className="font-mono">{v}</text>
        </g>
      ))}
      {xTicks.map((v, i) => (
        <text key={`x${i}`} x={x(v)} y={H - PB + 11} textAnchor="middle" fontSize="8" fill="currentColor" fillOpacity="0.55" className="font-mono">{fmt(v, 0)}</text>
      ))}
      {/* 分区色带 */}
      {bands.map((b, i) => (
        <path key={i} d={b.d} fill={b.fill} fillOpacity="0.55" />
      ))}
      {/* 剖面描边 */}
      <path d={line} fill="none" stroke="currentColor" strokeOpacity="0.75" strokeWidth="1.4" strokeLinejoin="round" />
      {/* 收缩点：虚线 + 圆点 + 读数 */}
      <line x1={x(constriction.t)} x2={x(constriction.t)} y1={PT} y2={H - PB} stroke="#dc2626" strokeOpacity="0.7" strokeWidth="1" strokeDasharray="3 2" />
      <circle cx={x(constriction.t)} cy={y(constriction.r)} r="3" fill="#dc2626" />
      <text
        x={x(constriction.t) + (x(constriction.t) > W - 70 ? -6 : 6)}
        y={Math.max(PT + 8, y(constriction.r) - 6)}
        textAnchor={x(constriction.t) > W - 70 ? 'end' : 'start'}
        fontSize="9" fontWeight="700" fill="#dc2626" className="font-mono"
      >
        {`${constriction.r.toFixed(2)} Å`}
      </text>
      {/* 轴题 */}
      <text x={(PL + W - PR) / 2} y={H - 2} textAnchor="middle" fontSize="8" fill="currentColor" fillOpacity="0.6">{'位置 / Å (沿通道主轴)'}</text>
      <text x={10} y={PT + 4} fontSize="8" fill="currentColor" fillOpacity="0.6" transform={`rotate(-90 10 ${PT + 4})`} textAnchor="end">r / Å</text>
    </svg>
  )
}

export function PoreProfile() {
  const { t } = useI18n()
  const result = usePoreStore(s => s.result)
  const visible = usePoreStore(s => s.visible)
  const setVisible = usePoreStore(s => s.setVisible)
  const [collapsed, setCollapsed] = useState(false)
  if (!result) return null

  const toggleRings = () => {
    const v = !visible
    setVisible(v)
    engineRef.current?.updatePore()
  }

  return (
    <div
      className={cn(
        'pointer-events-auto absolute right-[104px] top-3 z-10 w-[268px] select-none rounded-lg border border-border bg-card/95 p-2.5 mol-elevate backdrop-blur-sm',
        !visible && 'opacity-70',
      )}
      aria-label={t({ zh: '孔道剖面分析卡', en: 'Pore profile analysis card' })}
    >
      {/* 标题行：图标 + 结构名 + 动作钮 */}
      <div className="flex items-center gap-1.5">
        <Cylinder className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="text-[11px] font-semibold leading-none">{t({ zh: '孔道剖面', en: 'Pore profile' })}</span>
        <span className="truncate font-mono text-[9px] text-muted-foreground">{result.structureName}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={toggleRings}
            title={t({ zh: visible ? '隐藏 3D 环带（剖面卡保留）' : '显示 3D 环带', en: visible ? 'Hide the 3D rings (chart kept)' : 'Show the 3D rings' })}
            aria-label={t({ zh: '环带显隐', en: 'Toggle rings' })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            title={t({ zh: collapsed ? '展开剖面卡' : '折叠剖面卡', en: collapsed ? 'Expand the profile card' : 'Collapse the profile card' })}
            aria-label={t({ zh: '折叠剖面卡', en: 'Collapse the profile card' })}
            aria-expanded={!collapsed}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => clearPore()}
            title={t({ zh: '关闭并清除孔道分析（pore off）', en: 'Close and clear the pore analysis (pore off)' })}
            aria-label={t({ zh: '关闭孔道分析', en: 'Close pore analysis' })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {!collapsed && (
        <>
          {/* 剖面图 */}
          <div className="mt-1.5 text-foreground">
            <ProfileChart result={result} />
          </div>
          {/* HOLE 分区图例 */}
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#dc2626' }} />{`<${HOLE_NARROW} Å ${t({ zh: '过窄', en: 'narrow' })}`}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#16a34a' }} />{t({ zh: '可过', en: 'passable' })}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#2563eb' }} />{`>${HOLE_MAX_GREEN} Å ${t({ zh: '宽敞', en: 'wide' })}`}</span>
          </div>
          {/* 关键统计 */}
          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-border/70 pt-1.5 font-mono text-[9.5px] text-muted-foreground">
            <span className="text-foreground/80">{t({ zh: '收缩半径', en: 'Constriction' })}: <b className="text-foreground">{result.constriction.r.toFixed(2)} Å</b></span>
            <span>{t({ zh: '位置', en: 'at' })}: {result.constriction.t.toFixed(1)} Å</span>
            <span>{t({ zh: '孔长', en: 'Pore span' })}: {result.span.toFixed(0)} Å</span>
            <span>{result.nAtoms.toLocaleString()} {t({ zh: '原子', en: 'atoms' })} · {result.ms.toFixed(0)} ms</span>
          </div>
        </>
      )}
    </div>
  )
}
