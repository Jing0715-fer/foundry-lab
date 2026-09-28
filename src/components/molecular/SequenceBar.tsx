'use client'

// 序列条：PyMOL/Jalview 式专业序列视图
// - 独立刻度行（每 10 位残基号 + 每 5 位小刻度）——字母行永远显示氨基酸缩写，水平垂直居中
// - 紧凑格宽 19px（密度 +37%）；SS 轨道 2px；视口聚焦下划线；选中 ring-inset 不遮邻格
// - 鼠标拖拽批量选取（Shift 追加 / Alt 移除）+ 跟随鼠标的浮动范围提示 + Esc 取消
// - 框选完成浮出「保存选择」条（快照命名保存）；头部选择库 popover 召回/聚焦/删除命名选择
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, ChevronDown, ChevronUp, Dna, FlaskConical, ChevronsUpDown, Eye, EyeOff, Search, Trash2, UnfoldHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { dataRegistry, engineRef, useMolStore, buildNamedMasks } from '@/lib/molecular/store'
import { useViewportStore } from '@/lib/molecular/viewport-store'
import { residueOneLetter } from '@/lib/molecular/chemistry'
import { readableInk, residueCssColor, ssCssColor } from '@/lib/molecular/colors'
import { evaluateSelection, maskToIndices } from '@/lib/molecular/selection'
import type { NamedSelection } from '@/lib/molecular/types'
import { useI18n, tt, type DualText } from '@/i18n'
import { cn } from '@/lib/utils'
import { FadeEdge } from './FadeEdge'

const SEQ_HEIGHT_CLASS: Record<string, string> = {
  compact: 'max-h-20',
  normal: 'max-h-40',
  tall: 'max-h-72',
}
const SEQ_HEIGHT_LABEL: Record<string, DualText> = {
  compact: { zh: '紧凑', en: 'Compact' },
  normal: { zh: '标准', en: 'Normal' },
  tall: { zh: '加高', en: 'Tall' },
}

/** 残基格宽（px）：19px 紧凑密度（原 26px），字母居中 */
const CELL_W = 19

// —— 大链渲染防护（r67）——
// 超过 SEQ_CELL_LIMIT 格的链默认折叠（摘要行 + 展开按钮）；手动展开后渲染仍封顶
// SEQ_CELL_HARD 格并附截断提示——病态结构（数万残基单链）不再冻结主线程，
// 正常文件（最长天然链 ~35K 残基也远超 LIMIT，但几乎都 < HARD）功能不受影响。
const SEQ_CELL_LIMIT = 2000
const SEQ_CELL_HARD = 10000

type DragMode = 'replace' | 'add' | 'remove'

/** 拖拽进行态（ref：原始交互数据） */
interface DragState {
  chainIdx: number
  chainRes: number[]
  anchorPos: number
  curPos: number
  mode: DragMode
  sx: number
  sy: number
  moved: boolean
  /** 拖拽链行的横向滚动容器（边缘自动滚动用；每链一行各自的 FadeEdge） */
  scroller: HTMLElement | null
}

/** 拖拽预览渲染态（state：范围高亮 + 浮动提示） */
interface DragView {
  chainIdx: number
  lo: number
  hi: number
  mode: DragMode
  chainRes: number[]
}

