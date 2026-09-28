'use client'

// 分析面板：界面接触检测（表达式组 A/B + 距离截断）+ 2D 接触图谱 + 界面残基选择 + SASA/ΔSASA + DSSP 重算 + 跨结构接触
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Trash2, MousePointerClick, Network, RefreshCw, Droplets, Palette, Layers, ArrowLeftRight, Crosshair, Search, MoveUpRight } from 'lucide-react'
import { dataRegistry, engineRef, useMolStore, buildNamedMasks } from '@/lib/molecular/store'
import { runContactAnalysis, runBuriedSasa, runCrossBuriedSasa, interfaceAtomIndices, runCrossContactAnalysis } from '@/lib/molecular/contacts'
import type { ContactPair } from '@/lib/molecular/contacts'
import { useContactStore } from '@/lib/molecular/contacts-store'
import { useHBondStore, type HBondPairSummary } from '@/lib/molecular/hbond-store'
import { useSasaStore } from '@/lib/molecular/sasa-store'
import { evaluateSelection } from '@/lib/molecular/selection'
import type { StructureData } from '@/lib/molecular/parser'
import { useI18n, tt } from '@/i18n'
import { cn } from '@/lib/utils'
import { SectionTitle, PanelHint } from '../LeftPanel'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

/** 接触图谱 canvas 尺寸（含 28px 轴标区） */
const MAP_PAD = 30
const MAP_SIZE = 232

/** 距离 → 图谱颜色（近 = 亮红，远 = 深琥珀；与 3D 连线同族） */
function heatColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t))
  return [Math.round(239 + 6 * c), Math.round(68 + 90 * c), Math.round(68 - 57 * c)]
}

/** xbsa 表达示例（点击填入 A/B 两结构同用表达式；链限定可避免叠合重合区域虚增埋藏面积） */
const XBSA_EXPR_EXAMPLES: { label: string; expr: string }[] = [
  { label: 'chain A', expr: 'chain A' },
  { label: 'polymer', expr: 'polymer' },
  { label: 'not het', expr: 'not het' },
]

