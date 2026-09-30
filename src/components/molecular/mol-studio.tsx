'use client'

// MolVision 结构工作室（foundry-lab 内嵌版）
// ─────────────────────────────────────────────────────────────────────────────
// 把 MolVision 的分子引擎与完整分析栈内嵌进 foundry-lab 的结果预览：
//   · 引擎：MolEngine（three.js InstancedMesh 表示法 + 拾取 + 测量 + 氢键/接触/孔道覆盖层）
//   · 解析：PDB/mmCIF 自研解析器（键级推断 + DSSP 兜底二级结构 + NMR ensemble）
//   · 分析：DSSP 二级结构 · Shrake–Rupley SASA · Kabsch–Sander 氢键网络 ·
//           接触图/ΔSASA 界面分析 · HOLE 式孔道剖面 · NW 序列对齐叠合
// 两种形态：
//   · inline —— Result 标签页内嵌预览（画布 + 工具栏 + 可折叠分析栏）
//   · full   —— Output Viewer 弹窗完整工作室（画布 + 侧栏五面板 + 序列条）
// 结构生命周期由本组件独占管理：换文件 = 换结构；卸载/挂起 = 清空全局状态。
import * as React from 'react'
import { toast } from 'sonner'
import {
  Atom, Camera, FlaskConical, Maximize, Palette, Ruler, Shapes, Target,
  ChevronDown, Loader2, FileWarning, Network,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n, tt } from '@/i18n'
import { detectFormat, parseStructure } from '@/lib/molecular/parser'
import { PRESETS, useMolStore, engineRef } from '@/lib/molecular/store'
import { textRegistry } from '@/lib/molecular/text-registry'
import { whenEngineReady } from '@/lib/molecular/engine-ready'
import { COLOR_SCHEME_LABELS, type ColorScheme } from '@/lib/molecular/colors'
import { useSasaStore } from '@/lib/molecular/sasa-store'
import { usePoreStore } from '@/lib/molecular/pore-store'
import { useContactStore } from '@/lib/molecular/contacts-store'
import { useHBondStore } from '@/lib/molecular/hbond-store'
import { MolViewerMount } from './mol-viewer-mount'
import { AnalysisPanel } from './panels/AnalysisPanel'
import { RepsPanel } from './panels/RepsPanel'
import { ColorsPanel } from './panels/ColorsPanel'
import { MeasurePanel } from './panels/MeasurePanel'
import { SelectionPanel } from './panels/SelectionPanel'
import { ColorLegend } from './ColorLegend'
import { PoreProfile } from './PoreProfile'
import { ViewportHUD } from './ViewportHUD'
import { SequenceBar } from './SequenceBar'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type MolStudioVariant = 'inline' | 'full'

export interface MolStudioProps {
  /** PDB（或 mmCIF）文本内容 */
  pdbText: string
  /** 展示名（文件基名） */
  name?: string
  /** inline = Result 页紧凑预览；full = 弹窗完整工作室 */
  variant?: MolStudioVariant
  /** inline 形态下进一步压缩画布高度（Inspector 窄面板等） */
  compact?: boolean
  className?: string
  /** 挂起：卸载引擎与结构（避免与同时打开的完整视图双引擎冲突） */
  suspended?: boolean
}

const PRESET_KEYS = ['cartoon', 'ballstick', 'spacefill', 'wireframe', 'surface', 'bindingsite', 'publication', 'hybrid', 'putty'] as const
const COLOR_KEYS: ColorScheme[] = ['chain', 'element', 'spectrum', 'ss', 'residue', 'bfactor', 'sasa', 'pocket', 'uniform']

const RAIL_TABS = [
  { key: 'analysis', label: { zh: '分析', en: 'Analysis' }, icon: FlaskConical },
  { key: 'reps', label: { zh: '表示', en: 'Reps' }, icon: Shapes },
  { key: 'colors', label: { zh: '颜色', en: 'Colors' }, icon: Palette },
  { key: 'measure', label: { zh: '测量', en: 'Measure' }, icon: Ruler },
  { key: 'selection', label: { zh: '选择', en: 'Select' }, icon: Target },
] as const