export function SequenceBar() {
  const { t, locale } = useI18n()
  const ui = useMolStore(s => s.ui)
  const setUi = useMolStore(s => s.setUi)
  const structures = useMolStore(s => s.structures)
  const activeId = useMolStore(s => s.activeId)
  const selection = useMolStore(s => s.selection)
  const sequenceHeight = useMolStore(s => s.settings.sequenceHeight)
  const seqFocus = useMolStore(s => s.settings.seqFocus)
  const updateSettings = useMolStore(s => s.updateSettings)
  const namedSelections = useMolStore(s => s.namedSelections)
  const saveNamedSelection = useMolStore(s => s.saveNamedSelection)
  const deleteNamedSelection = useMolStore(s => s.deleteNamedSelection)
  const vpStructureId = useViewportStore(s => s.structureId)
  const vpVisible = useViewportStore(s => s.visible)

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  // —— 拖拽批量选取（事件委托 + ref 交互态，state 仅驱动预览/提示）——
  const dragRef = useRef<DragState | null>(null)
  const [dragView, setDragView] = useState<DragView | null>(null)
  const dragTipRef = useRef<HTMLDivElement | null>(null)
  // 拖拽进行中的最近指针坐标（tip 挂载时立即定位，避免左上角闪烁）
  const lastPtRef = useRef({ x: 0, y: 0 })
  /** 拖拽提交后抑制一次原生 click（pointerup 与 click 的目标可能不同，用时间戳兜底） */
  const suppressClickAt = useRef(0)

  // —— 框选保存条（快照 indices，与后续选择变化解耦）——
  const [saveBar, setSaveBar] = useState<null | { chainId: string; from: number; to: number; residues: number; atoms: number; indices: number[] }>(null)
  const [saveName, setSaveName] = useState('')

  // —— 头部选择库 popover ——
  const [libOpen, setLibOpen] = useState(false)
  const [libName, setLibName] = useState('')

  // —— 大链折叠（渲染防护）：超 SEQ_CELL_LIMIT 格的链默认折叠，手动展开 ——
  // 切换结构时复位（React 官方「渲染期调整」模式，避免 effect 内同步 setState）
  const [expandedChains, setExpandedChains] = useState<Set<number>>(new Set())
  const [prevActive, setPrevActive] = useState(activeId)
  if (prevActive !== activeId) {
    setPrevActive(activeId)
    setExpandedChains(new Set())
  }

  const st = structures.find(x => x.id === activeId)
  const data = activeId ? dataRegistry.get(activeId) : null

  const selectedResidues = useMemo(() => {
    const out = new Set<number>()
    if (!selection.structureId || !data || selection.structureId !== activeId) return out
    for (const i of selection.indices) out.add(data.atomResidue[i])
    return out
  }, [selection, data, activeId])

  /** 视口聚焦：残基是否在当前相机视野内（结构匹配且引擎已算出时；否则视为可见） */
  const visArr = seqFocus && vpStructureId === activeId ? vpVisible : null
  const inView = (ri: number) => (visArr ? visArr[ri] === 1 : true)

  /** 选中变化 → 首个选中残基滚动居中（外部命令/序列条点击/搜索定位统一生效）；
 *  目标格所在链若默认折叠则先展开再重试（展开渲染仍受 SEQ_CELL_HARD 封顶保护） */
  const selRev = selection.rev
  useEffect(() => {
    if (!ui.sequenceOpen || !data || !selection.structureId || selection.structureId !== activeId) return
    const first = selection.indices[0]
    if (first === undefined) return
    const ri = data.atomResidue[first]
    const scroll = () => bodyRef.current?.querySelector<HTMLElement>(`[data-res="${ri}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
    scroll()
    if (!bodyRef.current?.querySelector(`[data-res="${ri}"]`)) {
      // 未命中：目标格可能位于默认折叠的大链——展开后下一拍重试
      const bigIdx: number[] = []
      let ci = 0
      for (const c of data.chains) {
        if (c.type === 'protein' || c.type === 'nucleic') {
          if ((c.residueIdx?.length ?? 0) > SEQ_CELL_LIMIT) bigIdx.push(ci)
          ci++
        }
      }
      if (bigIdx.length) {
        // rAF 回调内展开（异步，避免 effect 体内同步 setState 级联渲染）；再下一拍重试滚动
        requestAnimationFrame(() => {
          setExpandedChains(prev => {
            const next = new Set(prev)
            bigIdx.forEach(i => next.add(i))
            return next
          })
          requestAnimationFrame(scroll)
        })
      }
    }
  }, [selRev, ui.sequenceOpen, activeId, data, selection.structureId, selection.indices])

  /** 残基搜索定位：A57（链+号）/ 57（任意链同号）/ HEM（配体名） */
  const doSearch = () => {
    const q = query.trim()
    if (!q || !data || !activeId) return
    const uq = q.toUpperCase()
    const m = q.match(/^\s*([A-Za-z])?\s*(\d+)\s*([A-Za-z])?\s*$/)
    const resHits: number[] = []
    const ligHits: number[] = []
    for (let ri = 0; ri < data.residues.length; ri++) {
      const r = data.residues[ri]
      if (r.hetero && !r.polymer && !r.water && r.resName.toUpperCase() === uq) ligHits.push(ri)
      if (m) {
        const chainOk = m[1] ? r.chainId.trim().toUpperCase() === m[1].toUpperCase() : true
        const numOk = String(r.resSeq) === m[2] && (m[3] ? (r.iCode || '').toUpperCase() === m[3].toUpperCase() : !r.iCode)
        if (chainOk && numOk) resHits.push(ri)
      }
    }
    const hits = resHits.length ? resHits : ligHits
    if (!hits.length) {
      toast.warning(tt({ zh: `未找到「${q}」：试试 残基号（57）、链+号（A57）或配体名（HEM）`, en: `No match for "${q}" — try residue number (57), chain+number (A57), or ligand name (HEM)` }))
      return
    }
    const indices: number[] = []
    for (const ri of hits) {
      const r = data.residues[ri]
      for (let i = r.start; i < r.end; i++) indices.push(i)
    }
    useMolStore.getState().setActive(activeId)
    useMolStore.getState().setSelection(activeId, indices)
    setSearchOpen(false)
    const firstHit = data.residues[hits[0]]
    toast.success(tt(resHits.length
      ? { zh: `已定位并选中 ${firstHit.resName}${firstHit.resSeq}（链 ${firstHit.chainId.trim() || '?'}）等 ${hits.length} 个残基`, en: `Located and selected ${firstHit.resName}${firstHit.resSeq} (chain ${firstHit.chainId.trim() || '?'}) — ${hits.length} residues in total` }
      : { zh: `已定位并选中 ${hits.length} 个 ${uq} 残基`, en: `Located and selected ${hits.length} ${uq} residues` }))
  }

  // ———— 拖拽批量选取：window 级 pointermove/up + Esc 取消（早退前挂载，内部 null 守卫）————
  // 含边缘自动滚动（r52 backlog）：指针贴近滚动容器左右边缘时 rAF 持续滚动，
  // 滚动后用 elementFromPoint 重算指针下的格子（不依赖各浏览器对「滚动到指针下」的
  // pointerover 派发差异）——长链拖到边缘无需松手分段
  useEffect(() => {
    const EDGE = 56          // 边缘触发区宽度（px）
    const MAX_SPEED = 20     // 最大滚动速度（px/帧 @60fps ≈ 1200px/s）
    let autoDir = 0          // -1 左 · 0 停 · 1 右
    let raf = 0
    /** 用指针坐标直接命中格子并推进拖拽范围（自动滚动路径复用 handlePointerOver 语义） */
    const applyCellAt = (x: number, y: number) => {
      const d = dragRef.current
      if (!d || !d.moved) return
      const el = document.elementFromPoint(x, y)
      const cell = el ? el.closest<HTMLElement>('button[data-res]') : null
      if (!cell || Number(cell.dataset.chain) !== d.chainIdx) return
      const k = Number(cell.dataset.k)
      if (k === d.curPos) return
      d.curPos = k
      setDragView({ chainIdx: d.chainIdx, lo: Math.min(d.anchorPos, k), hi: Math.max(d.anchorPos, k), mode: d.mode, chainRes: d.chainRes })
    }
    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      lastPtRef.current = { x: e.clientX, y: e.clientY }
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) {
        d.moved = true
        setDragView({ chainIdx: d.chainIdx, lo: Math.min(d.anchorPos, d.curPos), hi: Math.max(d.anchorPos, d.curPos), mode: d.mode, chainRes: d.chainRes })
      }
      if (d.moved && dragTipRef.current) {
        dragTipRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
      }
      // 边缘检测：进入触发区记录方向并点火 rAF 循环（rAF 空转修复：空闲期不安排帧）；
      // 横向滚动容器 = 拖拽链行自身的 FadeEdge（非外层纵向 body）
      const body = d.scroller
      if (d.moved && body) {
        const r = body.getBoundingClientRect()
        if (e.clientX < r.left + EDGE) autoDir = -1
        else if (e.clientX > r.right - EDGE) autoDir = 1
        else autoDir = 0
        if (autoDir !== 0 && raf === 0) raf = requestAnimationFrame(step)
      }
    }
    // 仅拖拽进行中且指针处于边缘触发区时滚动+续帧；空闲（未拖/离开边缘/已结束）即停转，
    // 不再永续自旋（重入边缘时由 move 重新点火）
    const step = () => {
      const d = dragRef.current
      if (!d || !d.moved || autoDir === 0) { raf = 0; return }
      const body = d.scroller
      if (!body) { raf = 0; return }
      const r = body.getBoundingClientRect()
      const px = lastPtRef.current.x
      // 侵入越深滚越快（线性渐变，最低保底 2px/帧）
      const depth = autoDir < 0 ? Math.min(1, (r.left + EDGE - px) / EDGE) : Math.min(1, (px - (r.right - EDGE)) / EDGE)
      body.scrollLeft += autoDir * Math.max(2, MAX_SPEED * Math.max(0, depth))
      applyCellAt(px, lastPtRef.current.y)
      raf = requestAnimationFrame(step)
    }
    const finish = (commit: boolean) => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      autoDir = 0
      setDragView(null)
      if (!d.moved || !commit || !activeId || !data) return
      const lo = Math.min(d.anchorPos, d.curPos)
      const hi = Math.max(d.anchorPos, d.curPos)
      const residues = d.chainRes.slice(lo, hi + 1)
      const indices: number[] = []
      for (const ri of residues) {
        const r = data.residues[ri]
        if (!r) continue
        for (let i = r.start; i < r.end; i++) indices.push(i)
      }
      useMolStore.getState().setActive(activeId)
      useMolStore.getState().setSelection(activeId, indices, d.mode)
      suppressClickAt.current = Date.now()
      if (d.mode === 'replace' && residues.length) {
        const first = data.residues[residues[0]]
        const last = data.residues[residues[residues.length - 1]]
        setSaveBar({
          chainId: (first.chainId || ' ').trim() || '?',
          from: first.resSeq,
          to: last.resSeq,
          residues: residues.length,
          atoms: indices.length,
          indices,
        })
      }
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    // 拖拽进行中按 Esc：仅取消拖拽——capture 阶段拦截，不再触发全局 deselect（MolViewer Esc 语义）等快捷键
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return
      cancel()
      e.stopPropagation()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, { capture: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, { capture: true })
    }
  }, [activeId, data])

  if (!st || !data) return null

  // 从结构数据取链（含 residueIdx），颜色沿用摘要链调色板（顺序一致）
  const chainEntries = (data.chains || [])
    .map((c, i) => ({ chain: c, color: st.chains[i]?.color ?? '#9aa3ad', origIdx: i }))
  const polymerChains = chainEntries.filter(({ chain }) => chain.type === 'protein' || chain.type === 'nucleic')

  // 配体分子（连通分量）：每个 chip = 一个完整小分子
  const ligandMolecules = (data.molecules || []).slice(0, 60)

  // 视野内统计（聚合物残基；显示在头部副标题）
  let polymerTotal = 0
  let polymerInView = 0
  if (visArr) {
    for (const { chain } of polymerChains) {
      for (const ri of chain.residueIdx || []) {
        polymerTotal++
        if (visArr[ri] === 1) polymerInView++
      }
    }
  }

  const cycleHeight = () => {
    const next = sequenceHeight === 'compact' ? 'normal' : sequenceHeight === 'normal' ? 'tall' : 'compact'
    updateSettings({ sequenceHeight: next })
  }

  const heightLabel = t(SEQ_HEIGHT_LABEL[sequenceHeight] ?? { zh: '标准', en: 'Normal' })

  /** 事件委托：从事件目标解析残基格（data-chain/data-k/data-res） */
  const cellFrom = (e: React.PointerEvent | React.MouseEvent) =>
    (e.target as HTMLElement).closest<HTMLElement>('button[data-res]')

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    const cell = cellFrom(e)
    if (!cell) return
    const ci = Number(cell.dataset.chain)
    const k = Number(cell.dataset.k)
    const chainRes = polymerChains[ci]?.chain.residueIdx || []
    if (k < 0 || k >= chainRes.length) return
    dragRef.current = {
      chainIdx: ci,
      chainRes,
      anchorPos: k,
      curPos: k,
      mode: e.shiftKey ? 'add' : e.altKey ? 'remove' : 'replace',
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      scroller: cell.closest<HTMLElement>('.mol-scroll-x'),
    }
  }

  const handlePointerOver = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || !d.moved) return
    const cell = cellFrom(e)
    if (!cell || Number(cell.dataset.chain) !== d.chainIdx) return
    const k = Number(cell.dataset.k)
    if (k === d.curPos) return
    d.curPos = k
    setDragView({ chainIdx: d.chainIdx, lo: Math.min(d.anchorPos, k), hi: Math.max(d.anchorPos, k), mode: d.mode, chainRes: d.chainRes })
  }

  /** 单格点击（拖拽未成形的落点）：单选 / Shift 追加 / Alt 移除 / 双击聚焦 */
  const handleCellClick = (e: React.MouseEvent) => {
    if (Date.now() - suppressClickAt.current < 350) return
    const cell = cellFrom(e)
    if (!cell || !activeId || !data) return
    const ri = Number(cell.dataset.res)
    const r = data.residues[ri]
    if (!r) return
    useMolStore.getState().setActive(activeId)
    const indices: number[] = []
    for (let i = r.start; i < r.end; i++) indices.push(i)
    if (e.detail >= 2) {
      useMolStore.getState().setSelection(activeId, indices)
      engineRef.current?.fitView([{ structureId: activeId, indices }])
    } else if (e.shiftKey) {
      useMolStore.getState().setSelection(activeId, indices, 'add')
    } else if (e.altKey) {
      useMolStore.getState().setSelection(activeId, indices, 'remove')
    } else {
      useMolStore.getState().setSelection(activeId, indices)
    }
  }

  // ———— 命名选择：保存 / 召回 / 聚焦 ————
  const doSaveBar = () => {
    if (!saveBar || !activeId) return
    const name = saveName.trim()
    if (!name) return toast.error(tt({ zh: '请输入选择名称', en: 'Enter a selection name' }))
    saveNamedSelection(name, saveBar.indices, activeId)
    toast.success(tt({ zh: `已保存命名选择 "${name}"（${saveBar.residues} 残基 · ${saveBar.atoms} 原子）`, en: `Named selection "${name}" saved (${saveBar.residues} residues · ${saveBar.atoms} atoms)` }))
    setSaveBar(null)
    setSaveName('')
  }

  const doSaveLib = () => {
    const name = libName.trim()
    if (!name) return toast.error(tt({ zh: '请输入选择名称', en: 'Enter a selection name' }))
    if (!selection.structureId || !selection.indices.length) return toast.error(tt({ zh: '当前没有选择', en: 'No current selection' }))
    saveNamedSelection(name)
    toast.success(tt({ zh: `已保存命名选择 "${name}"（${selection.indices.length} 原子）`, en: `Named selection "${name}" saved (${selection.indices.length} atoms)` }))
    setLibName('')
  }

  const recallNS = (ns: NamedSelection): boolean => {
    const d = dataRegistry.get(ns.structureId)
    if (!d) {
      toast.error(tt({ zh: '结构数据缺失，无法召回', en: 'Structure data missing — cannot recall' }))
      return false
    }
    useMolStore.getState().setActive(ns.structureId)
    if (ns.indices) {
      useMolStore.getState().setSelection(ns.structureId, ns.indices)
      return true
    }
    if (ns.expr) {
      const res = evaluateSelection(ns.expr, { structure: d, named: buildNamedMasks(ns.structureId, d) })
      if (res.error) {
        toast.error(tt({ zh: `召回失败：${res.error}`, en: `Recall failed: ${res.error}` }))
        return false
      }
      useMolStore.getState().setSelection(ns.structureId, maskToIndices(res.mask))
      return true
    }
    return false
  }

  const focusNS = (ns: NamedSelection) => {
    if (!recallNS(ns)) return
    const sel = useMolStore.getState().selection
    if (sel.structureId) engineRef.current?.fitView([{ structureId: sel.structureId, indices: sel.indices }])
  }

  // 拖拽浮动提示内容（渲染期双语）
  let tip: DualText | null = null
  if (dragView && data) {
    const first = data.residues[dragView.chainRes[dragView.lo]]
    const last = data.residues[dragView.chainRes[dragView.hi]]
    if (first && last) {
      const n = dragView.hi - dragView.lo + 1
      const chain = (first.chainId || ' ').trim() || '?'
      const modeZh = dragView.mode === 'add' ? ' · 追加' : dragView.mode === 'remove' ? ' · 移除' : ''
      const modeEn = dragView.mode === 'add' ? ' · add' : dragView.mode === 'remove' ? ' · remove' : ''
      tip = {
        zh: `${chain} ${first.resSeq}–${last.resSeq} · ${n} 残基${modeZh}`,
        en: `${chain} ${first.resSeq}–${last.resSeq} · ${n} residues${modeEn}`,
      }
    }
  }

  return (
    <div className="tape-well shrink-0 border-y border-border bg-background">
      {/* 头部：标题 + 结构摘要 + 视野徽章 | 选择库 / 搜索定位 / 聚焦 / 高度 */}
      <div className="flex h-8 items-center gap-1 pr-2">
        <button
          onClick={() => setUi({ sequenceOpen: !ui.sequenceOpen })}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-muted-foreground transition hover:text-foreground"
        >
          <Dna className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          <span className="mol-micro shrink-0">{t({ zh: '序列', en: 'Sequence' })}</span>
          <span className="min-w-0 truncate font-mono text-[9px] tabular-nums text-muted-foreground/60">
            {t({ zh: `${st.name} · ${polymerChains.length} 条链 · ${data.residues.length.toLocaleString(locale)} 残基`, en: `${st.name} · ${polymerChains.length} chains · ${data.residues.length.toLocaleString(locale)} residues` })}
          </span>
          {selectedResidues.size > 0 && (
            <span
              className="ml-1 flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 font-mono text-[9px] font-bold tabular-nums text-primary"
              title={t({ zh: `当前选择覆盖 ${selectedResidues.size} 个残基（任何来源：拖拽/3D 点击/命令行/AI；Esc 取消选择）`, en: `Current selection spans ${selectedResidues.size} residues (any source: drag / 3D click / command line / AI; Esc to clear)` })}
            >
              <span className="h-1 w-1 rounded-full bg-primary" />
              {t({ zh: `已选 ${selectedResidues.size}`, en: `${selectedResidues.size} selected` })}
            </span>
          )}
          {visArr && polymerTotal > 0 && (
            <span
              className={cn(
                'ml-1 flex shrink-0 items-center gap-1 font-mono text-[9px] font-medium tabular-nums',
                polymerInView === polymerTotal ? 'text-primary' : 'text-muted-foreground',
              )}
              title={t({ zh: `视野内 ${polymerInView} / 共 ${polymerTotal} 个聚合物残基（相机移动实时更新）`, en: `${polymerInView} of ${polymerTotal} polymer residues in view (updates live as the camera moves)` })}
            >
              <span className={cn('h-1 w-1 shrink-0 rounded-full', polymerInView === polymerTotal ? 'bg-primary' : 'bg-muted-foreground/50')} />
              {t({ zh: `${polymerInView}/${polymerTotal} 视野`, en: `${polymerInView}/${polymerTotal} in view` })}
            </span>
          )}
          <span className="ml-auto shrink-0 text-muted-foreground/70">{ui.sequenceOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}</span>
        </button>

        {ui.sequenceOpen && (
          <>
            <Popover open={libOpen} onOpenChange={setLibOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition',
                    libOpen || namedSelections.length > 0
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                  title={t({ zh: '选择库：保存/召回命名选择（拖拽序列格框选残基后可保存；类似 PyMOL select name, expr）', en: 'Selection library: save/recall named selections (drag over sequence cells to box-select residues; like PyMOL select name, expr)' })}
                  aria-label={t({ zh: '打开选择库', en: 'Open selection library' })}
                >
                  <Bookmark className="h-3 w-3" />
                  {t({ zh: '选择', en: 'Select' })}
                  {namedSelections.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-primary px-1 font-mono text-[8px] font-bold leading-[13px] text-primary-foreground">
                      {namedSelections.length}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-2" align="end" side="top">
                <div className="flex items-center gap-1.5 px-0.5 text-[10px] font-medium text-muted-foreground">
                  <Bookmark className="h-3 w-3" />
                  {t({ zh: '选择库', en: 'Selection library' })}
                  <span className="tabular-nums">{t({ zh: `${namedSelections.length} 个已保存`, en: `${namedSelections.length} saved` })}</span>
                </div>
                {/* 保存当前选择 */}
                {selection.structureId === activeId && selection.indices.length > 0 ? (
                  <div className="mt-1.5 flex gap-1">
                    <input
                      value={libName}
                      onChange={e => setLibName(e.target.value)}
                      onKeyDown={e => {
                        // IME 组合中（中文输入法候选确认的 Enter）不触发保存
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (e.key === 'Enter') doSaveLib()
                      }}
                      placeholder={t({ zh: `命名保存当前选择（${selection.indices.length.toLocaleString(locale)} 原子）…`, en: `Name and save current selection (${selection.indices.length.toLocaleString(locale)} atoms)…` })}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px] outline-none transition focus:border-foreground/30"
                      aria-label={t({ zh: '命名保存当前选择', en: 'Name and save current selection' })}
                    />
                    <button
                      onClick={doSaveLib}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-medium text-primary-foreground transition hover:opacity-90"
                    >
                      <BookmarkPlus className="h-3 w-3" />
                      {t({ zh: '保存', en: 'Save' })}
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 px-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {t({ zh: '当前无选择——在序列上按住鼠标拖拽框选残基，或用命令行 select。', en: 'No current selection — drag over the sequence to box-select residues, or use select in the command line.' })}
                  </p>
                )}
                {/* 已保存列表 */}
                {namedSelections.length > 0 && (
                  <div className="mol-scroll mt-1.5 max-h-64 space-y-0.5 overflow-y-auto">
                    {namedSelections.map(ns => {
                      const stName = structures.find(x => x.id === ns.structureId)?.name
                      return (
                        <div key={ns.name} className="group flex items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-accent">
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">{ns.name}</span>
                          <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{ns.count.toLocaleString(locale)} at</span>
                          {stName && ns.structureId !== activeId && (
                            <span className="max-w-14 shrink-0 truncate text-[9px] text-muted-foreground/70" title={t({ zh: `属于结构 ${stName}`, en: `Belongs to structure ${stName}` })}>{stName}</span>
                          )}
                          <button
                            onClick={() => recallNS(ns)}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary transition hover:bg-primary/10"
                            title={t({ zh: '召回为当前选择', en: 'Recall as current selection' })}
                          >
                            {t({ zh: '选中', en: 'Select' })}
                          </button>
                          <button
                            onClick={() => focusNS(ns)}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                            title={t({ zh: '召回并缩放聚焦', en: 'Recall and zoom to fit' })}
                          >
                            {t({ zh: '聚焦', en: 'Focus' })}
                          </button>
                          <button
                            onClick={() => deleteNamedSelection(ns.name)}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                            title={t({ zh: '删除该命名选择', en: 'Delete this named selection' })}
                            aria-label={t({ zh: `删除 ${ns.name}`, en: `Delete ${ns.name}` })}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                {namedSelections.length === 0 && (
                  <p className="mt-1 px-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {t({ zh: '暂无已保存选择。拖拽序列格框选残基后保存（类似 PyMOL 的 select name, expr），后续可一键召回或聚焦。', en: 'No saved selections yet. Box-select residues on the sequence and save (like PyMOL select name, expr), then recall or focus in one click.' })}
                  </p>
                )}
              </PopoverContent>
            </Popover>
            <Popover open={searchOpen} onOpenChange={setSearchOpen}>
              <PopoverTrigger asChild>
                <button
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  title={t({ zh: '搜索定位残基：残基号（57）、链+号（A57）或配体名（HEM）', en: 'Locate residue: residue number (57), chain+number (A57), or ligand name (HEM)' })}
                  aria-label={t({ zh: '搜索定位残基', en: 'Locate residue' })}
                >
                  <Search className="h-3 w-3" />
                  {t({ zh: '定位', en: 'Locate' })}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-60 p-2" align="end" side="top">
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => {
                    // IME 组合中（中文输入法候选确认的 Enter）不触发定位
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter') doSearch()
                  }}
                  placeholder="57 · A57 · HEM…"
                  autoFocus
                  aria-label={t({ zh: '残基搜索词', en: 'Residue search term' })}
                  className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none transition focus:border-foreground/30"
                />
                <p className="mt-1.5 px-0.5 text-[9px] leading-relaxed text-muted-foreground">
                  {t({ zh: 'Enter 定位：残基号（任意链同号并选）、链字母+号（精确到链）、配体名（如 HEM）。选中后自动滚动到可见位置。', en: 'Press Enter to locate: residue number (same number in any chain), chain letter + number (exact chain), or ligand name (e.g. HEM). Scrolls the hit into view after selecting.' })}
                </p>
              </PopoverContent>
            </Popover>
            <button
              onClick={() => updateSettings({ seqFocus: !seqFocus })}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition',
                seqFocus
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              title={t(seqFocus
                ? { zh: '视口聚焦指示：开（下划线 = 残基在当前相机视野内，切层裁剪同步感知）', en: 'Viewport focus indicator: on (underline = residue within current camera view, syncs with clipping)' }
                : { zh: '视口聚焦指示：关（set seq_focus on 开启）', en: 'Viewport focus indicator: off (enable with set seq_focus on)' })}
              aria-pressed={seqFocus}
            >
              {seqFocus ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {t({ zh: '聚焦', en: 'Focus' })}
            </button>
            <button
              onClick={cycleHeight}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              title={t({ zh: `序列条高度：${heightLabel}（点击切换）`, en: `Sequence bar height: ${heightLabel} (click to cycle)` })}
            >
              <ChevronsUpDown className="h-3 w-3" />
              {heightLabel}
            </button>
          </>
        )}
      </div>

      {ui.sequenceOpen && (
        <div ref={bodyRef} className={cn('mol-scroll overflow-y-auto px-3 pb-2 transition-[max-height] duration-200', SEQ_HEIGHT_CLASS[sequenceHeight] ?? 'max-h-40')}>
          {/* 框选保存条：拖拽框选完成浮出（快照与后续选择变化解耦） */}
          {saveBar && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/[0.06] px-2 py-1.5 shadow-sm">
              <BookmarkPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="shrink-0 text-[11px] font-medium">
                {t({ zh: '已框选', en: 'Box-selected' })} <span className="font-mono tabular-nums">{saveBar.chainId} {saveBar.from}–{saveBar.to}</span>
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {t({ zh: `${saveBar.residues} 残基 · ${saveBar.atoms.toLocaleString(locale)} 原子`, en: `${saveBar.residues} residues · ${saveBar.atoms.toLocaleString(locale)} atoms` })}
              </span>
              <input
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => {
                  // IME 组合中（中文输入法候选确认的 Enter）不触发保存
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter') doSaveBar()
                }}
                placeholder={t({ zh: '命名保存（如 active_site）…', en: 'Save as name (e.g. active_site)…' })}
                className="h-6.5 min-w-28 flex-1 rounded-md border border-border bg-background px-2 text-[11px] outline-none transition focus:border-foreground/30"
                aria-label={t({ zh: '框选范围命名', en: 'Name the boxed range' })}
              />
              <button
                onClick={doSaveBar}
                className="flex h-6.5 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[10px] font-medium text-primary-foreground transition hover:opacity-90"
              >
                {t({ zh: '保存选择', en: 'Save selection' })}
              </button>
              <button
                onClick={() => {
                  if (!activeId) return
                  useMolStore.getState().setSelection(activeId, saveBar.indices)
                  engineRef.current?.fitView([{ structureId: activeId, indices: saveBar.indices }])
                }}
                className="flex h-6.5 shrink-0 items-center rounded-md border border-border bg-background px-2 text-[10px] font-medium transition hover:bg-accent"
                title={t({ zh: '重新选中该范围并缩放聚焦', en: 'Re-select this range and zoom to fit' })}
              >
                {t({ zh: '聚焦', en: 'Focus' })}
              </button>
              <button
                onClick={() => setSaveBar(null)}
                className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                title={t({ zh: '关闭（不保存）', en: 'Close (without saving)' })}
                aria-label={t({ zh: '关闭框选保存条', en: 'Close box-selection save bar' })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* 配体行（置顶免滚动）：每个 chip = 一个完整分子，点击选择、双击聚焦 */}
          {ligandMolecules.length > 0 && (
            <div className="mb-1 flex items-center gap-2 border-b border-dashed border-border/60 pb-2.5 pt-1">
              <span className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border/60 bg-background pr-1">
                <FlaskConical className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                <span className="mol-micro text-muted-foreground">{t({ zh: '配体', en: 'Ligands' })}</span>
              </span>
              <FadeEdge className="gap-1 pb-0.5">
                {ligandMolecules.map(m => {
                  const r0 = data.residues[m.residues[0]]
                  const isSel = m.residues.some(ri => selectedResidues.has(ri))
                  const molInView = visArr ? m.residues.some(ri => visArr[ri] === 1) : true
                  const molIndices: number[] = []
                  for (const ri of m.residues) {
                    const rr = data.residues[ri]
                    for (let i = rr.start; i < rr.end; i++) molIndices.push(i)
                  }
                  return (
                    <button
                      key={m.residues[0]}
                      onClick={() => {
                        useMolStore.getState().setActive(activeId!)
                        useMolStore.getState().setSelection(activeId!, molIndices)
                      }}
                      onDoubleClick={() => {
                        useMolStore.getState().setActive(activeId!)
                        useMolStore.getState().setSelection(activeId!, molIndices)
                        engineRef.current?.fitView([{ structureId: activeId!, indices: molIndices }])
                      }}
                      className={cn(
                        'shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold transition',
                        isSel
                          ? 'border-primary bg-primary/20 text-primary shadow-sm'
                          : 'border-border bg-transparent text-amber-700 hover:-translate-y-px hover:border-amber-500/50 hover:bg-amber-500/10 dark:text-amber-400',
                        visArr && !molInView && 'opacity-45',
                      )}
                      title={t({
                        zh: `${m.label}（链 ${m.chainIds.map(c => c.trim() || '?').join('/')}）· ${m.atoms} 原子${m.residues.length > 1 ? ` · ${m.residues.length} 个残基` : ''}${visArr ? (molInView ? ' · 在视野内' : ' · 视野外') : ''} · 点击选择 · 双击聚焦`,
                        en: `${m.label} (chain ${m.chainIds.map(c => c.trim() || '?').join('/')}) · ${m.atoms} atoms${m.residues.length > 1 ? ` · ${m.residues.length} residues` : ''}${visArr ? (molInView ? ' · in view' : ' · out of view') : ''} · click to select · double-click to focus`,
                      })}
                    >
                      {m.resNames.length > 1 ? m.label : m.resNames[0]}
                      <span className="ml-0.5 text-[9px] font-normal tabular-nums opacity-60">{r0.chainId.trim()}{r0.resSeq}{m.residues.length > 1 && m.resNames.length === 1 ? '+' : ''}</span>
                    </button>
                  )
                })}
              </FadeEdge>
            </div>
          )}

          {polymerChains.map(({ chain, color, origIdx }, ci) => {
            const selectChain = () => {
              useMolStore.getState().setActive(activeId!)
              useMolStore.getState().selectFromExpr(`chainidx ${origIdx}`)
            }
            // 大链渲染防护（r67）：超限链默认折叠；展开后渲染仍封顶 HARD 并附截断提示
            const cells = chain.residueIdx || []
            const isBig = cells.length > SEQ_CELL_LIMIT
            const expanded = expandedChains.has(ci)
            const showCells = !isBig || expanded
            const shown = showCells ? (cells.length > SEQ_CELL_HARD ? cells.slice(0, SEQ_CELL_HARD) : cells) : cells
            const truncated = showCells && cells.length > SEQ_CELL_HARD
            return (
              <div key={`${chain.id}-${ci}`} className="flex items-start gap-2 pb-1.5 pt-0.5">
                <span className="sticky left-0 z-10 mt-3.5 flex shrink-0 items-center gap-1 border-r border-border/60 bg-background pr-1.5">
                  <button
                    onClick={selectChain}
                    onDoubleClick={() => {
                      selectChain()
                      engineRef.current?.fitView([{ structureId: activeId!, indices: useMolStore.getState().selection.indices }])
                    }}
                    className="group flex shrink-0 items-center gap-1 rounded px-0.5 py-0.5 transition hover:bg-accent"
                    title={t({ zh: `点击选择链 ${chain.id.trim() || '—'}（${cells.length} 残基）· 双击聚焦`, en: `Click to select chain ${chain.id.trim() || '—'} (${cells.length} residues) · double-click to focus` })}
                  >
                    <span className="h-3.5 w-1 rounded-full opacity-80 transition group-hover:h-4" style={{ background: color }} />
                    <span className="font-mono text-[11px] font-bold leading-none">{chain.id === ' ' ? '—' : chain.id}</span>
                    <span className="font-mono text-[9px] tabular-nums leading-none text-muted-foreground/70">{cells.length}</span>
                  </button>
                </span>
                {!showCells ? (
                  /* 折叠摘要行：大链默认不渲染格子，点展开（渲染仍受 HARD 封顶保护） */
                  <button
                    onClick={() => setExpandedChains(prev => { const next = new Set(prev); next.add(ci); return next })}
                    className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 text-[10px] font-medium text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                    title={t({ zh: `该链 ${cells.length.toLocaleString(locale)} 残基超出渲染阈值（${SEQ_CELL_LIMIT.toLocaleString(locale)}），已折叠保护性能；点击展开（最多渲染前 ${SEQ_CELL_HARD.toLocaleString(locale)} 格）`, en: `This chain has ${cells.length.toLocaleString(locale)} residues, above the render threshold (${SEQ_CELL_LIMIT.toLocaleString(locale)}) — collapsed to protect performance; click to expand (renders at most the first ${SEQ_CELL_HARD.toLocaleString(locale)} cells)` })}
                  >
                    <UnfoldHorizontal className="h-3 w-3" />
                    {t({ zh: `大链已折叠 · ${cells.length.toLocaleString(locale)} 残基 · 点击展开`, en: `Large chain collapsed · ${cells.length.toLocaleString(locale)} residues · click to expand` })}
                  </button>
                ) : (
                <FadeEdge className="pb-0">
                  <div
                    className="select-none"
                    onPointerDown={handlePointerDown}
                    onPointerOver={handlePointerOver}
                    onClick={handleCellClick}
                  >
                    {/* 刻度行：每 10 位显示残基号（对齐该格中心），每 5 位小刻度 */}
                    <div className="flex">
                      {shown.map((ri, k) => (
                        <RulerCell key={ri} position={k + 1} resSeq={data.residues[ri].resSeq} />
                      ))}
                    </div>
                    {/* 序列行：字母永远显示、居中 */}
                    <div className="flex">
                      {shown.map((ri, k) => {
                        const r = data.residues[ri]
                        const isSel = selectedResidues.has(ri)
                        const cellInView = inView(ri)
                        const cellColor = residueCssColor(r.resName)
                        return (
                          <ResidueCell
                            key={ri}
                            resIdx={ri}
                            chainIdx={ci}
                            pos={k}
                            letter={residueOneLetter(r.resName)}
                            color={cellColor}
                            ink={readableInk(cellColor)}
                            ss={r.ss}
                            title={t({
                              zh: `${r.resName} ${r.resSeq}${r.iCode || ''}（链 ${r.chainId.trim() || '?'} · 序号 ${k + 1}）${r.ss === 'H' ? ' · 螺旋' : r.ss === 'E' ? ' · 折叠' : ''}${visArr ? (cellInView ? ' · 在视野内' : ' · 视野外') : ''}`,
                              en: `${r.resName} ${r.resSeq}${r.iCode || ''} (chain ${r.chainId.trim() || '?'} · #${k + 1})${r.ss === 'H' ? ' · helix' : r.ss === 'E' ? ' · strand' : ''}${visArr ? (cellInView ? ' · in view' : ' · out of view') : ''}`,
                            })}
                            selected={isSel}
                            preview={!!dragView && dragView.chainIdx === ci && k >= dragView.lo && k <= dragView.hi}
                            previewRemove={dragView?.mode === 'remove'}
                            inView={cellInView}
                            showInView={!!visArr}
                            noHover={!!dragView}
                          />
                        )
                      })}
                    </div>
                    {truncated && (
                      <p className="py-1 pl-1 text-[9px] font-medium text-muted-foreground/80">
                        {t({ zh: `仅渲染前 ${SEQ_CELL_HARD.toLocaleString(locale)} 格 · 另有 ${(cells.length - SEQ_CELL_HARD).toLocaleString(locale)} 个残基未显示（命令行/搜索仍可选取）`, en: `Only the first ${SEQ_CELL_HARD.toLocaleString(locale)} cells are rendered · ${ (cells.length - SEQ_CELL_HARD).toLocaleString(locale)} more residues are hidden (still selectable via the command line / search)` })}
                      </p>
                    )}
                  </div>
                </FadeEdge>
                )}
              </div>
            )
          })}
          {polymerChains.length === 0 && (
            <p className="py-2 text-[11px] text-muted-foreground">{t({ zh: '该结构不含聚合物链（仅配体/小分子）。', en: 'This structure has no polymer chains (ligands/small molecules only).' })}</p>
          )}
          <p className="pb-0.5 pt-1 text-[9px] leading-relaxed text-muted-foreground/70">
            {t({ zh: '拖拽字母格批量选取（Shift 追加 / Alt 移除 / Esc 取消）· 点击选残基 · 双击聚焦 · 框选后可命名保存进选择库；任何来源的选择（3D 点击 / 命令行 / AI）都会在序列上以绿色蒙层标识', en: 'Drag letters to box-select (Shift to add / Alt to remove / Esc to cancel) · click to select a residue · double-click to focus · box-selection can be named and saved to the library; selections from any source (3D click / command line / AI) are marked with a green overlay on the sequence' })}
          </p>
        </div>
      )}

      {/* 拖拽跟随提示：外层 JS 定位（每帧 transform，无 React 渲染），内层做居中偏移 */}
      {dragView && tip && (
        <div
          ref={el => {
            dragTipRef.current = el
            if (el) el.style.transform = `translate(${lastPtRef.current.x}px, ${lastPtRef.current.y}px)`
          }}
          className="pointer-events-none fixed left-0 top-0 z-[60]"
        >
          <div className="-translate-x-1/2 -translate-y-[calc(100%+14px)] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[10px] font-medium text-popover-foreground shadow-lg">
            {t(tip)}
            <span className="ml-1.5 text-[9px] text-muted-foreground">{t({ zh: '松开确认', en: 'release to confirm' })}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 刻度格：与序列格同宽；每 10 位显示残基号（真实 PDB 编号），每 5 位小刻度线 */
const RulerCell = memo(function RulerCell({ position, resSeq }: { position: number; resSeq: number }) {
  const major = position % 10 === 0
  const minor = !major && position % 5 === 0
  return (
    <div className="relative h-3 shrink-0" style={{ width: CELL_W }}>
      {major ? (
        <span className="absolute inset-x-0 top-[3px] text-center font-mono text-[8px] font-semibold tabular-nums leading-none text-muted-foreground/75">
          {resSeq}
        </span>
      ) : minor ? (
        <span className="absolute left-1/2 top-[6px] h-[4px] w-px -translate-x-1/2 bg-border" />
      ) : null}
    </div>
  )
})

const ResidueCell = memo(function ResidueCell({
  resIdx, chainIdx, pos, letter, color, ink, ss, title, selected, preview, previewRemove, inView, showInView, noHover,
}: {
  resIdx: number
  chainIdx: number
  pos: number
  letter: string
  color: string
  /** 自适应墨色：按格底色亮度选近黑/近白（readableInk） */
  ink: string
  ss: string
  title: string
  selected: boolean
  /** 拖拽预览：处于框选范围内 */
  preview: boolean
  /** 拖拽为移除模式（红色蒙层） */
  previewRemove: boolean
  inView: boolean
  showInView: boolean
  /** 拖拽进行中：禁用 hover 缩放避免跳动 */
  noHover: boolean
}) {
  return (
    <button
      title={title}
      data-res={resIdx}
      data-chain={chainIdx}
      data-k={pos}
      aria-label={title}
      aria-pressed={selected}
      className={cn(
        'relative flex h-6 shrink-0 items-center justify-center rounded-[3px] outline-none transition-[transform,box-shadow] duration-100',
        !noHover && 'hover:z-10 hover:scale-[1.18] hover:shadow-md',
        selected && 'z-10 ring-2 ring-primary ring-inset',
      )}
      style={{ width: CELL_W, background: color }}
    >
      {/* 二级结构轨道（hover 时提亮；z-[1] 保持浮于选中/预览蒙层之上） */}
      <span
        className="absolute inset-x-[2px] top-0 z-[1] h-[2px] rounded-full"
        style={{ background: ssCssColor(ss), opacity: ss === 'L' ? 0.3 : 0.85 }}
      />
      {/* 氨基酸缩写：永远显示（刻度移至独立行），水平垂直居中；选中时白字+描边浮于蒙层之上 */}
      <span
        className="relative z-[1] text-[10px] font-bold leading-none"
        style={selected
          ? { color: '#ffffff', textShadow: '0 0 2px rgba(0,0,0,0.65), 0 1px 2px rgba(0,0,0,0.45)' }
          : { color: ink }}
      >
        {letter}
      </span>
      {/* 选中蒙层（Jalview 式）：任何来源的选择（拖拽/3D 点击/命令行/AI）均以此显式标识 */}
      {selected && (
        <span className="pointer-events-none absolute inset-0 rounded-[3px] bg-primary/45" />
      )}
      {/* 拖拽框选预览蒙层 */}
      {preview && (
        <span className={cn('pointer-events-none absolute inset-0 rounded-[3px]', previewRemove ? 'bg-destructive/55' : 'bg-primary/55')} />
      )}
      {/* 视口聚焦下划线：残基在当前相机视野内（切层同步感知） */}
      {showInView && inView && (
        <span className="absolute inset-x-[2px] bottom-0 h-[2px] rounded-full bg-primary" />
      )}
    </button>
  )
})