export function AnalysisPanel() {
  const { t, locale } = useI18n()
  const activeId = useMolStore(s => s.activeId)
  const structures = useMolStore(s => s.structures)
  const setSelection = useMolStore(s => s.setSelection)
  const setActive = useMolStore(s => s.setActive)
  const appendLog = useMolStore(s => s.appendLog)
  const recomputeSS = useMolStore(s => s.recomputeSS)
  const aExpr = useContactStore(s => s.aExpr)
  const bExpr = useContactStore(s => s.bExpr)
  const cutoff = useContactStore(s => s.cutoff)
  const visible = useContactStore(s => s.visible)
  const pairs = useContactStore(s => s.pairs)
  const residuesA = useContactStore(s => s.residuesA)
  const residuesB = useContactStore(s => s.residuesB)
  const structureId = useContactStore(s => s.structureId)
  const errors = useContactStore(s => s.errors)
  const defaulted = useContactStore(s => s.defaulted)
  const cross = useContactStore(s => s.cross)
  const crossPairs = useContactStore(s => s.crossPairs)
  const setExpr = useContactStore(s => s.setExpr)
  const setCutoff = useContactStore(s => s.setCutoff)
  const setVisible = useContactStore(s => s.setVisible)
  const clear = useContactStore(s => s.clear)
  // SASA 状态
  const sasaComputing = useSasaStore(s => s.computing)
  const sasaStructureId = useSasaStore(s => s.structureId)
  const sasaTotal = useSasaStore(s => s.total)
  const sasaHydrophobic = useSasaStore(s => s.hydrophobic)
  const sasaPolar = useSasaStore(s => s.polar)
  const sasaHet = useSasaStore(s => s.het)
  const sasaMs = useSasaStore(s => s.ms)
  const sasaProbe = useSasaStore(s => s.probe)
  const sasaPoints = useSasaStore(s => s.nPoints)
  const topResidues = useSasaStore(s => s.topResidues)
  const buried = useSasaStore(s => s.buried)
  const applyColor = useMolStore(s => s.applyColor)

  // SASA 参数本地态（运行时才写入 store）
  const [probe, setProbe] = useState(1.4)
  const [nPoints, setNPoints] = useState(92)

  const entry = structures.find(s => s.id === activeId) ?? null
  const data = activeId ? dataRegistry.get(activeId) : null
  const stale = structureId !== null && structureId !== activeId

  // 切换结构时填充默认表达式（前两条聚合物链），仅当用户未自定义
  useEffect(() => {
    if (!data || defaulted) return
    const polymer = data.chains.filter(c => c.type === 'protein' || c.type === 'nucleic')
    if (polymer.length >= 2) {
      useContactStore.setState({ aExpr: `chain ${polymer[0].id.trim()}`, bExpr: `chain ${polymer[1].id.trim()}`, defaulted: true })
    } else if (polymer.length === 1) {
      useContactStore.setState({ aExpr: `chain ${polymer[0].id.trim()}`, bExpr: 'ligand', defaulted: true })
    }
  }, [data, defaulted])

  // 表达式实时计数（输入反馈）
  const counts = useMemo(() => {
    if (!data || !activeId) return { a: 0, b: 0 }
    const named = buildNamedMasks(activeId, data)
    const ra = aExpr.trim() ? evaluateSelection(aExpr, { structure: data, named }) : null
    const rb = bExpr.trim() ? evaluateSelection(bExpr, { structure: data, named }) : null
    return { a: ra?.count ?? 0, b: rb?.count ?? 0 }
  }, [data, activeId, aExpr, bExpr])

  const run = useCallback(() => {
    const outcome = runContactAnalysis()
    appendLog(outcome.ok ? 'out' : 'err', outcome.message)
  }, [appendLog])

  // ---------- 跨结构接触（UI 状态 + 运行器） ----------
  const [xMode, setXMode] = useState(false)
  const [xSpecADirty, setXSpecA] = useState<string | null>(null)   // 用户手选的结构 A（null = 跟随活动结构）
  const [xSpecBDirty, setXSpecB] = useState<string | null>(null)   // 结构 B
  const [xExprA, setXExprA] = useState('protein')
  const [xExprB, setXExprB] = useState('protein')
  const [xCutoff, setXCutoff] = useState(4.5)

  // 结构列表（渲染期派生，无 effect）
  const pdbOptions = useMemo(() => structures.map(s => ({ id: s.id, label: s.meta.pdbId ?? s.name, transformed: !!s.transform })), [structures])
  // 默认：A = 活动结构，B = 第一个其它结构；用户改过则保持（结构被移除时自动回退）
  const actLabel = entry ? (entry.meta.pdbId ?? entry.name) : ''
  const otherLabel = pdbOptions.find(o => o.label !== actLabel)?.label ?? actLabel
  const validA = xSpecADirty && pdbOptions.some(o => o.label === xSpecADirty)
  const validB = xSpecBDirty && pdbOptions.some(o => o.label === xSpecBDirty)
  const xSpecA = validA ? xSpecADirty! : actLabel
  const xSpecB = validB ? xSpecBDirty! : otherLabel

  const runXContacts = useCallback(() => {
    const outcome = runCrossContactAnalysis(`${xSpecA}:${xExprA}`, `${xSpecB}:${xExprB}`, xCutoff)
    appendLog(outcome.ok ? 'out' : 'err', outcome.message)
  }, [xSpecA, xSpecB, xExprA, xExprB, xCutoff, appendLog])

  // 跨结构表达式实时计数（对各自所选结构求值）
  const xCounts = useMemo(() => {
    const countFor = (label: string, expr: string): number | undefined => {
      const opt = pdbOptions.find(o => o.label === label)
      if (!opt) return undefined
      const d = dataRegistry.get(opt.id)
      if (!d) return undefined
      const named = buildNamedMasks(opt.id, d)
      const r = expr.trim() ? evaluateSelection(expr, { structure: d, named }) : null
      return r?.count ?? 0
    }
    return { a: countFor(xSpecA, xExprA), b: countFor(xSpecB, xExprB) }
  }, [xSpecA, xSpecB, xExprA, xExprB, pdbOptions])

  // SASA 运行（小结构同步完成即有结果；大结构 worker 异步，完成后 sasa-store 更新）
  const runSasa = useCallback(() => {
    if (!activeId) return
    const r = engineRef.current?.requestSasa(activeId, { probe, nPoints })
    if (!r) return appendLog('err', tt({ zh: '渲染引擎未就绪', en: 'Rendering engine not ready' }))
    if (r.done && r.stats) {
      const st = r.stats
      appendLog('out', tt({ zh: `SASA（Shrake–Rupley，probe ${probe} Å，${nPoints} 点）：总计 ${st.total.toFixed(0)} Å² · 疏水 ${st.hydrophobic.toFixed(0)} · 极性 ${st.polar.toFixed(0)} · ${st.ms.toFixed(0)} ms`, en: `SASA (Shrake–Rupley, probe ${probe} Å, ${nPoints} points): total ${st.total.toFixed(0)} Å² · hydrophobic ${st.hydrophobic.toFixed(0)} · polar ${st.polar.toFixed(0)} · ${st.ms.toFixed(0)} ms` }))
    } else {
      appendLog('out', tt({ zh: `SASA 计算中（Web Worker，probe ${probe} Å，${nPoints} 点）…`, en: `Computing SASA (Web Worker, probe ${probe} Å, ${nPoints} points)…` }))
    }
  }, [activeId, probe, nPoints, appendLog])

  const runBsa = useCallback(() => {
    const outcome = runBuriedSasa()
    appendLog(outcome.ok ? 'out' : 'err', outcome.message)
  }, [appendLog])

  const runXbsa = useCallback(() => {
    const outcome = runCrossBuriedSasa()
    appendLog(outcome.ok ? 'out' : 'err', outcome.message)
  }, [appendLog])

  // 跨结构 ΔSASA 侧选：激活对应结构并选中其核心残基原子（掩码来自各自结构残基表）
  const selectXbsaSide = useCallback((side: 'a' | 'b') => {
    const b = useSasaStore.getState().buried
    const cross = useContactStore.getState().cross
    if (!b?.cross || !cross) return
    const id = side === 'a' ? b.cross.idA : b.cross.idB
    const label = side === 'a' ? b.cross.labelA : b.cross.labelB
    const core = side === 'a' ? b.coreA : b.coreB
    const d = dataRegistry.get(id)
    if (!d) return
    setActive(id)
    const idx = interfaceAtomIndices(d, core)
    setSelection(id, idx)
    appendLog('out', tt({ zh: `已选择 ${label} 侧跨结构界面核心残基：${core.length} 残基（${idx.length} 原子，ΔSASA > 1 Å²）`, en: `Selected ${label}-side cross-structure interface core residues: ${core.length} residues (${idx.length} atoms, ΔSASA > 1 Å²)` }))
  }, [setActive, setSelection, appendLog])

  // ---------- 2D 接触图谱 ----------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; pairIdx: number } | null>(null)
  const mapData = data && structureId === activeId && pairs.length ? { data, pairs } : null

  // 行列残基索引（按链序 + 残基序）
  const axis = useMemo(() => {
    if (!mapData) return null
    const { data: d, pairs: ps } = mapData
    const idxA = [...new Set(ps.map(p => p.resA))].sort((a, b) => a - b)
    const idxB = [...new Set(ps.map(p => p.resB))].sort((a, b) => a - b)
    const posA = new Map<number, number>()
    const posB = new Map<number, number>()
    idxA.forEach((ri, i) => posA.set(ri, i))
    idxB.forEach((ri, i) => posB.set(ri, i))
    // cell 尺寸（限制最大，避免大残基数时过小）
    const cw = Math.max(1, Math.min(14, Math.floor((MAP_SIZE - MAP_PAD * 2) / Math.max(1, idxB.length))))
    const ch = Math.max(1, Math.min(14, Math.floor((MAP_SIZE - MAP_PAD * 2) / Math.max(1, idxA.length))))
    const gridW = cw * idxB.length, gridH = ch * idxA.length
    return { idxA, idxB, posA, posB, cw, ch, gridW, gridH, pairs: ps }
  }, [mapData])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !axis || !mapData) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const W = MAP_PAD * 2 + axis.gridW
    const H = MAP_PAD * 2 + axis.gridH
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const isDark = document.documentElement.classList.contains('dark')
    // 背景
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'
    ctx.fillRect(MAP_PAD, MAP_PAD, axis.gridW, axis.gridH)
    // 单元格
    for (const p of axis.pairs) {
      const cx = axis.posA.get(p.resA)
      const cy = axis.posB.get(p.resB)
      if (cx === undefined || cy === undefined) continue
      const t = (p.minDist - 2.5) / Math.max(0.5, cutoff - 2.5)
      const [r, g, b] = heatColor(t)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(MAP_PAD + cy * axis.cw, MAP_PAD + cx * axis.ch, Math.max(1, axis.cw - 0.5), Math.max(1, axis.ch - 0.5))
    }
    // 链边界线 + 轴标
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1
    ctx.font = '8px ui-monospace, monospace'
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
    const labelTick = (ri: number, kind: 'A' | 'B') => {
      const res = mapData.data.residues[ri]
      const label = `${res.chainId.trim()}${res.resSeq}`
      return kind === 'A' ? label : label
    }
    // Y 轴（A 残基）标签抽样
    const yStep = Math.max(1, Math.ceil(axis.idxA.length / 12))
    for (let i = 0; i < axis.idxA.length; i += yStep) {
      const label = labelTick(axis.idxA[i], 'A')
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
      ctx.fillText(label, 2, MAP_PAD + i * axis.ch + axis.ch / 2 + 3)
      // 链切换处画分隔线
      const next = axis.idxA[i + 1]
      const cur = axis.idxA[i]
      if (next !== undefined && mapData.data.residues[next].chainId !== mapData.data.residues[cur].chainId) {
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
        ctx.beginPath()
        ctx.moveTo(MAP_PAD, MAP_PAD + (i + 1) * axis.ch)
        ctx.lineTo(MAP_PAD + axis.gridW, MAP_PAD + (i + 1) * axis.ch)
        ctx.stroke()
      }
    }
    // X 轴（B 残基）标签抽样（旋转 90°）
    const xStep = Math.max(1, Math.ceil(axis.idxB.length / 12))
    ctx.save()
    for (let j = 0; j < axis.idxB.length; j += xStep) {
      const label = labelTick(axis.idxB[j], 'B')
      ctx.save()
      ctx.translate(MAP_PAD + j * axis.cw + axis.cw / 2, MAP_PAD + axis.gridH + 4)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
      ctx.fillText(label, 0, 7)
      ctx.restore()
      const next = axis.idxB[j + 1]
      const cur = axis.idxB[j]
      if (next !== undefined && mapData.data.residues[next].chainId !== mapData.data.residues[cur].chainId) {
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
        ctx.beginPath()
        ctx.moveTo(MAP_PAD + (j + 1) * axis.cw, MAP_PAD)
        ctx.lineTo(MAP_PAD + (j + 1) * axis.cw, MAP_PAD + axis.gridH)
        ctx.stroke()
      }
    }
    ctx.restore()
  }, [axis, mapData, cutoff])

  // 图谱交互：hover 提示 + 点击选择残基对
  const onMapMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!axis || !mapData) return setHover(null)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const col = Math.floor((x - MAP_PAD) / axis.cw)
    const row = Math.floor((y - MAP_PAD) / axis.ch)
    if (col < 0 || row < 0 || col >= axis.idxB.length || row >= axis.idxA.length) return setHover(null)
    const resA = axis.idxA[row], resB = axis.idxB[col]
    const pair = mapData.pairs.find(p => p.resA === resA && p.resB === resB)
    setHover(pair ? { x, y, pairIdx: mapData.pairs.indexOf(pair) } : null)
  }
  const onMapClick = () => {
    if (!hover || !mapData || !activeId) return
    const p = mapData.pairs[hover.pairIdx]
    const d = mapData.data
    const idx: number[] = []
    for (let i = d.residues[p.resA].start; i < d.residues[p.resA].end; i++) idx.push(i)
    for (let i = d.residues[p.resB].start; i < d.residues[p.resB].end; i++) idx.push(i)
    setSelection(activeId, idx)
    appendLog('out', tt({ zh: `已选择接触残基对：${d.residues[p.resA].chainId.trim()}:${d.residues[p.resA].resName}${d.residues[p.resA].resSeq} ↔ ${d.residues[p.resB].chainId.trim()}:${d.residues[p.resB].resName}${d.residues[p.resB].resSeq}（${p.minDist.toFixed(2)} Å，${p.count} 个原子对）`, en: `Selected contact residue pair: ${d.residues[p.resA].chainId.trim()}:${d.residues[p.resA].resName}${d.residues[p.resA].resSeq} ↔ ${d.residues[p.resB].chainId.trim()}:${d.residues[p.resB].resName}${d.residues[p.resB].resSeq} (${p.minDist.toFixed(2)} Å, ${p.count} atom pairs)` }))
  }

  // ---------- 选择界面残基 ----------
  const selectSide = (side: 'a' | 'b' | 'both') => {
    if (!activeId || !data || !structureId || structureId !== activeId) return
    const idx = side === 'a'
      ? interfaceAtomIndices(data, residuesA)
      : side === 'b'
        ? interfaceAtomIndices(data, residuesB)
        : [...interfaceAtomIndices(data, residuesA), ...interfaceAtomIndices(data, residuesB)]
    setSelection(activeId, idx)
    appendLog('out', tt({ zh: `已选择${side === 'a' ? 'A 侧' : side === 'b' ? 'B 侧' : '全部'}界面残基：${idx.length} 原子（${side === 'a' ? residuesA.length : side === 'b' ? residuesB.length : residuesA.length + residuesB.length} 残基）`, en: `Selected ${side === 'a' ? 'A-side' : side === 'b' ? 'B-side' : 'all'} interface residues: ${idx.length} atoms (${side === 'a' ? residuesA.length : side === 'b' ? residuesB.length : residuesA.length + residuesB.length} residues)` }))
  }

  // ---------- 残基对跳转（接触/氢键表格共用：选择两侧残基原子 + 相机聚焦） ----------
  const focusResiduePair = useCallback((resA: number, resB: number, label: string) => {
    if (!activeId || !data) return
    const ra = data.residues[resA]
    const rb = data.residues[resB]
    if (!ra || !rb) return
    const idx: number[] = []
    for (let i = ra.start; i < ra.end; i++) idx.push(i)
    for (let i = rb.start; i < rb.end; i++) idx.push(i)
    setSelection(activeId, idx)
    engineRef.current?.fitView([{ structureId: activeId, indices: idx }])
    appendLog('out', tt({ zh: `已选择并聚焦残基对：${label}`, en: `Selected and focused residue pair: ${label}` }))
  }, [activeId, data, setSelection, appendLog])

  // ---------- 氢键网络残基对（跟随 B 键 / hbonds 命令的实时状态） ----------
  const hbPairs = useHBondStore(s => s.pairs)
  const hbCount = useHBondStore(s => s.count)
  const hbValid = data && hbPairs.length > 0 && hbPairs[0].structureId === activeId

  const hasResult = structureId === activeId && pairs.length > 0
  const hoverPair = hover && mapData ? mapData.pairs[hover.pairIdx] : null

  return (
    <div className="pb-4">
      <SectionTitle right={
        <span className="text-[10px] font-normal font-mono tabular-nums text-muted-foreground">
          {entry ? entry.name : t({ zh: '无活动结构', en: 'No active structure' })}
        </span>
      }>
        {t({ zh: '界面接触检测', en: 'Interface contact analysis' })}
      </SectionTitle>

      {!entry && (
        <PanelHint>{t({ zh: '加载结构后，检测两组原子选择间的重原子接触（≤ 距离截断），获得残基级界面与 2D 接触图谱。', en: 'After loading a structure, detect heavy-atom contacts between two selections (≤ distance cutoff) to get a residue-level interface and a 2D contact map.' })}</PanelHint>
      )}

      {entry && structures.length >= 2 && (
        <div className="mx-2 mb-2 mt-1 flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          <button
            onClick={() => setXMode(false)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-medium transition',
              !xMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            <Network className="h-3 w-3" />
            {t({ zh: '单结构界面', en: 'Single structure' })}
          </button>
          <button
            onClick={() => setXMode(true)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-medium transition',
              xMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            <ArrowLeftRight className="h-3 w-3" />
            {t({ zh: '跨结构接触', en: 'Cross-structure' })}
          </button>
        </div>
      )}

      {entry && xMode && structures.length >= 2 && (
        <div className="space-y-2 px-2 pb-1">
          {/* 结构选择器 */}
          <div className="grid grid-cols-2 gap-1.5">
            {(['A', 'B'] as const).map((side, i) => {
              const val = side === 'A' ? xSpecA : xSpecB
              const setVal = side === 'A' ? setXSpecA : setXSpecB
              const tone = side === 'A' ? 'text-rose-600 dark:text-rose-400' : 'text-cyan-600 dark:text-cyan-400'
              return (
                <label key={side} className="rounded-lg border border-border px-2 py-1.5">
                  <span className={cn('text-[10px] font-semibold', tone)}>{t({ zh: `结构 ${side}`, en: `Structure ${side}` })}</span>
                  <select
                    value={val}
                    onChange={e => setVal(e.target.value)}
                    className="mt-0.5 w-full cursor-pointer rounded border-none bg-transparent p-0 font-mono text-[11px] text-foreground outline-none"
                  >
                    {pdbOptions.map(o => (
                      <option key={o.id} value={o.label}>
                        {o.label}{o.transformed ? ' ⤴' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
          <ExprInput
            label={t({ zh: 'A 选择', en: 'A selection' })} tone="rose"
            value={xExprA} onChange={setXExprA}
            count={xCounts.a}
            placeholder={t({ zh: '如 protein / chain A', en: 'e.g. protein / chain A' })}
          />
          <ExprInput
            label={t({ zh: 'B 选择', en: 'B selection' })} tone="cyan"
            value={xExprB} onChange={setXExprB}
            count={xCounts.b}
            placeholder={t({ zh: '如 protein / chain A', en: 'e.g. protein / chain A' })}
          />
          <div className="rounded-lg border border-border px-2.5 py-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{t({ zh: '距离截断', en: 'Distance cutoff' })}</span>
              <span className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">{xCutoff.toFixed(1)} Å</span>
            </div>
            <Slider
              value={[xCutoff]}
              min={3} max={8} step={0.5}
              aria-label={t({ zh: '跨结构接触距离截断', en: 'Cross-contact distance cutoff' })}
              onValueChange={([v]) => setXCutoff(v)}
              className="mt-1.5"
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={runXContacts}
              className="mol-btn-primary flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              {t({ zh: '检测跨结构接触', en: 'Detect cross-contacts' })}
            </button>
            {cross && (
              <button
                onClick={() => { clear(); engineRef.current?.updateContacts() }}
                title={t({ zh: '清除跨结构结果与连线', en: 'Clear cross-structure results and lines' })}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:border-destructive/50 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t({ zh: '检测两结构间的原子接触（复合物界面）。两结构需已 superpose 对齐到同一坐标系——未对齐时距离无意义。', en: 'Detects atom contacts between two structures (complex interface). Both must be superposed into a common coordinate frame — distances are meaningless without alignment.' })}
          </p>

          {/* 跨结构结果卡片 */}
          {cross && crossPairs.length > 0 && (
            <div className="panel-card p-2.5">
              <div className="flex items-center justify-between">
                <span className="mol-micro text-muted-foreground">{t({ zh: '跨结构界面', en: 'Cross-structure interface' })}</span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{cross.cutoff.toFixed(1)} Å</span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                <Stat label={t({ zh: '接触对', en: 'Contact pairs' })} value={crossPairs.length.toLocaleString(locale)} />
                <Stat label={t({ zh: `${cross.labelA} 侧`, en: `${cross.labelA} side` })} value={residuesA.length.toLocaleString(locale)} tone="rose" />
                <Stat label={t({ zh: `${cross.labelB} 侧`, en: `${cross.labelB} side` })} value={residuesB.length.toLocaleString(locale)} tone="cyan" />
              </div>
              <div className="mt-2 space-y-1">
                {crossPairs.slice(0, 5).map((p, i) => {
                  const dataA = dataRegistry.get(cross.idA)
                  const dataB = dataRegistry.get(cross.idB)
                  if (!dataA || !dataB) return null
                  const ra = dataA.residues[p.resA], rb = dataB.residues[p.resB]
                  return (
                    <div key={i} className="flex items-center justify-between rounded border border-border bg-card px-1.5 py-1 font-mono text-[10px] tabular-nums">
                      <span className="truncate">
                        <span className="text-rose-600 dark:text-rose-400">{cross.labelA} {ra.chainId.trim()}:{ra.resName}{ra.resSeq}</span>
                        <span className="mx-1 text-muted-foreground">↔</span>
                        <span className="text-cyan-600 dark:text-cyan-400">{cross.labelB} {rb.chainId.trim()}:{rb.resName}{rb.resSeq}</span>
                      </span>
                      <span className="ml-1.5 shrink-0 font-bold text-amber-600 dark:text-amber-400">{p.minDist.toFixed(2)} Å</span>
                    </div>
                  )
                })}
                {crossPairs.length > 5 && (
                  <p className="text-center text-[10px] tabular-nums text-muted-foreground">{t({ zh: `… 共 ${crossPairs.length} 对（按距离排序）`, en: `… ${crossPairs.length} pairs (sorted by distance)` })}</p>
                )}
              </div>
            </div>
          )}
          {cross && crossPairs.length === 0 && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              {t({ zh: '未发现跨结构接触——确认两结构已 superpose 对齐，或增大距离截断。', en: 'No cross-structure contacts found — make sure both structures are superposed, or increase the cutoff.' })}
            </p>
          )}

          {/* 跨结构 ΔSASA：沿用 xcontacts 的 A/B 掩码与当前位姿 */}
          {cross && crossPairs.length > 0 && (
            <div className="panel-card px-2.5 py-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                  <Droplets className="h-3.5 w-3.5 text-primary" />
                  {t({ zh: '跨结构埋藏面积 (xbsa)', en: 'Cross-structure buried area (xbsa)' })}
                </span>
                <button
                  onClick={runXbsa}
                  disabled={!!(buried?.cross && buried.computing)}
                  className="mol-btn-primary rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  {buried?.cross && buried.computing ? t({ zh: '计算中…', en: 'Computing…' }) : t({ zh: '联合三路 SASA', en: 'Run 3-way SASA' })}
                </button>
              </div>
              {buried && buried.cross && buried.cross.idA === cross.idA && buried.cross.idB === cross.idB && !buried.computing && (
                <div className="mt-1.5">
                  <div className="grid grid-cols-3 gap-1.5">
                    <Stat label={t({ zh: `${buried.cross.labelA} 埋藏`, en: `${buried.cross.labelA} buried` })} value={`${buried.buriedA.toFixed(0)} Å²`} tone="rose" />
                    <Stat label={t({ zh: `${buried.cross.labelB} 埋藏`, en: `${buried.cross.labelB} buried` })} value={`${buried.buriedB.toFixed(0)} Å²`} tone="cyan" />
                    <Stat label={t({ zh: '合计', en: 'Total' })} value={`${(buried.buriedA + buried.buriedB).toFixed(0)} Å²`} />
                  </div>
                  <div className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {t({ zh: `核心残基（ΔSASA > 1 Å²）：${buried.cross.labelA} ${buried.coreA.length} · ${buried.cross.labelB} ${buried.coreB.length} · ${buried.ms.toFixed(0)} ms`, en: `Core residues (ΔSASA > 1 Å²): ${buried.cross.labelA} ${buried.coreA.length} · ${buried.cross.labelB} ${buried.coreB.length} · ${buried.ms.toFixed(0)} ms` })}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => selectXbsaSide('a')}
                      className="rounded-md border border-rose-500/40 px-2 py-1.5 text-[10px] font-medium text-rose-600 transition hover:bg-rose-500/15 dark:text-rose-300"
                    >
                      {t({ zh: `选 ${buried.cross.labelA} 核心`, en: `Select ${buried.cross.labelA} core` })}
                    </button>
                    <button
                      onClick={() => selectXbsaSide('b')}
                      className="rounded-md border border-cyan-500/40 px-2 py-1.5 text-[10px] font-medium text-cyan-600 transition hover:bg-cyan-500/15 dark:text-cyan-300"
                    >
                      {t({ zh: `选 ${buried.cross.labelB} 核心`, en: `Select ${buried.cross.labelB} core` })}
                    </button>
                  </div>
                </div>
              )}
              {(!buried || !buried.cross || buried.cross.idA !== cross.idA || buried.cross.idB !== cross.idB) && (
                <div className="mt-1 space-y-1.5">
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {t({ zh: '三路 SASA（A 单独 / B 单独 / A∪B 联合）——游离构象视角的界面埋藏面积，与复合物本体 ', en: 'Three-way SASA (A alone / B alone / A∪B combined) — interface buried area from the free-state perspective; comparing against the complex’s own ' })}<span className="font-mono">bsa</span>{t({ zh: ' 对照可佐证表位保守性。', en: ' corroborates epitope conservation.' })}
                    <span className="text-foreground/70">{t({ zh: '默认 protein 会纳入两结构全部原子', en: 'The default protein expression includes all atoms of both structures' })}</span>{t({ zh: '；叠合后若有大范围重合（如游离抗原 vs 复合物同源链），数值会明显偏大——建议改用链限定后重跑检测，xbsa 自动沿用新掩码。', en: '; after superposition, extensive overlap (e.g. free antigen vs a complex homolog chain) inflates values markedly — rerun detection with a chain-restricted expression, xbsa reuses the new masks automatically.' })}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {XBSA_EXPR_EXAMPLES.map(ex => (
                      <button
                        key={ex.label}
                        onClick={() => { setXExprA(ex.expr); setXExprB(ex.expr) }}
                        title={t({ zh: `两结构同用：${ex.expr}（设置后需重新检测跨结构接触）`, en: `Apply to both structures: ${ex.expr} (re-run cross-contact detection after setting)` })}
                        className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[9px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {entry && !xMode && (
        <>
          <div className="space-y-2 px-2">
            <ExprInput
              label={t({ zh: 'A 组', en: 'Group A' })} tone="rose"
              value={aExpr} onChange={v => setExpr('a', v)}
              count={counts.a} error={errors.a}
              placeholder={t({ zh: '如 chain A / resn HEM / within 8 of ...', en: 'e.g. chain A / resn HEM / within 8 of ...' })}
            />
            <ExprInput
              label={t({ zh: 'B 组', en: 'Group B' })} tone="cyan"
              value={bExpr} onChange={v => setExpr('b', v)}
              count={counts.b} error={errors.b}
              placeholder={t({ zh: '如 chain B / protein / ligand', en: 'e.g. chain B / protein / ligand' })}
            />
            <div className="rounded-lg border border-border px-2.5 py-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{t({ zh: '距离截断', en: 'Distance cutoff' })}</span>
                <span className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">{cutoff.toFixed(1)} Å</span>
              </div>
              <Slider
                value={[cutoff]}
                min={3} max={8} step={0.5}
                aria-label={t({ zh: '接触距离截断', en: 'Contact distance cutoff' })}
                onValueChange={([v]) => setCutoff(v)}
                className="mt-1.5"
              />
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={run}
                className="mol-btn-primary flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90"
              >
                <Play className="h-3.5 w-3.5" />
                {t({ zh: '分析接触', en: 'Analyze contacts' })}
              </button>
              {hasResult && (
                <button
                  onClick={() => { clear(); engineRef.current?.updateContacts() }}
                  title={t({ zh: '清除结果与连线', en: 'Clear results and lines' })}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:border-destructive/50 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {stale && (
            <p className="mx-2 mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              {t({ zh: '结果属于其它结构，重新运行分析以更新。', en: 'These results belong to another structure — re-run the analysis to update.' })}
            </p>
          )}

          {hasResult && (
            <>
              <SectionTitle right={
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
                    <Switch
                      checked={visible}
                      onCheckedChange={v => { setVisible(v); engineRef.current?.updateContacts() }}
                      className="scale-90"
                    />
                    {t({ zh: '连线', en: 'Lines' })}
                  </label>
                </div>
              }>
                {t({ zh: `接触图谱 (${pairs.length} 对)`, en: `Contact map (${pairs.length} pairs)` })}
              </SectionTitle>

              <div className="px-2">
                <div className="mb-2 grid grid-cols-3 gap-1.5">
                  <Stat label={t({ zh: '接触对', en: 'Contact pairs' })} value={pairs.length.toLocaleString(locale)} />
                  <Stat label={t({ zh: 'A 侧残基', en: 'A-side residues' })} value={residuesA.length.toLocaleString(locale)} tone="rose" />
                  <Stat label={t({ zh: 'B 侧残基', en: 'B-side residues' })} value={residuesB.length.toLocaleString(locale)} tone="cyan" />
                </div>

                <div className="mol-scroll panel-card relative overflow-x-auto p-1.5">
                  <canvas
                    ref={canvasRef}
                    onMouseMove={onMapMove}
                    onMouseLeave={() => setHover(null)}
                    onClick={onMapClick}
                    className={cn('block cursor-pointer', !mapData && 'hidden')}
                  />
                  {!mapData && (
                    <p className="px-2 py-3 text-center text-[10px] text-muted-foreground">{t({ zh: '无接触数据', en: 'No contact data' })}</p>
                  )}
                  {hover && hoverPair && mapData && (
                    <div
                      className="mol-elevate pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[10px] tabular-nums text-popover-foreground"
                      style={{ left: hover.x + 12, top: hover.y - 8 }}
                    >
                      {mapData.data.residues[hoverPair.resA].chainId.trim()}:
                      {mapData.data.residues[hoverPair.resA].resName}{mapData.data.residues[hoverPair.resA].resSeq}
                      {' ↔ '}
                      {mapData.data.residues[hoverPair.resB].chainId.trim()}:
                      {mapData.data.residues[hoverPair.resB].resName}{mapData.data.residues[hoverPair.resB].resSeq}
                      <span className="ml-1.5 font-bold text-amber-600 dark:text-amber-400">{hoverPair.minDist.toFixed(2)} Å</span>
                      <span className="ml-1 text-muted-foreground">({t({ zh: `${hoverPair.count} 对`, en: `${hoverPair.count} pairs` })})</span>
                    </div>
                  )}
                </div>
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <MousePointerClick className="h-3 w-3 shrink-0" />
                  {t({ zh: '点击图谱单元格选择该残基对；颜色近红远琥珀，对应 3D 视图连线。', en: 'Click a map cell to select that residue pair; color runs red (near) to amber (far), matching the 3D view lines.' })}
                </p>

                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  <button
                    onClick={() => selectSide('a')}
                    className="flex items-center justify-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[10px] font-medium text-rose-600 transition hover:bg-rose-500/20 dark:text-rose-400"
                  >
                    {t({ zh: '选 A 侧界面', en: 'Select A-side interface' })}
                  </button>
                  <button
                    onClick={() => selectSide('b')}
                    className="flex items-center justify-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-1.5 text-[10px] font-medium text-cyan-600 transition hover:bg-cyan-500/20 dark:text-cyan-300"
                  >
                    {t({ zh: '选 B 侧界面', en: 'Select B-side interface' })}
                  </button>
                  <button
                    onClick={() => selectSide('both')}
                    className="flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent"
                  >
                    {t({ zh: '选全部界面', en: 'Select full interface' })}
                  </button>
                </div>

                {/* 接触残基对列表（按距离/接触数排序 · 筛选 · 点击跳转聚焦） */}
                {mapData && (
                  <ContactPairsTable
                    data={mapData.data}
                    pairs={mapData.pairs}
                    cutoff={cutoff}
                    onPick={focusResiduePair}
                  />
                )}
              </div>
            </>
          )}

          {/* 氢键网络残基对（B 键 / hbonds 命令开启后实时联动） */}
          {hbValid && (
            <>
              <SectionTitle right={
                <span className="text-[10px] font-normal tabular-nums text-muted-foreground">
                  {t({ zh: `共 ${hbCount.toLocaleString(locale)} 键 · 按距离`, en: `${hbCount.toLocaleString(locale)} bonds · by distance` })}
                </span>
              }>
                {t({ zh: '氢键网络 · 残基对', en: 'H-bond network · residue pairs' })}
              </SectionTitle>
              <div className="px-2">
                <HBondPairsTable data={data} pairs={hbPairs} onPick={focusResiduePair} />
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Crosshair className="h-3 w-3 shrink-0" />
                  {t({ zh: '点击行选择并聚焦该氢键两侧残基；范围随当前选择变化（B 键重开）。', en: 'Click a row to select and focus the residues flanking that H-bond; the scope follows the current selection (press B to re-run).' })}
                </p>
              </div>
            </>
          )}

          <SectionTitle right={
            <span className="text-[10px] font-normal font-mono tabular-nums text-muted-foreground">
              {sasaStructureId === activeId && sasaTotal > 0 ? t({ zh: `${sasaProbe} Å · ${sasaPoints} 点 · ${sasaMs.toFixed(0)} ms`, en: `${sasaProbe} Å · ${sasaPoints} pts · ${sasaMs.toFixed(0)} ms` }) : 'Shrake–Rupley'}
            </span>
          }>
            {t({ zh: '溶剂可及面积 (SASA)', en: 'Solvent-accessible area (SASA)' })}
          </SectionTitle>
          <div className="px-2">
            <div className="rounded-lg border border-border px-2.5 py-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{t({ zh: '水探针半径', en: 'Water probe radius' })}</span>
                <span className="font-mono font-semibold tabular-nums text-cyan-600 dark:text-cyan-400">{probe.toFixed(1)} Å</span>
              </div>
              <Slider
                value={[probe]}
                min={0.8} max={2.0} step={0.1}
                aria-label={t({ zh: '水探针半径', en: 'Water probe radius' })}
                onValueChange={([v]) => setProbe(v)}
                className="mt-1.5"
              />
              <div className="mt-1.5 flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{t({ zh: '采样点数/原子', en: 'Sample points/atom' })}</span>
                <div className="flex gap-1">
                  {[64, 92, 128, 256].map(np => (
                    <button
                      key={np}
                      onClick={() => setNPoints(np)}
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition',
                        nPoints === np
                          ? 'bg-primary/15 font-semibold text-primary'
                          : 'text-muted-foreground hover:bg-accent',
                      )}
                    >{np}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={runSasa}
                disabled={sasaComputing}
                className="mol-btn-primary flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
              >
                {sasaComputing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Droplets className="h-3.5 w-3.5" />}
                {sasaComputing ? t({ zh: '计算中…', en: 'Computing…' }) : t({ zh: '计算 SASA', en: 'Compute SASA' })}
              </button>
              <button
                onClick={() => { applyColor('sasa'); appendLog('out', tt({ zh: '已按 SASA 暴露度着色：埋藏蓝紫 → 暴露橙红（需先计算 SASA）', en: 'Colored by SASA exposure: buried blue-violet → exposed orange-red (compute SASA first)' })) }}
                title={t({ zh: '按暴露度着色（埋藏蓝 → 暴露橙红）', en: 'Color by exposure (buried blue → exposed orange-red)' })}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:border-primary/50 hover:text-primary"
              >
                <Palette className="h-3.5 w-3.5" />
              </button>
            </div>

            {sasaStructureId === activeId && sasaTotal > 0 && (
              <>
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  <Stat label={t({ zh: '总 SASA', en: 'Total SASA' })} value={sasaTotal.toFixed(0)} />
                  <Stat label={t({ zh: '疏水', en: 'Hydrophobic' })} value={sasaHydrophobic.toFixed(0)} tone="cyan" />
                  <Stat label={t({ zh: '极性', en: 'Polar' })} value={sasaPolar.toFixed(0)} tone="rose" />
                  <Stat label={t({ zh: '水/配体', en: 'Water/ligand' })} value={sasaHet.toFixed(0)} />
                </div>
                <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full" title={t({ zh: '疏水/极性/水与配体的面积占比', en: 'Area share of hydrophobic / polar / water & ligand' })}>
                  <div className="bg-cyan-500/70" style={{ width: `${sasaHydrophobic / sasaTotal * 100}%` }} />
                  <div className="bg-rose-500/70" style={{ width: `${sasaPolar / sasaTotal * 100}%` }} />
                  <div className="bg-muted" style={{ width: `${sasaHet / sasaTotal * 100}%` }} />
                </div>
                <div className="mol-scroll panel-card mt-2 max-h-40 overflow-y-auto">
                  <p className="mol-micro sticky top-0 bg-card px-2 py-1 text-muted-foreground">{t({ zh: 'Top 暴露残基（Å²）', en: 'Top exposed residues (Å²)' })}</p>
                  {topResidues.map(({ resIdx, area }, i) => {
                    const r = data?.residues[resIdx]
                    if (!r) return null
                    const max = topResidues[0]?.area || 1
                    return (
                      <button
                        key={resIdx}
                        onClick={() => {
                          if (!activeId || !data) return
                          const idx: number[] = []
                          for (let ai = r.start; ai < r.end; ai++) idx.push(ai)
                          setSelection(activeId, idx)
                        }}
                        className="group flex w-full items-center gap-2 px-2 py-1 text-left transition hover:bg-accent/50"
                      >
                        <span className="w-4 shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="w-20 shrink-0 truncate font-mono text-[10px] font-medium">{r.chainId.trim()}:{r.resName}{r.resSeq}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-cyan-500/60" style={{ width: `${area / max * 100}%` }} />
                        </span>
                        <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-cyan-600 dark:text-cyan-400">{area.toFixed(0)}</span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {hasResult && (
              <div className="panel-card mt-2 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    {t({ zh: '界面埋藏面积 (ΔSASA)', en: 'Interface buried area (ΔSASA)' })}
                  </span>
                  <button
                    onClick={runBsa}
                    disabled={buried?.computing}
                    className="mol-btn-primary rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                  >
                    {buried?.computing ? t({ zh: '计算中…', en: 'Computing…' }) : buried?.structureId === activeId ? t({ zh: '重算', en: 'Recompute' }) : t({ zh: '计算', en: 'Compute' })}
                  </button>
                </div>
                {buried && buried.structureId === activeId && !buried.computing && (
                  <div className="mt-1.5">
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label={t({ zh: 'A 侧埋藏', en: 'A-side buried' })} value={`${buried.buriedA.toFixed(0)} Å²`} tone="rose" />
                      <Stat label={t({ zh: 'B 侧埋藏', en: 'B-side buried' })} value={`${buried.buriedB.toFixed(0)} Å²`} tone="cyan" />
                      <Stat label={t({ zh: '合计', en: 'Total' })} value={`${(buried.buriedA + buried.buriedB).toFixed(0)} Å²`} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
                      <span>{t({ zh: `核心界面残基（ΔSASA > 1 Å²）：A ${buried.coreA.length} · B ${buried.coreB.length} · ${buried.ms.toFixed(0)} ms`, en: `Core interface residues (ΔSASA > 1 Å²): A ${buried.coreA.length} · B ${buried.coreB.length} · ${buried.ms.toFixed(0)} ms` })}</span>
                    </div>
                    <button
                      onClick={() => {
                        if (!activeId || !data) return
                        const idx = [
                          ...interfaceAtomIndices(data, buried.coreA),
                          ...interfaceAtomIndices(data, buried.coreB),
                        ]
                        setSelection(activeId, idx)
                        appendLog('out', tt({ zh: `已选择界面核心残基：A ${buried.coreA.length} + B ${buried.coreB.length} 残基（${idx.length} 原子，ΔSASA > 1 Å²）`, en: `Selected core interface residues: A ${buried.coreA.length} + B ${buried.coreB.length} residues (${idx.length} atoms, ΔSASA > 1 Å²)` }))
                      }}
                      className="mt-1.5 w-full rounded-md border border-border px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
                    >
                      {t({ zh: '选核心界面残基（ΔSASA 判据，比距离截断更准）', en: 'Select core interface residues (ΔSASA criterion, more precise than the distance cutoff)' })}
                    </button>
                  </div>
                )}
                {(!buried || buried.structureId !== activeId) && (
                  <p className="mt-1 text-[10px] text-muted-foreground">{t({ zh: '基于接触 A/B 组三路 SASA（单独/单独/复合）计算埋藏面积，判据比距离截断更严格。', en: 'Buried area from three-way SASA of the contact A/B groups (alone / alone / complex) — a stricter criterion than the distance cutoff.' })}</p>
                )}
              </div>
            )}
          </div>

          <SectionTitle>{t({ zh: '二级结构', en: 'Secondary structure' })}</SectionTitle>
          <div className="px-2">
            <SSComposition structureId={activeId} />
            <button
              onClick={() => {
                if (!activeId) return
                const r = recomputeSS(activeId)
                if (r.error) return appendLog('err', tt({ zh: `DSSP 失败：${r.error}`, en: `DSSP failed: ${r.error}` }))
                const total = r.helix + r.strand + r.loop
                const pct = (v: number) => total > 0 ? (v / total * 100).toFixed(0) : '0'
                appendLog('out', tt({ zh: `DSSP 重算完成：螺旋 ${r.helix}（${pct(r.helix)}%）· 折叠 ${r.strand}（${pct(r.strand)}%）· 环 ${r.loop}（${pct(r.loop)}%）`, en: `DSSP recompute done: helix ${r.helix} (${pct(r.helix)}%) · strand ${r.strand} (${pct(r.strand)}%) · loop ${r.loop} (${pct(r.loop)}%)` }))
              }}
              className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[11px] font-medium text-muted-foreground transition hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t({ zh: 'DSSP 重算二级结构', en: 'Recompute secondary structure (DSSP)' })}
            </button>
          </div>
        </>
      )}

      <PanelHint>
        <span className="flex items-center gap-1"><Network className="inline h-3 w-3" /> {t({ zh: 'contacts 命令同样可用：', en: 'The contacts command also works:' })}</span>
        <span className="font-mono">contacts chain A | chain B 4.0</span>{t({ zh: ' 或快捷链间 ', en: ' or the quick inter-chain ' })}<span className="font-mono">interface A B</span>{t({ zh: '。', en: '.' })}
      </PanelHint>
    </div>
  )
}

// ---------- 子组件 ----------

function ExprInput({ label, tone, value, onChange, count, error, placeholder }: {
  label: string
  tone: 'rose' | 'cyan'
  value: string
  onChange: (v: string) => void
  count?: number
  error?: string
  placeholder?: string
}) {
  const { t, locale } = useI18n()
  const toneCls = tone === 'rose'
    ? 'border-rose-500/40 text-rose-600 dark:text-rose-400'
    : 'border-cyan-500/40 text-cyan-600 dark:text-cyan-300'
  return (
    <div className={cn('rounded-lg border bg-card px-2.5 py-1.5', error ? 'border-destructive/60' : 'border-border')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider', toneCls)}>
          {label}
        </span>
        {count !== undefined && <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{t({ zh: `${count.toLocaleString(locale)} 原子`, en: `${count.toLocaleString(locale)} atoms` })}</span>}
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        placeholder={placeholder}
        spellCheck={false}
        className="mt-1 w-full bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50"
      />
      {error && <p className="mt-0.5 text-[9px] text-destructive">{error}</p>}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'rose' | 'cyan' }) {
  return (
    <div className="panel-card px-2 py-1.5 text-center">
      <div className={cn(
        'font-mono text-[13px] font-bold tabular-nums',
        tone === 'rose' && 'text-rose-600 dark:text-rose-400',
        tone === 'cyan' && 'text-cyan-600 dark:text-cyan-300',
        !tone && 'text-foreground',
      )}>{value}</div>
      <div className="text-[9px] text-muted-foreground">{label}</div>
    </div>
  )
}

/** 二级结构组成（H/E/L 堆叠条 + 百分比） */
function SSComposition({ structureId }: { structureId: string | null }) {
  const { t } = useI18n()
  const visualRev = useMolStore(s => s.visualRev)
  const stats = useMemo(() => {
    void visualRev
    if (!structureId) return null
    const data = dataRegistry.get(structureId)
    if (!data) return null
    let h = 0, e = 0, l = 0
    for (const r of data.residues) {
      if (r.water || !r.polymer) continue
      if (r.ss === 'H') h++
      else if (r.ss === 'E') e++
      else l++
    }
    const total = h + e + l
    return total > 0 ? { h, e, l, total } : null
  }, [structureId, visualRev])
  if (!stats) return <p className="px-1 text-[10px] text-muted-foreground">{t({ zh: '无聚合物残基', en: 'No polymer residues' })}</p>
  const pct = (v: number) => (v / stats.total * 100).toFixed(0)
  return (
    <div className="panel-card px-2.5 py-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        <div className="bg-rose-500/80" style={{ width: `${stats.h / stats.total * 100}%` }} title={t({ zh: `螺旋 ${stats.h}`, en: `Helix ${stats.h}` })} />
        <div className="bg-amber-500/80" style={{ width: `${stats.e / stats.total * 100}%` }} title={t({ zh: `折叠 ${stats.e}`, en: `Strand ${stats.e}` })} />
        <div className="bg-muted" style={{ width: `${stats.l / stats.total * 100}%` }} title={t({ zh: `环 ${stats.l}`, en: `Loop ${stats.l}` })} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums">
        <span className="text-rose-600 dark:text-rose-400">{t({ zh: `螺旋 ${stats.h}（${pct(stats.h)}%）`, en: `Helix ${stats.h} (${pct(stats.h)}%)` })}</span>
        <span className="text-amber-600 dark:text-amber-400">{t({ zh: `折叠 ${stats.e}（${pct(stats.e)}%）`, en: `Strand ${stats.e} (${pct(stats.e)}%)` })}</span>
        <span className="text-muted-foreground">{t({ zh: `环 ${stats.l}（${pct(stats.l)}%）`, en: `Loop ${stats.l} (${pct(stats.l)}%)` })}</span>
      </div>
    </div>
  )
}

// ---------- 残基对表格（接触 / 氢键共用交互：点击行 = 选择两侧残基 + 相机聚焦） ----------

/** 表格工具条：筛选输入 + 排序切换 + 展开/收起 */
function PairTableToolbar({
  filter, onFilter, sortBy, onSortBy, shown, total,
}: {
  filter: string
  onFilter: (v: string) => void
  sortBy: 'dist' | 'count'
  onSortBy: (v: 'dist' | 'count') => void
  shown: number
  total: number
}) {
  const { t, locale } = useI18n()
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <input
          value={filter}
          onChange={e => onFilter(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
          placeholder={t({ zh: '筛选残基 / 链…', en: 'Filter residues / chains…' })}
          spellCheck={false}
          aria-label={t({ zh: '筛选残基对', en: 'Filter residue pairs' })}
          className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        {filter && (
          <button
            onClick={() => onFilter('')}
            aria-label={t({ zh: '清除筛选', en: 'Clear filter' })}
            className="shrink-0 rounded text-[9px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex shrink-0 overflow-hidden rounded-md border border-border" role="group" aria-label={t({ zh: '排序方式', en: 'Sort by' })}>
        <button
          onClick={() => onSortBy('dist')}
          aria-pressed={sortBy === 'dist'}
          className={cn('px-1.5 py-1 text-[9px] font-medium transition', sortBy === 'dist' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent')}
        >
          {t({ zh: '距离', en: 'Distance' })}
        </button>
        <button
          onClick={() => onSortBy('count')}
          aria-pressed={sortBy === 'count'}
          className={cn('px-1.5 py-1 text-[9px] font-medium transition', sortBy === 'count' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent')}
        >
          {t({ zh: '数量', en: 'Count' })}
        </button>
      </div>
      <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">{shown}/{total.toLocaleString(locale)}</span>
    </div>
  )
}

/** 接触残基对列表：距离热力着色（与 2D 图谱同族）、点击跳转 */
function ContactPairsTable({ data, pairs, cutoff, onPick }: {
  data: StructureData
  pairs: ContactPair[]
  cutoff: number
  onPick: (resA: number, resB: number, label: string) => void
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')
  const [sortBy, setSortBy] = useState<'dist' | 'count'>('dist')
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = pairs.map(p => {
      const ra = data.residues[p.resA], rb = data.residues[p.resB]
      const la = `${ra.chainId.trim()}:${ra.resName}${ra.resSeq}`
      const lb = `${rb.chainId.trim()}:${rb.resName}${rb.resSeq}`
      return { p, la, lb, text: `${la} ${lb}`.toLowerCase() }
    }).filter(r => !f || r.text.includes(f))
    list.sort((a, b) => (sortBy === 'dist' ? a.p.minDist - b.p.minDist : b.p.count - a.p.count))
    return list
  }, [pairs, data, filter, sortBy])
  const LIMIT = 50
  const shown = showAll ? rows : rows.slice(0, LIMIT)
  if (!rows.length) return null
  return (
    <div className="panel-card mt-2 p-1.5">
      <PairTableToolbar filter={filter} onFilter={setFilter} sortBy={sortBy} onSortBy={setSortBy} shown={shown.length} total={rows.length} />
      <div className="mol-scroll max-h-72 overflow-y-auto" role="listbox" aria-label={t({ zh: '接触残基对列表', en: 'Contact residue pair list' })}>
        {shown.map(({ p, la, lb }) => {
          // 距离热力（近红远琥珀，与 2D 图谱/3D 连线同族）
          const t = Math.max(0, Math.min(1, (p.minDist - 2.5) / Math.max(0.5, cutoff - 2.5)))
          const [r, g, b] = heatColor(t)
          return (
            <button
              key={`${p.resA}:${p.resB}`}
              role="option"
              aria-selected={false}
              onClick={() => onPick(p.resA, p.resB, tt({ zh: `${la} ↔ ${lb}（${p.minDist.toFixed(2)} Å）`, en: `${la} ↔ ${lb} (${p.minDist.toFixed(2)} Å)` }))}
              className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[10px] tabular-nums transition hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-rose-600 dark:text-rose-400">{la}</span>
                <span className="mx-1 text-muted-foreground/60">↔</span>
                <span className="text-cyan-600 dark:text-cyan-300">{lb}</span>
              </span>
              <span className="w-14 shrink-0 text-right font-bold tabular-nums" style={{ color: `rgb(${r},${g},${b})` }}>
                {p.minDist.toFixed(2)} Å
              </span>
              <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">×{p.count}</span>
              <MoveUpRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition group-hover:text-primary" />
            </button>
          )
        })}
      </div>
      {rows.length > LIMIT && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="mt-1 w-full rounded py-1 text-center text-[9px] tabular-nums text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          {showAll ? t({ zh: '收起（仅前 50 行）', en: 'Collapse (top 50 rows)' }) : t({ zh: `展开全部 ${rows.length} 行`, en: `Expand all ${rows.length} rows` })}
        </button>
      )}
    </div>
  )
}

/** 氢键残基对列表：供体 → 受体（emerald/cyan），点击跳转 */
function HBondPairsTable({ data, pairs, onPick }: {
  data: StructureData
  pairs: HBondPairSummary[]
  onPick: (resA: number, resB: number, label: string) => void
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return pairs
      .map(p => {
        const rd = data.residues[p.donorRes], ra = data.residues[p.acceptorRes]
        const ld = `${rd.chainId.trim()}:${rd.resName}${rd.resSeq}`
        const la = `${ra.chainId.trim()}:${ra.resName}${ra.resSeq}`
        return { p, ld, la, text: `${ld} ${la}`.toLowerCase() }
      })
      .filter(r => !f || r.text.includes(f))
  }, [pairs, data, filter])
  const LIMIT = 50
  const shown = showAll ? rows : rows.slice(0, LIMIT)
  if (!rows.length) return null
  return (
    <div className="panel-card p-1.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            placeholder={t({ zh: '筛选残基 / 链…', en: 'Filter residues / chains…' })}
            spellCheck={false}
            aria-label={t({ zh: '筛选氢键残基对', en: 'Filter H-bond residue pairs' })}
            className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              aria-label={t({ zh: '清除筛选', en: 'Clear filter' })}
              className="shrink-0 rounded text-[9px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>
        <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">{shown.length}/{rows.length}</span>
      </div>
      <div className="mol-scroll max-h-72 overflow-y-auto" role="listbox" aria-label={t({ zh: '氢键残基对列表', en: 'H-bond residue pair list' })}>
        {shown.map(({ p, ld, la }) => {
          const t = Math.max(0, Math.min(1, (p.minDist - 2.0) / 1.5))
          return (
            <button
              key={`${p.donorRes}:${p.acceptorRes}`}
              role="option"
              aria-selected={false}
              onClick={() => onPick(p.donorRes, p.acceptorRes, tt({ zh: `${ld} → ${la}（${p.minDist.toFixed(2)} Å）`, en: `${ld} → ${la} (${p.minDist.toFixed(2)} Å)` }))}
              className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[10px] tabular-nums transition hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-emerald-600 dark:text-emerald-400">{ld}</span>
                <span className="mx-1 text-muted-foreground/60">→</span>
                <span className="text-cyan-600 dark:text-cyan-300">{la}</span>
              </span>
              <span
                className="w-14 shrink-0 text-right font-bold tabular-nums"
                style={{ color: `rgb(${Math.round(16 + 220 * t)},${Math.round(185 - 120 * t)},${Math.round(129 - 80 * t)})` }}
              >
                {p.minDist.toFixed(2)} Å
              </span>
              <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">×{p.count}</span>
              <MoveUpRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition group-hover:text-primary" />
            </button>
          )
        })}
      </div>
      {rows.length > LIMIT && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="mt-1 w-full rounded py-1 text-center text-[9px] tabular-nums text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          {showAll ? t({ zh: '收起（仅前 50 行）', en: 'Collapse (top 50 rows)' }) : t({ zh: `展开全部 ${rows.length} 行`, en: `Expand all ${rows.length} rows` })}
        </button>
      )}
    </div>
  )
}