// —— 多实例所有权登记：全局 store 只装「最近挂载的工作室」的结构 ——
// 内联预览与弹窗完整视图共享一个全局 useMolStore；suspend 机制避免了常规双挂载，
// 但挂起切换/弹窗关闭的同一提交内仍有清理与新增交错——清理只移除自己登记的结构，
// 新挂载的工作室接管时清掉他人残留。被逐出（结构被别人清掉）的实例自动重加载自愈。
const studioInstanceSeq = { current: 0 }
/** structureId → 登记它的工作室实例号 */
const structureOwner = new Map<string, number>()

/** 结构加载 + 全局分析栈生命周期（挂起/换文件/卸载都彻底清理） */
function useStructureLifecycle(pdbText: string, name: string, suspended: boolean): {
  error: string | null
  structId: string | null
} {
  const genRef = React.useRef(0)
  const instanceRef = React.useRef(0)
  if (instanceRef.current === 0) instanceRef.current = ++studioInstanceSeq.current
  const [error, setError] = React.useState<string | null>(null)
  const [structId, setStructId] = React.useState<string | null>(null)
  const [reloadTick, setReloadTick] = React.useState(0)

  // 被逐出自愈：本实例登记的结构被其他实例清掉（接管）时强制重加载
  const structInStore = useMolStore(s => s.structures.some(x => x.id === structId))
  React.useEffect(() => {
    if (structId && !structInStore && !suspended) setReloadTick(t => t + 1)
  }, [structId, structInStore, suspended])

  React.useEffect(() => {
    const gen = ++genRef.current
    const me = instanceRef.current
    if (suspended || !pdbText) {
      setStructId(null)
      setError(null)
      return
    }
    // 延迟到下一帧：让挂载/加载态 UI 先渲染，避免大结构解析阻塞首帧
    let myId: string | null = null
    const raf = requestAnimationFrame(() => {
      if (genRef.current !== gen) return
      try {
        const store = useMolStore.getState()
        // 接管：清掉其他工作室实例登记的结构（suspend 常规路径下此处本就为空）
        for (const e of [...store.structures]) {
          if (structureOwner.get(e.id) !== me) {
            store.removeStructure(e.id)
            structureOwner.delete(e.id)
          }
        }
        // 清掉上一结构的分析残留（satellite stores 不随 removeStructure 自动清）
        useSasaStore.getState().clear()
        usePoreStore.getState().clear()
        useContactStore.getState().clear()
        useHBondStore.getState().setStats(0, 0, false)
        useHBondStore.getState().setPairs([])
        const fmt = detectFormat(pdbText, name)
        const t0 = performance.now()
        const data = parseStructure(pdbText, name, fmt)
        const ms = performance.now() - t0
        if (data.atoms.count === 0) {
          throw new Error(tt({ zh: '文件中没有可识别的原子记录（ATOM/HETATM）', en: 'No recognizable atom records (ATOM/HETATM) in the file' }))
        }
        const id = store.addStructure(data, name, ms)
        structureOwner.set(id, me)
        myId = id
        textRegistry.set(id, pdbText)
        setError(null)
        setStructId(id)
        // 取景 + 自动 SASA（填充分析卡片并启用暴露度着色；失败静默——面板可手动重算）
        whenEngineReady(() => {
          requestAnimationFrame(() => {
            if (genRef.current !== gen) return
            engineRef.current?.fitView()
            engineRef.current?.requestSasa(id)
          })
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStructId(null)
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      if (genRef.current !== gen) return
      // 只移除本实例登记的结构——绝不动其他并行实例（弹窗关闭↔内联回挂的竞态）
      if (myId) {
        const store = useMolStore.getState()
        store.removeStructure(myId)
        structureOwner.delete(myId)
        store.setMeasureMode('off')
        store.clearMeasurePicks()
        store.clearMeasurements()
        store.setSelection(null, [])
        useSasaStore.getState().clear()
        usePoreStore.getState().clear()
        useContactStore.getState().clear()
        useHBondStore.getState().setStats(0, 0, false)
        useHBondStore.getState().setPairs([])
      }
    }
  }, [pdbText, name, suspended, reloadTick])

  return { error, structId }
}

export function MolStudio({
  pdbText,
  name = 'structure',
  variant = 'inline',
  compact = false,
  className,
  suspended = false,
}: MolStudioProps) {
  const { t } = useI18n()
  const inline = variant === 'inline'
  const { error, structId } = useStructureLifecycle(pdbText, name, suspended)

  const [preset, setPreset] = React.useState<string>('cartoon')
  const [colorScheme, setColorScheme] = React.useState<ColorScheme>('chain')
  const [railOpen, setRailOpen] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const panel = useMolStore(s => s.ui.panel)
  const setUi = useMolStore(s => s.setUi)
  const spin = useMolStore(s => s.settings.spin)
  const showHBonds = useMolStore(s => s.settings.showHBonds)
  const measureMode = useMolStore(s => s.measureMode)
  const updateSettings = useMolStore(s => s.updateSettings)
  const applyPreset = useMolStore(s => s.applyPreset)
  const applyColor = useMolStore(s => s.applyColor)
  const activeEntry = useMolStore(s => s.structures.find(x => x.id === s.activeId))
  const poreResult = usePoreStore(s => s.result)
  const sasaComputing = useSasaStore(s => s.computing)

  React.useEffect(() => { setBusy(!structId && !error && !suspended && !!pdbText) }, [structId, error, suspended, pdbText])

  // 面板页签仅覆盖分析/表示/颜色/测量/选择五页——挂载时归位到「分析」
  // （全局 store 默认 panel='structures'，不在内嵌页签集内，会导致空内容）
  React.useEffect(() => {
    const cur = useMolStore.getState().ui.panel
    if (!RAIL_TABS.some(t => t.key === cur)) setUi({ panel: 'analysis' })
  }, [setUi])

  // 换结构后回到默认呈现（预设/颜色选择器与引擎态保持一致）
  React.useEffect(() => {
    setPreset('cartoon')
    setColorScheme(activeEntry?.reps.some(r => r.colorScheme === 'chain') ? 'chain' : (activeEntry?.reps[0]?.colorScheme as ColorScheme) ?? 'chain')
  }, [structId])

  if (suspended) return null

  if (error) {
    return (
      <div className={cn('flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400', className)}>
        <FileWarning className="size-4 shrink-0" />
        <span>{t({ zh: `结构解析失败：${error}`, en: `Structure parse failed: ${error}` })}</span>
      </div>
    )
  }

  const stats = activeEntry?.summary
  const railTab = RAIL_TABS.find(x => x.key === panel) ?? RAIL_TABS[0]
  const panelKey = railTab.key

  const onPreset = (key: string) => {
    setPreset(key)
    applyPreset(key)
    // 绑定口袋/混合等预设自带配色——同步选择器显示
    const entry = useMolStore.getState().structures.find(x => x.id === useMolStore.getState().activeId)
    const scheme = entry?.reps.find(r => r.visible && (r.colorScheme === 'spectrum' || r.colorScheme === 'pocket' || r.colorScheme === 'bfactor'))?.colorScheme
    if (scheme) setColorScheme(scheme)
  }

  const onColor = (scheme: ColorScheme) => {
    setColorScheme(scheme)
    applyColor(scheme)
  }

  const capture = () => {
    const url = engineRef.current?.capture({ scale: 2 })
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/\s+/g, '_')}_view.png`
    a.click()
    toast.success(t({ zh: '视口截图已保存', en: 'Viewport screenshot saved' }))
  }

  const canvasHeight = inline ? (compact ? 'h-56 sm:h-72' : 'h-64 sm:h-80') : 'min-h-[380px] flex-1'

  return (
    <div className={cn(
      'flex w-full flex-col overflow-hidden rounded-lg border bg-card [contain:inline-size]',
      className,
    )}>
      {/* ── 工具栏 ─────────────────────────────────────────────── */}
      {/* 注：所有子项允许收缩（min-w-0）——窄宿主（320px Inspector）下工具栏横向滚动，
          不把固有宽度传递给上层 display:table 滚动容器导致整块横向溢出 */}
      <div className="mol-toolbar-scroll flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-background/60 px-2">
        <Select value={preset} onValueChange={onPreset}>
          <SelectTrigger className="h-7 w-[112px] min-w-0 shrink text-xs" aria-label={t({ zh: '表示法预设', en: 'Representation preset' })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_KEYS.map(k => (
              <SelectItem key={k} value={k} className="text-xs">{t(PRESETS[k].label)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={colorScheme} onValueChange={onColor}>
          <SelectTrigger className="h-7 w-[104px] min-w-0 shrink text-xs" aria-label={t({ zh: '配色方案', en: 'Color scheme' })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLOR_KEYS.map(k => (
              <SelectItem key={k} value={k} className="text-xs">{t(COLOR_SCHEME_LABELS[k])}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />

        <Button
          size="sm" variant="ghost" type="button"
          className={cn('h-7 w-7 shrink-0 p-0', spin && 'bg-primary/10 text-primary')}
          onClick={() => updateSettings({ spin: !spin, ...(spin ? {} : { rock: false }) })}
          aria-label={t({ zh: '自动旋转 (S)', en: 'Spin (S)' })}
          title={t({ zh: '自动旋转 · S', en: 'Spin · S' })}
        >
          <Atom className={cn('size-3.5', spin && 'animate-spin [animation-duration:3s]')} />
        </Button>
        <Button
          size="sm" variant="ghost" type="button" className="h-7 w-7 shrink-0 p-0"
          onClick={() => engineRef.current?.fitView(undefined, { animate: true })}
          aria-label={t({ zh: '取景适配 (F)', en: 'Fit view (F)' })}
          title={t({ zh: '取景适配 · F', en: 'Fit view · F' })}
        >
          <Maximize className="size-3.5" />
        </Button>
        <Button
          size="sm" variant="ghost" type="button"
          className={cn('h-7 w-7 shrink-0 p-0', showHBonds && 'bg-primary/10 text-primary')}
          onClick={() => updateSettings({ showHBonds: !showHBonds })}
          aria-label={t({ zh: '氢键网络 (B)', en: 'H-bond network (B)' })}
          title={t({ zh: '氢键网络 · B', en: 'H-bonds · B' })}
        >
          <Network className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm" variant="ghost" type="button"
              className={cn('h-7 w-7 shrink-0 p-0', measureMode !== 'off' && 'bg-primary/10 text-primary')}
              aria-label={t({ zh: '测量工具', en: 'Measurement tools' })}
              title={t({ zh: '测量：距离/角度/二面角', en: 'Measure: distance / angle / dihedral' })}
            >
              <Ruler className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[10px]">{t({ zh: '点选原子进行测量', en: 'Pick atoms to measure' })}</DropdownMenuLabel>
            {([
              ['off', { zh: '关闭测量', en: 'Off' }],
              ['distance', { zh: '距离（2 原子，Å）', en: 'Distance (2 atoms, Å)' }],
              ['angle', { zh: '角度（3 原子，°）', en: 'Angle (3 atoms, °)' }],
              ['dihedral', { zh: '二面角（4 原子，°）', en: 'Dihedral (4 atoms, °)' }],
            ] as const).map(([mode, label]) => (
              <DropdownMenuItem
                key={mode}
                onClick={() => useMolStore.getState().setMeasureMode(mode)}
                className={cn('text-xs', measureMode === mode && 'font-semibold text-primary')}
              >
                {t(label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm" variant="ghost" type="button" className="h-7 w-7 shrink-0 p-0"
          onClick={capture}
          aria-label={t({ zh: '视口截图', en: 'Screenshot' })}
          title={t({ zh: '视口截图（2× 分辨率）', en: 'Viewport screenshot (2×)' })}
        >
          <Camera className="size-3.5" />
        </Button>

        {/* 右侧：统计徽章 + 分析栏开关 */}
        <div className="ml-auto flex min-w-0 shrink items-center gap-1 pl-1">
          {busy || sasaComputing ? (
            <Badge variant="secondary" className="h-6 gap-1 text-[10px]">
              <Loader2 className="size-3 animate-spin" />
              {sasaComputing ? t({ zh: 'SASA 计算中', en: 'SASA' }) : t({ zh: '解析中', en: 'Parsing' })}
            </Badge>
          ) : stats ? (
            <>
              <Badge variant="secondary" className="hidden h-6 text-[10px] tabular-nums sm:inline-flex">{stats.atoms.toLocaleString()} {t({ zh: '原子', en: 'atoms' })}</Badge>
              <Badge variant="secondary" className="hidden h-6 text-[10px] tabular-nums sm:inline-flex">{stats.residues.toLocaleString()} {t({ zh: '残基', en: 'res' })}</Badge>
              <Badge variant="secondary" className="hidden h-6 text-[10px] tabular-nums md:inline-flex">{stats.chains} {t({ zh: '链', en: 'chains' })}</Badge>
            </>
          ) : null}
          <Button
            size="sm" variant={railOpen ? 'default' : 'outline'} type="button"
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            onClick={() => setRailOpen(v => !v)}
            aria-expanded={railOpen}
          >
            <FlaskConical className="size-3" />
            <span className="hidden sm:inline">{t({ zh: '分析', en: 'Analysis' })}</span>
            <ChevronDown className={cn('size-3 transition-transform', railOpen && 'rotate-180')} />
          </Button>
        </div>
      </div>

      {/* ── 主体 ───────────────────────────────────────────────── */}
      {busy ? (
        <div className={cn('flex items-center justify-center gap-2 text-xs text-muted-foreground', canvasHeight)}>
          <Loader2 className="size-4 animate-spin" />
          {t({ zh: `正在解析 ${name}…`, en: `Parsing ${name}…` })}
        </div>
      ) : (
        <div className={cn('flex min-h-0 flex-1 flex-col', !inline && 'flex-row')}>
          {/* 3D 视口 */}
          <div className={cn('relative shrink-0', inline ? canvasHeight : 'relative min-h-[380px] flex-1')}>
            <MolViewerMount>
              <ViewportHUD />
              <ColorLegend />
              {poreResult && <PoreProfile />}
            </MolViewerMount>
          </div>

          {/* 侧栏/下栏：五面板 */}
          {railOpen && (
            <div className={cn(
              'flex min-h-0 shrink-0 flex-col border-border bg-background',
              inline ? 'max-h-[420px] border-t' : 'w-[300px] flex-1 border-l xl:w-[340px]',
            )}>
              <div className="mol-toolbar-scroll flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5">
                {RAIL_TABS.map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setUi({ panel: tab.key })}
                    aria-pressed={panel === tab.key}
                    title={t(tab.label)}
                    className={cn(
                      'flex h-6 shrink items-center gap-1 rounded-md px-2 text-[10.5px] font-medium transition-colors',
                      panel === tab.key
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <tab.icon className="size-3 shrink-0" />
                    <span className="truncate">{t(tab.label)}</span>
                  </button>
                ))}
              </div>
              <div className="mol-scroll min-h-0 flex-1 overflow-y-auto">
                {panelKey === 'analysis' && <AnalysisPanel />}
                {panelKey === 'reps' && <RepsPanel />}
                {panelKey === 'colors' && <ColorsPanel />}
                {panelKey === 'measure' && <MeasurePanel />}
                {panelKey === 'selection' && <SelectionPanel />}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 序列条（完整工作室形态） ─────────────────────────────── */}
      {!inline && !busy && structId && <SequenceBar />}
    </div>
  )
}

export default MolStudio
