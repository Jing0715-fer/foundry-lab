// Zustand 全局状态：结构、表示法、选择、测量、标签、设置、UI
import { create } from 'zustand'
import { tt, useI18nStore, type DualText } from '@/i18n'
import { chainColor, computeAtomColors, parseCssColor, type ColorScheme } from './colors'
import { parseStructure, type StructureData } from './parser'
import { evaluateSelection, maskToIndices } from './selection'
import { textRegistry } from './text-registry'
import { computeDSSP } from './dssp'
import {
  defaultRep, defaultSettings, type AtomLabel, type ChainSummary, type LigandSummary,
  type MeasureMode, type Measurement, type NamedSelection, type RepConfig, type RepType,
  type SelectionState, type Settings, type StructureEntry,
} from './types'

/** 重型结构数据（typed arrays）放在非响应式注册表中 */
export const dataRegistry = new Map<string, StructureData>()
// QA 诊断钩子：浏览器控制台经 window.__molData 探查结构数据（与 __molEngine 同模式）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__molData = dataRegistry
}

/** 引擎引用（非响应式） */
export const engineRef: { current: import('./engine').MolEngine | null } = { current: null }

let uid = 0
const nextId = () => `s${Date.now().toString(36)}${(uid++).toString(36)}`
/** 控制台日志单调序号（滚动窗口外的绝对定位靠它——见 appendLog 注释） */
let logSeq = 0

export interface MolState {
  structures: StructureEntry[]
  activeId: string | null
  selection: SelectionState
  /** 氢键范围烘焙（hbonds in <表达式> 命令）：不随 deselect 清除——
   *  口袋工作流可以「指定范围氢键 + 取消 UI 选中态」并存，端点球也以此范围显示 */
  hbondScope: { structureId: string; indices: number[]; rev: number } | null
  namedSelections: NamedSelection[]
  measureMode: MeasureMode
  measurePicks: { structureId: string; atoms: number[] } | null
  measurements: Measurement[]
  labels: AtomLabel[]
  settings: Settings
  /** 视觉同步版本号 */
  visualRev: number
  loading: boolean
  loadingMsg: string
  ui: {
    panel: 'structures' | 'reps' | 'colors' | 'selection' | 'measure' | 'analysis' | 'maps' | 'scene' | 'info'
    panelOpen: boolean
    sequenceOpen: boolean
    consoleOpen: boolean
    helpOpen: boolean
    loadOpen: boolean
    /** 命令历史面板（搜索/置顶/执行） */
    historyOpen: boolean
    /** Ctrl+K 命令面板（命令/历史/置顶统一快速入口） */
    paletteOpen: boolean
    /** AI 助手面板（自然语言 → 命令） */
    agentOpen: boolean
    /** 论文图复现模板库（r71：CNS 图式一键应用） */
    templateOpen: boolean
  }
  consoleLog: { type: 'in' | 'out' | 'err'; text: string; time: string; seq?: number }[]
  /** 本次页面生命周期内是否加载过结构（防止恢复失败后被空自动保存抹掉存档） */
  everHadStructures: boolean

  // ---------- actions ----------
  addStructure: (data: StructureData, name: string, loadMs: number) => string
  removeStructure: (id: string) => void
  setStructureVisible: (id: string, visible: boolean) => void
  /** 链组级隔离：设置被隐藏的链组索引（null/[] = 全部可见）；bump entry.rev 触发 rep 重建 */
  setChainHidden: (structureId: string, hiddenGroups: number[] | null) => void
  /** 切换单个链组可见性（面板眼睛开关）；返回切换后的隐藏列表 */
  toggleChainHidden: (structureId: string, groupIdx: number) => number[] | null
  setActive: (id: string) => void
  addRep: (structureId: string, rep: Partial<RepConfig> & { type: RepType }) => void
  updateRep: (structureId: string, repId: string, patch: Partial<RepConfig>) => void
  removeRep: (structureId: string, repId: string) => void
  applyPreset: (preset: string) => void
  applyColor: (target: ColorScheme | string) => void
  resetColors: (scope: 'selection' | 'structure') => void
  setSelection: (structureId: string | null, indices: number[], mode?: 'replace' | 'add' | 'remove') => void
  selectFromExpr: (expr: string) => { count: number; error?: string }
  invertSelection: () => void
  /** 氢键范围烘焙设置（hbonds in <表达式>）；null 清除 */
  setHBondScope: (scope: { structureId: string; indices: number[] } | null) => void
  /** 保存命名选择；默认取当前选择，也可传入 indices 快照（序列条拖框选保存） */
  saveNamedSelection: (name: string, indices?: number[], structureId?: string) => void
  deleteNamedSelection: (name: string) => void
  setMeasureMode: (mode: MeasureMode) => void
  measurePick: (structureId: string, atomIdx: number) => void
  clearMeasurePicks: () => void
  removeMeasurement: (id: string) => void
  clearMeasurements: () => void
  addLabelsForSelection: () => void
  removeLabel: (id: string) => void
  clearLabels: (structureId?: string) => void
  updateSettings: (patch: Partial<Settings>) => void
  /** 用 DSSP 重算指定结构的二级结构（无记录结构或强制重算） */
  recomputeSS: (structureId: string) => { helix: number; strand: number; loop: number; error?: string }
  setUi: (patch: Partial<MolState['ui']>) => void
  appendLog: (type: 'in' | 'out' | 'err', text: string) => void
  bumpVisual: () => void
}

