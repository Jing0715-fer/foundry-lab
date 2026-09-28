'use client'

// 表示法面板：rep 列表卡片（类型/选择/配色/参数）
import { Eye, EyeOff, Plus, SlidersHorizontal, Trash2, Shapes, AlertCircle, Ribbon, Worm, CircleDot, Minus, Circle, Spline, Shell } from 'lucide-react'
import { useMolStore } from '@/lib/molecular/store'
import { COLOR_SCHEME_LABELS, type ColorScheme } from '@/lib/molecular/colors'
import { REP_LABELS, type RepConfig, type RepType } from '@/lib/molecular/types'
import { PRESET_SELECTIONS } from '@/lib/molecular/selection'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { SectionTitle, PanelHint } from '../LeftPanel'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'

const REP_TYPES: RepType[] = ['cartoon', 'putty', 'ballstick', 'sticks', 'spacefill', 'lines', 'surface']
const SCHEMES: ColorScheme[] = ['element', 'pocket', 'chain', 'spectrum', 'residue', 'ss', 'bfactor', 'sasa', 'uniform']

/** 表示法类型 → lucide 图标（中性色：单一强调色纪律，类型识别靠图标形状不靠彩虹色） */
const TYPE_ICON: Record<RepType, { icon: typeof Ribbon; className?: string }> = {
  cartoon: { icon: Ribbon },
  putty: { icon: Worm },
  ballstick: { icon: CircleDot },
  sticks: { icon: Minus },
  spacefill: { icon: Circle },
  lines: { icon: Spline },
  surface: { icon: Shell },
}

function TypeIcon({ type, className }: { type: RepType; className?: string }) {
  const t = TYPE_ICON[type] ?? { icon: Shapes }
  return <t.icon className={cn('h-3.5 w-3.5 shrink-0 text-primary', t.className, className)} />
}

