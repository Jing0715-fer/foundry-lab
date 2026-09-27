'use client'

// 选择面板：表达式输入、快捷选择、当前选择统计、命名选择、标注
import { useState } from 'react'
import { Crosshair, BookmarkPlus, Trash2, Tag, Target, X } from 'lucide-react'
import { toast } from 'sonner'
import { engineRef, dataRegistry, useMolStore } from '@/lib/molecular/store'
import { maskToIndices, evaluateSelection, PRESET_SELECTIONS } from '@/lib/molecular/selection'
import { buildNamedMasks } from '@/lib/molecular/store'
import { useI18n, tt, loc, type DualText } from '@/i18n'
import { SectionTitle, PanelHint } from '../LeftPanel'
import { Input } from '@/components/ui/input'

const QUICK_EXPRS: { expr: string; label: DualText }[] = [
  { expr: 'all', label: { zh: '全部', en: 'All' } },
  { expr: 'protein', label: { zh: '蛋白', en: 'Protein' } },
  { expr: 'nucleic', label: { zh: '核酸', en: 'Nucleic' } },
  { expr: 'ligand', label: { zh: '配体', en: 'Ligand' } },
  { expr: 'water', label: { zh: '水', en: 'Water' } },
  { expr: 'metal', label: { zh: '金属', en: 'Metal' } },
  { expr: 'backbone', label: { zh: '主链', en: 'Backbone' } },
  { expr: 'sidechain', label: { zh: '侧链', en: 'Sidechain' } },
  { expr: 'helix', label: { zh: '螺旋', en: 'Helix' } },
  { expr: 'sheet', label: { zh: '折叠', en: 'Sheet' } },
]