function summarize(data: StructureData): { entry: Omit<StructureEntry, 'id' | 'reps' | 'colorOverrides' | 'rev' | 'visible'>; chains: ChainSummary[]; ligands: LigandSummary[] } {
  const chains: ChainSummary[] = data.chains.map((c, i) => ({
    id: c.id,
    type: c.type,
    residues: c.residueIdx.length,
    atoms: c.end - c.start,
    color: chainColor(i).getStyle(),
  }))
  const ligMap = new Map<string, { count: number; chains: Set<string> }>()
  let hydrogens = 0, waters = 0
  for (let i = 0; i < data.atoms.count; i++) {
    const e = data.atoms.elements[i]
    if (e === 'H' || e === 'D') hydrogens++
  }
  for (const r of data.residues) {
    if (r.water) waters++
    else if (r.hetero && !r.polymer) {
      const k = r.resName.toUpperCase()
      const rec = ligMap.get(k) ?? { count: 0, chains: new Set<string>() }
      rec.count++
      rec.chains.add(r.chainId)
      ligMap.set(k, rec)
    }
  }
  const ligands: LigandSummary[] = [...ligMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([resName, v]) => ({ resName, count: v.count, chainIds: [...v.chains].join(',') }))
  return {
    entry: {
      name: data.name,
      format: data.format,
      summary: {
        atoms: data.atoms.count,
        residues: data.residues.length,
        chains: data.chains.length,
        bonds: data.bonds.count,
        hydrogens,
        waters,
        ligandResidues: ligands.reduce((s, l) => s + l.count, 0),
        ligandMolecules: data.molecules.length,
      },
      chains,
      ligands,
      meta: data.meta,
      hasSS: data.ssFromRecords,
      loadMs: 0,
    },
    chains,
    ligands,
  }
}

function defaultRepsFor(data: StructureData): RepConfig[] {
  const hasPolymer = data.chains.some(c => c.type === 'protein' || c.type === 'nucleic')
  if (hasPolymer) {
    return [
      { ...defaultRep('cartoon', 'polymer', 'chain') },
      { ...defaultRep('ballstick', 'ligand', 'element') },
      { ...defaultRep('lines', 'water', 'element') },
    ]
  }
  return [{ ...defaultRep('ballstick', 'all', 'element') }]
}

/** 口袋类预设（bindingsite/publication）的自动聚焦：相机缓动到「配体 + 4.5Å 口袋残基」特写。
 *  远距多拷贝配体（四聚体 4×HEM 均布）时挑离当前相机目标最近的单个实例——全部入框会拉回全景；
 *  无配体结构（纯蛋白/核酸）退化为普通预设，不动相机。
 *  引擎未挂载（欢迎页命令链窗口）时跳过——agent 口袋流程总有 view from/zoom 收尾接管相机。 */