export function RepsPanel() {
  const { t: tr } = useI18n()
  const structures = useMolStore(s => s.structures)
  const activeId = useMolStore(s => s.activeId)
  const addRep = useMolStore(s => s.addRep)
  const updateRep = useMolStore(s => s.updateRep)
  const removeRep = useMolStore(s => s.removeRep)

  const st = structures.find(x => x.id === activeId)
  if (!st) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <Shapes className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">{tr({ zh: '加载结构后在此管理表示法。', en: 'Load a structure to manage its representations here.' })}</p>
      </div>
    )
  }

  return (
    <div className="pb-4">
      <SectionTitle right={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground transition hover:opacity-90">
              <Plus className="h-3 w-3" /> {tr({ zh: '添加', en: 'Add' })}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {REP_TYPES.map(t => (
              <DropdownMenuItem key={t} onClick={() => addRep(st.id, { type: t, selection: 'all' })} className="gap-2 text-xs">
                <TypeIcon type={t} />{tr(REP_LABELS[t])}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }>
        {tr({ zh: `表示法 (${st.reps.length})`, en: `Representations (${st.reps.length})` })}
      </SectionTitle>

      <div className="space-y-2 px-2">
        {st.reps.map(rep => (
          <RepCard key={rep.id} rep={rep} structureId={st.id} onUpdate={updateRep} onRemove={removeRep} />
        ))}
        {st.reps.length === 0 && (
          <p className="rounded-lg border border-dashed border-border/70 p-3 text-center text-[11px] text-muted-foreground">
            {tr({ zh: '没有表示法。点击「添加」或用命令行 ', en: 'No representations yet. Click "Add" or use ' })}<code className="rounded bg-muted px-1">show cartoon</code>{tr({ zh: '。', en: '.' })}
          </p>
        )}
      </div>
      <PanelHint>
        {tr({ zh: '每种表示法可指定独立的原子范围与配色。选择语法：', en: 'Each representation has its own atom scope and coloring. Selection syntax:' })} <code className="text-[10px]">chain A</code>、<code className="text-[10px]">resi 1-60</code>、<code className="text-[10px]">within 5 of (ligand)</code>…
      </PanelHint>
    </div>
  )
}

function RepCard({
  rep, structureId, onUpdate, onRemove,
}: {
  rep: RepConfig
  structureId: string
  onUpdate: (structureId: string, repId: string, patch: Partial<RepConfig>) => void
  onRemove: (structureId: string, repId: string) => void
}) {
  const { t: tr } = useI18n()
  return (
    <div className={cn(
      // `!` 提权：panel-card 为未分层自定义规则，压过 @layer utilities 的状态类
      'panel-card p-2',
      rep.error && 'border-destructive/60! bg-destructive/5!',
      !rep.visible && 'opacity-60 saturate-50',
    )}>
      {/* 行 1：类型 + 参数/可见/删除 */}
      <div className="flex items-center gap-1.5">
        <TypeIcon type={rep.type} className="h-4 w-4 shrink-0" />
        <Select value={rep.type} onValueChange={v => onUpdate(structureId, rep.id, { type: v as RepType })}>
          <SelectTrigger className="h-7 min-w-0 flex-1 border-border bg-background text-[11px] font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REP_TYPES.map(t => (
              <SelectItem key={t} value={t} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <TypeIcon type={t} className="h-3 w-3" />{tr(REP_LABELS[t])}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 参数 */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95" title={tr({ zh: '参数', en: 'Parameters' })}>
              <SlidersHorizontal className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" className="w-56 p-3" align="start">
            <div className="space-y-3">
              {(rep.type === 'spacefill' || rep.type === 'ballstick') && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                    <span>{rep.type === 'spacefill' ? tr({ zh: '原子半径倍率', en: 'Atom radius scale' }) : tr({ zh: '球半径倍率', en: 'Ball radius scale' })}</span>
                    <span className="font-mono">{rep.ballScale.toFixed(2)}×</span>
                  </div>
                  <Slider
                    value={[rep.ballScale]} min={0.1} max={2} step={0.05}
                    aria-label={rep.type === 'spacefill' ? tr({ zh: '原子半径倍率', en: 'Atom radius scale' }) : tr({ zh: '球半径倍率', en: 'Ball radius scale' })}
                    onValueChange={v => onUpdate(structureId, rep.id, { ballScale: v[0] })}
                  />
                </div>
              )}
              {(rep.type === 'ballstick' || rep.type === 'sticks') && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                    <span>{tr({ zh: '棍半径', en: 'Stick radius' })}</span><span className="font-mono">{rep.stickRadius.toFixed(2)} Å</span>
                  </div>
                  <Slider
                    value={[rep.stickRadius]} min={0.05} max={0.35} step={0.01}
                    aria-label={tr({ zh: '棍半径', en: 'Stick radius' })}
                    onValueChange={v => onUpdate(structureId, rep.id, { stickRadius: v[0] })}
                  />
                </div>
              )}
              {(rep.type === 'cartoon' || rep.type === 'putty') && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                    <span>{rep.type === 'putty' ? tr({ zh: '管径整体倍率', en: 'Tube width scale' }) : tr({ zh: '带状宽度', en: 'Ribbon width' })}</span><span className="font-mono">{rep.cartoonWidth.toFixed(2)}×</span>
                  </div>
                  <Slider
                    value={[rep.cartoonWidth]} min={0.3} max={2.5} step={0.05}
                    aria-label={rep.type === 'putty' ? tr({ zh: '管径整体倍率', en: 'Tube width scale' }) : tr({ zh: '带状宽度', en: 'Ribbon width' })}
                    onValueChange={v => onUpdate(structureId, rep.id, { cartoonWidth: v[0] })}
                  />
                </div>
              )}
              {rep.type === 'putty' && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                    <span>{tr({ zh: 'B 因子上限', en: 'B-factor cap' })}</span><span className="font-mono">{rep.puttyRange > 0 ? `${rep.puttyRange.toFixed(0)} Å²` : tr({ zh: '自动', en: 'auto' })}</span>
                  </div>
                  <Slider
                    value={[rep.puttyRange > 0 ? rep.puttyRange : 100]} min={0} max={200} step={5}
                    aria-label={tr({ zh: 'B 因子上限', en: 'B-factor cap' })}
                    onValueChange={v => onUpdate(structureId, rep.id, { puttyRange: v[0] })}
                  />
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/80">{tr({ zh: '0 = 按结构实际 B 范围；调低可抑制高 B 离群值拉伸管径。', en: '0 = use the structure\'s actual B range; lower values keep high-B outliers from stretching the tube.' })}</p>
                </div>
              )}
              {rep.type === 'surface' && (
                <>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                      <span>{tr({ zh: '探针半径', en: 'Probe radius' })}</span><span className="font-mono">{rep.probe.toFixed(1)} Å</span>
                    </div>
                    <Slider
                      value={[rep.probe]} min={0} max={3} step={0.1}
                      aria-label={tr({ zh: '探针半径', en: 'Probe radius' })}
                      onValueChange={v => onUpdate(structureId, rep.id, { probe: v[0] })}
                    />
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                      <span>{tr({ zh: '不透明度', en: 'Opacity' })}</span><span className="font-mono">{Math.round(rep.opacity * 100)}%</span>
                    </div>
                    <Slider
                      value={[rep.opacity]} min={0.15} max={1} step={0.05}
                      aria-label={tr({ zh: '不透明度', en: 'Opacity' })}
                      onValueChange={v => onUpdate(structureId, rep.id, { opacity: v[0] })}
                    />
                  </div>
                </>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-foreground">{tr({ zh: '可见', en: 'Visible' })}</span>
                <Switch checked={rep.visible} onCheckedChange={v => onUpdate(structureId, rep.id, { visible: v })} />
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <button
          onClick={() => onUpdate(structureId, rep.id, { visible: !rep.visible })}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          title={rep.visible ? tr({ zh: '隐藏', en: 'Hide' }) : tr({ zh: '显示', en: 'Show' })}
        >
          {rep.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => onRemove(structureId, rep.id)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
          title={tr({ zh: '删除', en: 'Delete' })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 行 2（自适应折行）：选择表达式 + 预设 + 配色 + 自定义色 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Input
          value={rep.selection}
          onChange={e => onUpdate(structureId, rep.id, { selection: e.target.value })}
          placeholder={tr({ zh: '选择表达式', en: 'Selection expression' })}
          className={cn(
            'h-7 min-w-[96px] flex-1 basis-[96px] grow border-border bg-background font-mono text-[10px]',
            rep.error && 'border-destructive focus-visible:ring-destructive/30',
          )}
        />
        <Select
          value={PRESET_SELECTIONS.some(p => p.value === rep.selection) ? rep.selection : undefined}
          onValueChange={v => onUpdate(structureId, rep.id, { selection: v })}
        >
          <SelectTrigger className="h-7 w-7 shrink-0 border-border bg-background px-1 text-[10px] [&_svg]:hidden" title={tr({ zh: '预设选择', en: 'Preset selections' })}>
            <span className="text-muted-foreground" aria-hidden>≡</span>
            <span className="sr-only">{tr({ zh: '预设选择', en: 'Preset selections' })}</span>
          </SelectTrigger>
          <SelectContent>
            {PRESET_SELECTIONS.map(p => (
              <SelectItem key={p.value} value={p.value} className="font-mono text-[10px]">{tr(p.label)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={rep.colorScheme} onValueChange={v => onUpdate(structureId, rep.id, { colorScheme: v as ColorScheme })}>
          <SelectTrigger className="h-7 w-[92px] shrink-0 border-border bg-background text-[10px]" title={tr({ zh: '配色方案', en: 'Color scheme' })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEMES.map(sc => (
              <SelectItem key={sc} value={sc} className="text-xs">{tr(COLOR_SCHEME_LABELS[sc])}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {rep.colorScheme === 'uniform' && (
          <input
            type="color"
            value={rep.uniformColor}
            onChange={e => onUpdate(structureId, rep.id, { uniformColor: e.target.value })}
            className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-background p-0.5"
            title={tr({ zh: '统一颜色', en: 'Uniform color' })}
          />
        )}
      </div>
      {rep.error && (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" /> {rep.error}
        </p>
      )}
    </div>
  )
}