export function SelectionPanel() {
  const { t, locale } = useI18n()
  const [expr, setExpr] = useState('')
  const [name, setName] = useState('')
  const selection = useMolStore(s => s.selection)
  const activeId = useMolStore(s => s.activeId)
  const selectFromExpr = useMolStore(s => s.selectFromExpr)
  const namedSelections = useMolStore(s => s.namedSelections)
  const saveNamedSelection = useMolStore(s => s.saveNamedSelection)
  const deleteNamedSelection = useMolStore(s => s.deleteNamedSelection)
  const invertSelection = useMolStore(s => s.invertSelection)
  const addLabelsForSelection = useMolStore(s => s.addLabelsForSelection)
  const setSelection = useMolStore(s => s.setSelection)

  const data = activeId ? dataRegistry.get(activeId) : null

  const stats = (() => {
    if (!selection.structureId || !selection.indices.length) return null
    const d = dataRegistry.get(selection.structureId)
    if (!d) return null
    const residues = new Set<number>()
    const chains = new Set<string>()
    let het = 0
    for (const i of selection.indices) {
      residues.add(d.atomResidue[i])
      chains.add(d.atoms.chainIds[i])
      if (d.atoms.hetero[i]) het++
    }
    return { atoms: selection.indices.length, residues: residues.size, chains: chains.size, het }
  })()

  const runExpr = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!expr.trim()) return
    const res = selectFromExpr(expr)
    if (res.error) toast.error(`${tt({ zh: '选择错误：', en: 'Selection error: ' })}${res.error}`)
    else toast.success(tt({ zh: `已选择 ${res.count.toLocaleString(loc())} 个原子`, en: `Selected ${res.count.toLocaleString(loc())} atoms` }))
  }

  return (
    <div className="pb-4">
      <SectionTitle>{t({ zh: '表达式选择', en: 'Selection expression' })}</SectionTitle>
      <form onSubmit={runExpr} className="flex gap-1.5 px-2">
        <Input
          value={expr}
          onChange={e => setExpr(e.target.value)}
          placeholder={t({ zh: '如 chain A and resi 40-80', en: 'e.g. chain A and resi 40-80' })}
          className="h-8 flex-1 border-border bg-background font-mono text-[11px]"
        />
        <button
          type="submit"
          className="mol-btn-primary flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Target className="h-3.5 w-3.5" />
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1 px-2">
        {QUICK_EXPRS.map(q => (
          <button
            key={q.expr}
            onClick={() => {
              const res = selectFromExpr(q.expr)
              if (res.error) toast.error(res.error)
            }}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-medium transition hover:border-primary/40 hover:bg-primary/5"
          >
            {t(q.label)}
          </button>
        ))}
      </div>

      {/* 当前选择 */}
      <SectionTitle>{t({ zh: '当前选择', en: 'Current selection' })}</SectionTitle>
      {stats ? (
        <div className="mx-2 rounded-lg border border-primary/60 bg-primary/5 p-3">
          <div className="grid grid-cols-2 gap-y-1.5 text-[11px] tabular-nums">
            <span className="text-muted-foreground">{t({ zh: '原子', en: 'Atoms' })}</span>
            <span className="text-right font-mono font-semibold">{stats.atoms.toLocaleString(locale)}</span>
            <span className="text-muted-foreground">{t({ zh: '残基', en: 'Residues' })}</span>
            <span className="text-right font-mono">{stats.residues.toLocaleString(locale)}</span>
            <span className="text-muted-foreground">{t({ zh: '链', en: 'Chains' })}</span>
            <span className="text-right font-mono">{stats.chains}</span>
            {stats.het > 0 && (
              <>
                <span className="text-muted-foreground">{t({ zh: '杂原子', en: 'Hetero atoms' })}</span>
                <span className="text-right font-mono">{stats.het.toLocaleString(locale)}</span>
              </>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                if (!selection.structureId) return
                engineRef.current?.fitView([{ structureId: selection.structureId, indices: selection.indices }])
              }}
              className="flex h-6.5 items-center gap-1 rounded-md border border-border bg-background px-2 text-[10px] font-medium transition hover:bg-accent"
            >
              <Crosshair className="h-3 w-3" /> {t({ zh: '聚焦', en: 'Focus' })}
            </button>
            <button
              onClick={() => invertSelection()}
              className="flex h-6.5 items-center gap-1 rounded-md border border-border bg-background px-2 text-[10px] font-medium transition hover:bg-accent"
            >
              {t({ zh: '反选', en: 'Invert' })}
            </button>
            <button
              onClick={() => addLabelsForSelection()}
              className="flex h-6.5 items-center gap-1 rounded-md border border-border bg-background px-2 text-[10px] font-medium transition hover:bg-accent"
            >
              <Tag className="h-3 w-3" /> {t({ zh: '标注 (L)', en: 'Label (L)' })}
            </button>
            <button
              onClick={() => setSelection(null, [])}
              className="flex h-6.5 items-center gap-1 rounded-md border border-border bg-background px-2 text-[10px] font-medium transition hover:bg-accent"
            >
              <X className="h-3 w-3" /> {t({ zh: '清除', en: 'Clear' })}
            </button>
          </div>

          {/* 保存命名 */}
          <div className="mt-2.5 flex gap-1.5">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t({ zh: '命名保存…', en: 'Save as…' })}
              className="h-7 flex-1 border-border bg-background text-[11px]"
            />
            <button
              onClick={() => {
                if (!name.trim()) return toast.error(tt({ zh: '请输入名称', en: 'Enter a name' }))
                saveNamedSelection(name.trim())
                toast.success(tt({ zh: `已保存命名选择 "${name.trim()}"`, en: `Saved named selection "${name.trim()}"` }))
                setName('')
              }}
              className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] font-medium transition hover:bg-accent"
            >
              <BookmarkPlus className="h-3 w-3" /> {t({ zh: '保存', en: 'Save' })}
            </button>
          </div>
        </div>
      ) : (
        <p className="px-3 text-[11px] text-muted-foreground">
          {t({ zh: '在 3D 视图中点击残基（Ctrl+点击选单原子，Shift 追加，Alt 移除），或使用上方表达式。', en: 'Click residues in the 3D view (Ctrl+click for single atoms, Shift to add, Alt to remove), or use the expression above.' })}
        </p>
      )}

      {/* 命名选择 */}
      {namedSelections.length > 0 && (
        <>
          <SectionTitle>{t({ zh: '命名选择', en: 'Named selections' })}</SectionTitle>
          <div className="space-y-0.5 px-2">
            {namedSelections.map(ns => (
              <div key={ns.name} className="group flex items-center gap-2 rounded-md border-l-2 border-l-[#9c4a4a]/70 px-2 py-1.5 transition hover:bg-accent">
                <span className="flex-1 truncate font-mono text-[11px] font-medium text-[#c76a6a] dark:text-[#d98a8a]">{ns.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{ns.count.toLocaleString(locale)} at</span>
                <button
                  onClick={() => {
                    if (!data) return
                    if (ns.indices) setSelection(ns.structureId, ns.indices)
                    else if (ns.expr) {
                      const res = evaluateSelection(ns.expr, { structure: data, named: buildNamedMasks(ns.structureId, data) })
                      if (!res.error) setSelection(ns.structureId, maskToIndices(res.mask))
                    }
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-primary transition hover:bg-primary/10"
                >
                  {t({ zh: '选中', en: 'Select' })}
                </button>
                <button
                  onClick={() => deleteNamedSelection(ns.name)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <PanelHint>
        {t({ zh: '语法：', en: 'Syntax:' })} <code className="text-[10px]">chain A</code> · <code className="text-[10px]">resi 1-60</code> · <code className="text-[10px]">resn HEM</code> · <code className="text-[10px]">name CA</code> · <code className="text-[10px]">elem Fe</code> · <code className="text-[10px]">within 5 of (…)</code> · <code className="text-[10px]">byres(…)</code>{t({ zh: '，可用 and / or / not。', en: ' — combine with and / or / not.' })}
      </PanelHint>
    </div>
  )
}