function focusPocketAfterPreset(structureId: string) {
  const eng = engineRef.current
  if (!eng) return
  const data = dataRegistry.get(structureId)
  if (!data) return
  const named = buildNamedMasks(structureId, data)
  const lig = evaluateSelection('ligand', { structure: data, named })
  if (lig.error || !lig.mask) return
  const ligIdx = maskToIndices(lig.mask)
  if (!ligIdx.length) return
  // 配体按残基分实例（每个 HEM/配体分子一个残基）
  const byRes = new Map<number, number[]>()
  for (const i of ligIdx) {
    const ri = data.atomResidue[i]
    const arr = byRes.get(ri)
    if (arr) arr.push(i)
    else byRes.set(ri, [i])
  }
  const insts = [...byRes.values()]
  const pos = data.atoms.positions
  // 实例质心两两距离：远距拷贝（>25Å，如四聚体 4×HEM）→ 只取离相机目标最近的实例
  let chosen = insts
  if (insts.length > 1) {
    const cents = insts.map(idx => {
      let cx = 0, cy = 0, cz = 0
      for (const i of idx) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2] }
      return [cx / idx.length, cy / idx.length, cz / idx.length] as const
    })
    let spread = 0
    for (let a = 0; a < cents.length; a++) for (let b = a + 1; b < cents.length; b++) {
      spread = Math.max(spread, Math.hypot(cents[a][0] - cents[b][0], cents[a][1] - cents[b][1], cents[a][2] - cents[b][2]))
    }
    if (spread > 25) {
      const t = eng.getCameraState().target
      let best = 0, bestD = Infinity
      cents.forEach((c, k) => {
        const d = Math.hypot(c[0] - t[0], c[1] - t[1], c[2] - t[2])
        if (d < bestD) { bestD = d; best = k }
      })
      chosen = [insts[best]]
    }
  }
  // 口袋集群 = 配体实例原子 ∪ 4.5Å 球内邻域原子（口袋残基完整入画）
  const seen = new Set<number>()
  const pocket: number[] = []
  const radius2 = 4.5 * 4.5
  for (const inst of chosen) {
    for (const i of inst) {
      if (seen.has(i)) continue
      seen.add(i); pocket.push(i)
      for (const j of data.grid.queryRadius(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 4.5, pos)) {
        if (seen.has(j)) continue
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
        if (dx * dx + dy * dy + dz * dz <= radius2) { seen.add(j); pocket.push(j) }
      }
    }
  }
  if (pocket.length < 4) return
  eng.fitView([{ structureId, indices: pocket }], { buffer: 2.5 })
}

export const PRESETS: Record<string, { label: DualText; reps: () => RepConfig[] }> = {
  cartoon: {
    label: { zh: 'Cartoon 经典', en: 'Classic cartoon' },
    reps: () => [
      { ...defaultRep('cartoon', 'polymer', 'chain') },
      { ...defaultRep('ballstick', 'ligand', 'element') },
      { ...defaultRep('lines', 'water', 'element') },
    ],
  },
  ballstick: {
    label: { zh: '球棍模型', en: 'Ball-and-stick' },
    reps: () => [{ ...defaultRep('ballstick', 'all', 'element') }],
  },
  spacefill: {
    label: { zh: '空间填充', en: 'Space fill' },
    reps: () => [{ ...defaultRep('spacefill', 'all', 'element') }],
  },
  wireframe: {
    label: { zh: '线框', en: 'Wireframe' },
    reps: () => [{ ...defaultRep('lines', 'all', 'element') }],
  },
  surface: {
    label: { zh: '分子表面', en: 'Molecular surface' },
    // 表面只算聚合物：配体以球棍独立显示（否则被表面完全包埋，口袋不可见）
    reps: () => [
      { ...defaultRep('surface', 'polymer', 'chain') },
      { ...defaultRep('ballstick', 'ligand', 'element') },
    ],
  },
  bindingsite: {
    label: { zh: '结合口袋', en: 'Binding site' },
    reps: () => [
      { ...defaultRep('cartoon', 'polymer', 'chain') },
      // byres：口袋残基展开为完整残基（主链+侧链）——只有 within 球内的部分原子会令侧链残缺
      { ...defaultRep('ballstick', 'byres(within 4.5 of (ligand))', 'element') },
      // 口袋晶体水：仅显示配体 6Å 邻域内的水（小球 0.33Å，ChimeraX nonbonded 风格）——
      // 不带范围的全水 rep 会把整个晶格的溶剂都画出来（四聚体全貌时噪声极大）
      { ...defaultRep('ballstick', 'water and within 6 of (ligand)', 'element'), ballScale: 1.5 },
    ],
  },
  publication: {
    label: { zh: '出版级互作', en: 'Publication interactions' },
    reps: () => [
      { ...defaultRep('cartoon', 'polymer', 'chain') },
      // pocket 方案：配体碳鲜绿 + 口袋残基碳按到配体距离紫→粉渐变（杂原子元素色）；
      // 残基按 byres 展开为完整残基（主链+侧链一起显示）——出版互作图不裁切残基
      { ...defaultRep('ballstick', 'byres(within 4.5 of (ligand)) and not water', 'pocket') },
      { ...defaultRep('ballstick', 'water and within 6 of (ligand)', 'element'), ballScale: 1.5 },
    ],
  },
  hybrid: {
    label: { zh: '混合风格', en: 'Hybrid style' },
    // SS 着色卡通 + 全结构化学键线（骨架抽象与化学细节同屏）+ 配体球棍
    reps: () => [
      { ...defaultRep('cartoon', 'polymer', 'ss') },
      { ...defaultRep('lines', 'polymer', 'element') },
      { ...defaultRep('ballstick', 'ligand', 'element') },
    ],
  },
  putty: {
    label: { zh: 'Putty B 因子管', en: 'Putty B-factor tube' },
    reps: () => [
      { ...defaultRep('putty', 'polymer', 'bfactor') },
      { ...defaultRep('ballstick', 'ligand', 'element') },
      { ...defaultRep('lines', 'water', 'element') },
    ],
  },
}

