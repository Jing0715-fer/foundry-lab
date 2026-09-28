'use client'

// MolVision 引擎挂载容器（foundry-lab 内嵌版）
// ─────────────────────────────────────────────────────────────────────────────
// 自 MolVision MolViewer.tsx 抽出引擎生命周期核心：MolEngine 挂载/销毁、visualRev
// 视觉同步、悬停提示、点选/双击聚焦/测量拾取、Ctrl 橡皮带框选。会话持久化、导览、
// 录制、命令控制台、视角书签等完整工作室设施不内嵌（foundry-lab 结果预览用不到）。
// 快捷键作用域限定在鼠标悬停于视口内——不与 foundry-lab 全局快捷键冲突。
import { useCallback, useEffect, useRef, useState } from 'react'
import { MolEngine, type AtomPick, type HoverInfo } from '@/lib/molecular/engine'
import { dataRegistry, engineRef, useMolStore } from '@/lib/molecular/store'
import { useHoverStore } from '@/lib/molecular/hover-store'
import { flushEngineReady } from '@/lib/molecular/engine-ready'
import { useI18n, tt } from '@/i18n'
import { cn } from '@/lib/utils'

interface HoverState { text: string; x: number; y: number; sub?: string }

export function MolViewerMount({ className, children }: {
  className?: string
  children?: React.ReactNode
}) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const engine = useRef<MolEngine | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const visualRev = useMolStore(s => s.visualRev)
  const measureMode = useMolStore(s => s.measureMode)

  // 原子点击处理：双击聚焦残基 / 测量模式拾取 / 选择（Ctrl=单原子，默认=残基，
  // 配体扩展到整个分子；Shift=追加，Alt=移除）——与 MolVision 同语义
  const handlePick = useCallback((pick: AtomPick | null, empty: boolean) => {
    const store = useMolStore.getState()
    if (empty || !pick) {
      if (store.measureMode !== 'off') return
      if (store.selection.structureId || store.selection.indices.length) {
        store.setSelection(null, [])
      }
      return
    }
    const data = dataRegistry.get(pick.structureId)
    if (!data) return
    if (pick.doubleClick) {
      const r = data.residues[pick.residueIdx]
      const indices: number[] = []
      for (let i = r.start; i < r.end; i++) indices.push(i)
      engine.current?.fitView([{ structureId: pick.structureId, indices }])
      return
    }
    if (store.measureMode !== 'off') {
      store.measurePick(pick.structureId, pick.atomIdx)
      return
    }
    let indices: number[]
    if (pick.ctrlKey) {
      indices = [pick.atomIdx]
    } else {
      const molIdx = data.atomMolecule[pick.atomIdx] ?? -1
      const mol = molIdx >= 0 ? data.molecules[molIdx] : null
      indices = []
      if (mol) {
        for (const ri of mol.residues) {
          const rr = data.residues[ri]
          for (let i = rr.start; i < rr.end; i++) indices.push(i)
        }
      } else {
        const r = data.residues[pick.residueIdx]
        for (let i = r.start; i < r.end; i++) indices.push(i)
      }
    }
    const mode = pick.altKey ? 'remove' : pick.shiftKey ? 'add' : 'replace'
    if (!pick.shiftKey && !pick.altKey) store.setActive(pick.structureId)
    store.setSelection(pick.structureId, indices, mode)
  }, [])

  // 引擎生命周期
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const eng = new MolEngine(el, {
      onHover: (info: HoverInfo | null) => {
        if (!info) { setHover(null); useHoverStore.getState().setText(null); return }
        const data = dataRegistry.get(info.structureId)
        if (!data) { setHover(null); useHoverStore.getState().setText(null); return }
        const a = data.atoms
        const i = info.atomIdx
        const res = data.residues[data.atomResidue[i]]
        const rect = el.getBoundingClientRect()
        const molIdx = data.atomMolecule[i] ?? -1
        const mol = molIdx >= 0 ? data.molecules[molIdx] : null
        const chain = a.chainIds[i].trim() || '?'
        const bTxt = a.bfactors[i] ? ` · B=${a.bfactors[i].toFixed(1)}` : ''
        const hetTxt = a.hetero[i] ? ' · HET' : ''
        setHover({
          text: `${a.names[i]} · ${a.resNames[i]} ${a.resSeqs[i]}${a.iCodes[i] || ''}`,
          sub: tt({
            zh: `链 ${chain} · ${a.elements[i]}${hetTxt}${bTxt}${res.ss === 'H' ? ' · 螺旋' : res.ss === 'E' ? ' · 折叠' : ''}${mol ? ` · 分子 ${mol.label}（${mol.atoms} 原子）` : ''}`,
            en: `Chain ${chain} · ${a.elements[i]}${hetTxt}${bTxt}${res.ss === 'H' ? ' · helix' : res.ss === 'E' ? ' · strand' : ''}${mol ? ` · Molecule ${mol.label} (${mol.atoms} atoms)` : ''}`,
          }),
          // 视口内夹紧（右侧留 170px 防溢出；下侧留 36px）——避免提示卡超出容器
          x: Math.min(info.x - rect.left + 14, Math.max(8, rect.width - 170)),
          y: Math.min(info.y - rect.top + 14, Math.max(8, rect.height - 36)),
        })
        useHoverStore.getState().setText(
          tt({
            zh: `链 ${chain} · ${a.resNames[i]} ${a.resSeqs[i]} · ${a.names[i]} (${a.elements[i]})${bTxt}`,
            en: `Chain ${chain} · ${a.resNames[i]} ${a.resSeqs[i]} · ${a.names[i]} (${a.elements[i]})${bTxt}`,
          })
        )
      },
      onPick: (pick, empty) => handlePick(pick, empty),
      // 橡皮带框选：框内原子（cartoon/surface 记残基）→ 置换/追加/去除选择
      onBoxSelect: (rectSel) => {
        const eng = engineRef.current
        if (!eng) return
        const hits = eng.pickInRect(rectSel.x0, rectSel.y0, rectSel.x1, rectSel.y1)
        if (!hits.length) {
          if (!rectSel.additive && !rectSel.subtractive) useMolStore.getState().setSelection(null, [])
          return
        }
        const store = useMolStore.getState()
        const sid = hits[0].structureId
        const data = dataRegistry.get(sid)
        if (!data) return
        const resSet = new Set<number>()
        for (const h of hits) {
          if (h.structureId !== sid) continue
          const molIdx = data.atomMolecule[h.atomIdx] ?? -1
          if (molIdx >= 0) {
            for (const ri of data.molecules[molIdx].residues) resSet.add(ri)
          } else {
            resSet.add(data.atomResidue[h.atomIdx])
          }
        }
        const indices: number[] = []
        for (const ri of resSet) {
          const r = data.residues[ri]
          for (let i = r.start; i < r.end; i++) indices.push(i)
        }
        if (rectSel.subtractive) {
          store.setSelection(sid, indices, 'remove')
        } else {
          if (!rectSel.additive) store.setActive(sid)
          store.setSelection(sid, indices, rectSel.additive ? 'add' : 'replace')
        }
      },
    })
    engineRef.current = eng
    engine.current = eng
    eng.sync(useMolStore.getState())
    // 结构先于引擎就位时，冲刷排队的取景/相机操作
    flushEngineReady()
    return () => {
      eng.dispose()
      if (engineRef.current === eng) engineRef.current = null
      engine.current = null
      useHoverStore.getState().setText(null)
    }
  }, [handlePick])

  // 视觉同步
  useEffect(() => {
    engine.current?.sync(useMolStore.getState())
  }, [visualRev])

  // 悬停域内快捷键（f=取景 s=旋转 r=摇摆 b=氢键 h=藏氢 w=藏水 l=标签 Esc=退出测量）
  const inViewport = useRef(false)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (!inViewport.current) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const store = useMolStore.getState()
      switch (e.key) {
        case 'f': case 'F': engine.current?.fitView(); break
        case 's': case 'S':
          store.updateSettings({ spin: !store.settings.spin, ...(store.settings.spin ? {} : { rock: false }) })
          break
        case 'r': case 'R':
          store.updateSettings({ rock: !store.settings.rock, ...(store.settings.rock ? {} : { spin: false }) })
          break
        case 'b': case 'B':
          store.updateSettings({ showHBonds: !store.settings.showHBonds })
          break
        case 'h': case 'H':
          store.updateSettings({ hideHydrogens: !store.settings.hideHydrogens })
          break
        case 'w': case 'W':
          store.updateSettings({ hideWater: !store.settings.hideWater })
          break
        case 'l': case 'L':
          store.addLabelsForSelection()
          break
        case 'Escape':
          if (store.measureMode !== 'off') { store.setMeasureMode('off'); store.clearMeasurePicks() }
          else if (store.selection.indices.length) store.setSelection(null, [])
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const onEnter = useCallback(() => { inViewport.current = true }, [])
  const onLeave = useCallback(() => { inViewport.current = false }, [])

  return (
    <div
      ref={containerRef}
      className={cn('relative h-full w-full overflow-hidden', className)}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      role="application"
      aria-label={t({ zh: '3D 分子视图（拖动旋转 · 滚轮缩放 · 点击选择 · 双击聚焦）', en: '3D molecular viewport (drag to rotate · wheel to zoom · click to select · double-click to focus)' })}
    >
      {children}
      {/* 悬停提示 */}
      {hover && (
        <div
          className="pointer-events-none absolute z-30 max-w-64 rounded-md border border-border/60 bg-popover/95 px-2 py-1 text-[10.5px] leading-tight shadow-sm backdrop-blur-sm"
          style={{ left: hover.x, top: hover.y }}
        >
          <span className="font-mono font-semibold text-foreground">{hover.text}</span>
          {hover.sub && <span className="block text-muted-foreground">{hover.sub}</span>}
        </div>
      )}
      {/* 测量模式指针提示 */}
      {measureMode !== 'off' && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[10.5px] font-medium text-primary backdrop-blur-sm">
          {measureMode === 'distance' ? t({ zh: '距离测量：依次点击 2 个原子 · Esc 退出', en: 'Distance: pick 2 atoms · Esc to exit' })
            : measureMode === 'angle' ? t({ zh: '角度测量：依次点击 3 个原子 · Esc 退出', en: 'Angle: pick 3 atoms · Esc to exit' })
              : t({ zh: '二面角测量：依次点击 4 个原子 · Esc 退出', en: 'Dihedral: pick 4 atoms · Esc to exit' })}
        </div>
      )}
    </div>
  )
}