/** 引导日志文案：模块初始化早于 I18nProvider 首次 setLocale（en 用户首算会得 zh），
 *  故订阅 locale 变化重写首条引导日志（time='' 且无 seq 的那条，滚动窗口内有效） */
const BOOT_LOG: DualText = {
  zh: 'MolVision 命令行就绪。输入 help 查看命令列表。',
  en: 'MolVision command line ready. Type help to see the command list.',
}

export const useMolStore = create<MolState>()((set, get) => ({
  structures: [],
  activeId: null,
  selection: { structureId: null, indices: [], rev: 0 },
  hbondScope: null,
  namedSelections: [],
  measureMode: 'off',
  measurePicks: null,
  measurements: [],
  labels: [],
  settings: defaultSettings(),
  visualRev: 0,
  loading: false,
  loadingMsg: '',
  ui: {
    panel: 'structures',
    panelOpen: true,
    sequenceOpen: true,
    consoleOpen: false,
    helpOpen: false,
    loadOpen: false,
    historyOpen: false,
    paletteOpen: false,
    agentOpen: false,
    templateOpen: false,
  },
  consoleLog: [{ type: 'out', text: tt(BOOT_LOG), time: '' }],
  everHadStructures: false,

  addStructure: (data, name, loadMs) => {
    const id = nextId()
    data.id = id
    data.name = name
    dataRegistry.set(id, data)
    const { entry } = summarize(data)
    const newEntry: StructureEntry = {
      id,
      name,
      format: entry.format,
      visible: true,
      rev: 1,
      reps: defaultRepsFor(data),
      colorOverrides: {},
      summary: entry.summary,
      chains: entry.chains,
      ligands: entry.ligands,
      meta: entry.meta,
      hasSS: entry.hasSS,
      loadMs,
    }
    set(s => ({
      structures: [...s.structures, newEntry],
      activeId: id,
      everHadStructures: true,
      visualRev: s.visualRev + 1,
      selection: { structureId: null, indices: [], rev: s.selection.rev + 1 },
      hbondScope: null,
    }))
    return id
  },

  removeStructure: (id) => {
    dataRegistry.delete(id)
    textRegistry.delete(id)
    set(s => {
      const structures = s.structures.filter(x => x.id !== id)
      const activeId = s.activeId === id ? (structures[0]?.id ?? null) : s.activeId
      return {
        structures,
        activeId,
        labels: s.labels.filter(l => l.structureId !== id),
        measurements: s.measurements.filter(m => m.structureId !== id),
        namedSelections: s.namedSelections.filter(n => n.structureId !== id),
        selection: s.selection.structureId === id
          ? { structureId: null, indices: [], rev: s.selection.rev + 1 }
          : s.selection,
        hbondScope: s.hbondScope?.structureId === id ? null : s.hbondScope,
        visualRev: s.visualRev + 1,
      }
    })
  },

  setStructureVisible: (id, visible) => {
    set(s => ({
      structures: s.structures.map(x => x.id === id ? { ...x, visible } : x),
      visualRev: s.visualRev + 1,
    }))
  },

  setChainHidden: (id, hiddenGroups) => {
    const hidden = hiddenGroups && hiddenGroups.length ? [...new Set(hiddenGroups)].sort((a, b) => a - b) : null
    set(s => ({
      structures: s.structures.map(x => x.id === id ? { ...x, hiddenChains: hidden ?? undefined, rev: x.rev + 1 } : x),
      visualRev: s.visualRev + 1,
    }))
  },

  toggleChainHidden: (id, groupIdx) => {
    const s = get()
    const entry = s.structures.find(x => x.id === id)
    if (!entry) return null
    const cur = entry.hiddenChains ?? []
    const hidden = cur.includes(groupIdx) ? cur.filter(g => g !== groupIdx) : [...cur, groupIdx]
    get().setChainHidden(id, hidden)
    return hidden.length ? hidden : null
  },

  // r63-fix-c #3：活动结构切换时 bump visualRev——引擎视觉中随 activeId 的部分（晶胞盒 show cell）
  // 需要重新 sync 才会跟随（MolViewer 的 sync effect 仅依赖 visualRev）；同 id 重复调用不 bump
  setActive: (id) => set(s => s.activeId === id ? {} : { activeId: id, visualRev: s.visualRev + 1 }),

  addRep: (structureId, rep) => {
    set(s => ({
      structures: s.structures.map(x => x.id === structureId
        ? { ...x, reps: [...x.reps, { ...defaultRep(rep.type), colorScheme: 'element', ...rep, id: Math.random().toString(36).slice(2, 10) }], rev: x.rev + 1 }
        : x),
      visualRev: s.visualRev + 1,
    }))
  },

  updateRep: (structureId, repId, patch) => {
    set(s => ({
      structures: s.structures.map(x => x.id === structureId
        ? { ...x, reps: x.reps.map(r => r.id === repId ? { ...r, ...patch } : r), rev: x.rev + 1 }
        : x),
      visualRev: s.visualRev + 1,
    }))
  },

  removeRep: (structureId, repId) => {
    set(s => ({
      structures: s.structures.map(x => x.id === structureId
        ? { ...x, reps: x.reps.filter(r => r.id !== repId), rev: x.rev + 1 }
        : x),
      visualRev: s.visualRev + 1,
    }))
  },

  applyPreset: (preset) => {
    const s = get()
    const entry = s.structures.find(x => x.id === s.activeId)
    if (!entry) return
    const p = PRESETS[preset]
    if (!p) return
    set({
      structures: s.structures.map(x => x.id === entry.id ? { ...x, reps: p.reps(), colorOverrides: {}, rev: x.rev + 1 } : x),
      visualRev: s.visualRev + 1,
    })
    // 预设同时清理颜色覆盖（colorOverrides 会盖住所有 rep 的配色方案——
    // 之前 color 命令烘焙的逐原子色若不清理，preset 后卡通带仍被旧色污染）
    // 口袋类预设自动聚焦：全景视角下口袋球棍集群几乎不可见——「结合口袋/出版互作」
    // 的预期就是看到口袋特写（快速风格按钮与 preset 命令共用此路径）
    if (preset === 'bindingsite' || preset === 'publication') focusPocketAfterPreset(entry.id)
  },

  applyColor: (target) => {
    const s = get()
    const entry = s.structures.find(x => x.id === s.activeId)
    if (!entry) return
    const data = dataRegistry.get(entry.id)
    if (!data) return
    const scope = s.selection.structureId === entry.id && s.selection.indices.length
      ? new Set(s.selection.indices)
      : null // null = 全结构
    // 目标可能是 scheme 名或 css 颜色
    const schemes: ColorScheme[] = ['element', 'chain', 'spectrum', 'residue', 'ss', 'bfactor', 'sasa', 'uniform', 'pocket']
    const isScheme = schemes.includes(target as ColorScheme)
    let colors: Float32Array
    if (isScheme) {
      // SASA 需先有逐原子数据：小结构同步补算后直接烘焙；大结构触发 worker，完成后自动补烘焙
      if (target === 'sasa' && !data.sasa) {
        const r = engineRef.current?.requestSasa(entry.id)
        if (!r?.done || !data.sasa) {
          engineRef.current?.queueSasaBake(entry.id)
          return
        }
      }
      colors = computeAtomColors(data, target as ColorScheme, { uniformColor: '#c9cdd4' })
    } else {
      const hex = parseCssColor(String(target))
      if (!hex) return
      colors = computeAtomColors(data, 'uniform', { uniformColor: hex })
    }
    const overrides: Record<number, string> = { ...entry.colorOverrides }
    const c = [0, 0, 0]
    const apply = (i: number) => {
      c[0] = Math.round(colors[i * 3] * 255)
      c[1] = Math.round(colors[i * 3 + 1] * 255)
      c[2] = Math.round(colors[i * 3 + 2] * 255)
      // sRGB hex（颜色数组为线性，需转回 sRGB 近似：用 gamma）
      const lin = (v: number) => {
        const x = Math.min(1, Math.max(0, v))
        return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
      }
      const r = Math.round(lin(c[0] / 255) * 255)
      const g = Math.round(lin(c[1] / 255) * 255)
      const b = Math.round(lin(c[2] / 255) * 255)
      overrides[i] = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    }
    if (scope) scope.forEach(apply)
    else for (let i = 0; i < data.atoms.count; i++) apply(i)
    set({
      structures: s.structures.map(x => x.id === entry.id ? { ...x, colorOverrides: overrides, rev: x.rev + 1 } : x),
      visualRev: s.visualRev + 1,
    })
  },

  resetColors: (scope) => {
    const s = get()
    const entry = s.structures.find(x => x.id === s.activeId)
    if (!entry) return
    let overrides = entry.colorOverrides
    if (scope === 'structure') {
      overrides = {}
    } else if (s.selection.structureId === entry.id && s.selection.indices.length) {
      const sel = new Set(s.selection.indices)
      overrides = Object.fromEntries(Object.entries(entry.colorOverrides).filter(([k]) => !sel.has(Number(k))))
    }
    set({
      structures: s.structures.map(x => x.id === entry.id ? { ...x, colorOverrides: overrides, rev: x.rev + 1 } : x),
      visualRev: s.visualRev + 1,
    })
  },

  setSelection: (structureId, indices, mode = 'replace') => {
    set(s => {
      let next: number[]
      if (mode === 'replace' || s.selection.structureId !== structureId) {
        next = [...new Set(indices)].sort((a, b) => a - b)
      } else if (mode === 'add') {
        next = [...new Set([...s.selection.indices, ...indices])].sort((a, b) => a - b)
      } else {
        const rm = new Set(indices)
        next = s.selection.indices.filter(i => !rm.has(i))
      }
      return {
        selection: { structureId: structureId && next.length ? structureId : (structureId ?? null), indices: next, rev: s.selection.rev + 1 },
        visualRev: s.visualRev + 1,
      }
    })
  },

  selectFromExpr: (expr) => {
    const s = get()
    const entry = s.structures.find(x => x.id === s.activeId)
    if (!entry) return { count: 0, error: tt({ zh: '没有加载结构', en: 'No structure loaded' }) }
    const data = dataRegistry.get(entry.id)
    if (!data) return { count: 0, error: tt({ zh: '结构数据缺失', en: 'Structure data missing' }) }
    const named = buildNamedMasks(entry.id, data)
    const res = evaluateSelection(expr, { structure: data, named })
    if (res.error) return { count: 0, error: res.error }
    get().setSelection(entry.id, maskToIndices(res.mask))
    return { count: res.count }
  },

  invertSelection: () => {
    const s = get()
    if (!s.selection.structureId) return
    const data = dataRegistry.get(s.selection.structureId)
    if (!data) return
    const cur = new Set(s.selection.indices)
    const inv: number[] = []
    for (let i = 0; i < data.atoms.count; i++) if (!cur.has(i)) inv.push(i)
    set(s => ({ selection: { structureId: s.selection.structureId, indices: inv, rev: s.selection.rev + 1 }, visualRev: s.visualRev + 1 }))
  },

  setHBondScope: (scope) => {
    set(s => ({ hbondScope: scope ? { ...scope, rev: (s.hbondScope?.rev ?? 0) + 1 } : (s.hbondScope ? { structureId: '', indices: [], rev: s.hbondScope.rev + 1 } : null) }))
  },

  saveNamedSelection: (name, indices, structureId) => {
    const s = get()
    const idx = indices ?? (s.selection.structureId ? s.selection.indices : [])
    const sid = structureId ?? s.selection.structureId
    if (!sid || !idx.length) return
    set({
      namedSelections: [...s.namedSelections.filter(n => n.name !== name), {
        name,
        structureId: sid,
        expr: null,
        indices: idx,
        count: idx.length,
      }],
    })
  },

  deleteNamedSelection: (name) => {
    set(s => ({ namedSelections: s.namedSelections.filter(n => n.name !== name) }))
  },

  setMeasureMode: (mode) => set(s => ({ measureMode: mode, measurePicks: null, visualRev: s.visualRev + 1 })),

  measurePick: (structureId, atomIdx) => {
    const s = get()
    const mode = s.measureMode
    if (mode === 'off') return
    const data = dataRegistry.get(structureId)
    if (!data) return
    let picks = s.measurePicks
    if (!picks || picks.structureId !== structureId) picks = { structureId, atoms: [] }
    const atoms = [...picks.atoms, atomIdx]
    const need = mode === 'distance' ? 2 : mode === 'angle' ? 3 : 4
    if (atoms.length < need) {
      set(s => ({ measurePicks: { structureId, atoms }, visualRev: s.visualRev + 1 }))
      return
    }
    const sel = atoms.slice(0, need)
    const pos = (i: number) => [
      data.atoms.positions[i * 3], data.atoms.positions[i * 3 + 1], data.atoms.positions[i * 3 + 2],
    ]
    let value = 0
    if (mode === 'distance') {
      const a = pos(sel[0]), b = pos(sel[1])
      value = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
    } else if (mode === 'angle') {
      const a = pos(sel[0]), b = pos(sel[1]), c = pos(sel[2])
      const v1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
      const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
      const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
      const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2)
      value = Math.acos(Math.max(-1, Math.min(1, dot / (n1 * n2)))) * 180 / Math.PI
    } else {
      // 二面角
      const p = sel.map(i => pos(i))
      const b1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]]
      const b2 = [p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]]
      const b3 = [p[3][0] - p[2][0], p[3][1] - p[2][1], p[3][2] - p[2][2]]
      const n1 = [b1[1] * b2[2] - b1[2] * b2[1], b1[2] * b2[0] - b1[0] * b2[2], b1[0] * b2[1] - b1[1] * b2[0]]
      const n2 = [b2[1] * b3[2] - b2[2] * b3[1], b2[2] * b3[0] - b2[0] * b3[2], b2[0] * b3[1] - b2[1] * b3[0]]
      const m = [b2[1] * n1[2] - b2[2] * n1[1], b2[2] * n1[0] - b2[0] * n1[2], b2[0] * n1[1] - b2[1] * n1[0]]
      const x = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]
      const y = m[0] * n2[0] + m[1] * n2[1] + m[2] * n2[2]
      value = Math.atan2(y, x) * 180 / Math.PI
    }
    set(s => ({
      measurements: [...s.measurements, {
        id: Math.random().toString(36).slice(2, 10),
        structureId,
        type: mode,
        atoms: sel,
        value,
      }],
      measurePicks: null,
      visualRev: s.visualRev + 1,
    }))
  },

  clearMeasurePicks: () => set(s => ({ measurePicks: null, visualRev: s.visualRev + 1 })),

  removeMeasurement: (id) => {
    set(s => ({ measurements: s.measurements.filter(m => m.id !== id), visualRev: s.visualRev + 1 }))
  },

  clearMeasurements: () => set(s => ({ measurements: [], measurePicks: null, visualRev: s.visualRev + 1 })),

  addLabelsForSelection: () => {
    const s = get()
    if (!s.selection.structureId || !s.selection.indices.length) return
    const structureId = s.selection.structureId
    const data = dataRegistry.get(structureId)
    if (!data) return
    const exists = new Set(s.labels.filter(l => l.structureId === structureId).map(l => l.atomIdx))
    const newLabels: AtomLabel[] = []
    for (const i of s.selection.indices) {
      if (exists.has(i)) continue
      newLabels.push({
        id: Math.random().toString(36).slice(2, 10),
        structureId,
        atomIdx: i,
        text: labelForAtom(data, i),
      })
    }
    set(s => ({ labels: [...s.labels, ...newLabels], visualRev: s.visualRev + 1 }))
  },

  removeLabel: (id) => set(s => ({ labels: s.labels.filter(l => l.id !== id), visualRev: s.visualRev + 1 })),

  clearLabels: (structureId) => {
    set(s => ({
      labels: structureId ? s.labels.filter(l => l.structureId !== structureId) : [],
      visualRev: s.visualRev + 1,
    }))
  },

  updateSettings: (patch) => {
    // bump visualRev：引擎仅在 visualRev 变化时重新 sync（applySettings），
    // 否则背景/雾/FOV/正交/旋转/显隐水氢等设置改动不会传导到渲染器
    set(s => ({ settings: { ...s.settings, ...patch }, visualRev: s.visualRev + 1 }))
  },

  recomputeSS: (structureId) => {
    const data = dataRegistry.get(structureId)
    const entry = get().structures.find(x => x.id === structureId)
    if (!data || !entry) return { helix: 0, strand: 0, loop: 0, error: tt({ zh: '结构不存在', en: 'Structure not found' }) }
    let dssp: import('./dssp').DSSPResult
    try {
      dssp = computeDSSP(data)
    } catch (e) {
      return { helix: 0, strand: 0, loop: 0, error: e instanceof Error ? e.message : tt({ zh: 'DSSP 计算失败', en: 'DSSP computation failed' }) }
    }
    for (let ri = 0; ri < data.residues.length; ri++) {
      data.residues[ri].ss = dssp.ss[ri] === 1 ? 'H' : dssp.ss[ri] === 2 ? 'E' : 'L'
    }
    // bump entry.rev → rep hash 变化 → cartoon 重建
    set(s => ({
      structures: s.structures.map(x => x.id === structureId ? { ...x, hasSS: true, rev: x.rev + 1 } : x),
      visualRev: s.visualRev + 1,
    }))
    return { helix: dssp.helixResidues, strand: dssp.strandResidues, loop: dssp.loopResidues }
  },

  setUi: (patch) => set(s => ({ ui: { ...s.ui, ...patch } })),

  appendLog: (type, text) => {
    const now = new Date()
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    // 单调序号（r59-a2 #1：consoleLog slice(-200) 饱和后长度不变，绝对下标切片会失聪——
    // agent 输出捕获按 seq 过滤，日志滚动不影响）
    logSeq += 1
    set(s => ({ consoleLog: [...s.consoleLog.slice(-200), { type, text, time, seq: logSeq }] }))
  },

  bumpVisual: () => set(s => ({ visualRev: s.visualRev + 1 })),
}))

// 语言切换时重写首条引导日志（SSR 与客户端首渲染均生效：I18nProvider 的 setLocale
// 在渲染期同步触发订阅，早于 ConsoleBar 读取——无水合闪烁/错配）
useI18nStore.subscribe((s, prev) => {
  if (s.locale === prev.locale) return
  const log = useMolStore.getState().consoleLog
  const boot = log[0]
  if (boot && boot.time === '' && boot.seq === undefined) {
    useMolStore.setState({ consoleLog: [{ ...boot, text: tt(BOOT_LOG) }, ...log.slice(1)] })
  }
})

function labelForAtom(data: StructureData, i: number): string {
  const a = data.atoms
  return `${a.chainIds[i].trim() || '?'} ${a.resNames[i]}${a.resSeqs[i]}:${a.names[i]}`
}

/** 构建命名选择掩码表（供表达式求值） */
export function buildNamedMasks(structureId: string, data: StructureData): Map<string, Uint8Array> {
  const store = useMolStore.getState()
  const out = new Map<string, Uint8Array>()
  // PyMOL 关键词 sele：当前选择（所有作用域动词 color red sele / show cartoon sele / zoom sele 通用）
  if (store.selection.structureId === structureId && store.selection.indices.length) {
    const m = new Uint8Array(data.atoms.count)
    for (const i of store.selection.indices) m[i] = 1
    out.set('sele', m)
  }
  // ChimeraX 关键词 sel：同 sele（两种软件当前选择关键词都通用）
  if (out.has('sele')) out.set('sel', out.get('sele')!.slice())
  // ChimeraX #N 模型号：modelN 命名掩码（命中=全部原子，其余结构=空集）
  const idx = store.structures.findIndex(s => s.id === structureId)
  if (idx >= 0) {
    for (let i = 0; i < store.structures.length; i++) {
      const m = new Uint8Array(data.atoms.count)
      if (i === idx) m.fill(1)
      out.set(`model${i + 1}`, m)
    }
  }
  for (const ns of store.namedSelections) {
    if (ns.structureId !== structureId) continue
    if (ns.indices) {
      const m = new Uint8Array(data.atoms.count)
      for (const i of ns.indices) m[i] = 1
      out.set(ns.name, m)
    } else if (ns.expr) {
      const res = evaluateSelection(ns.expr, { structure: data, named: out })
      if (!res.error) out.set(ns.name, res.mask)
    }
  }
  return out
}

/** 解析并注册结构（供加载器调用） */
export function registerStructure(text: string, name: string, format: 'pdb' | 'cif', id = ''): StructureData {
  return parseStructure(text, name, format, id)
}
