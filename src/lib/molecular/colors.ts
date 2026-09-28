// 颜色方案：element(CPK) / chain / spectrum / residue / ss / bfactor / sasa / uniform
import * as THREE from 'three'
import { elementInfo, residueClass, type ResidueClass } from './chemistry'
import type { StructureData } from './parser'
import { maxAtomSasa } from './sasa'
import type { DualText } from '@/i18n'

export type ColorScheme = 'element' | 'chain' | 'spectrum' | 'residue' | 'ss' | 'bfactor' | 'sasa' | 'uniform' | 'pocket'

export const COLOR_SCHEME_LABELS: Record<ColorScheme, DualText> = {
  element: { zh: '元素 (CPK)', en: 'Element (CPK)' },
  chain: { zh: '链', en: 'Chain' },
  spectrum: { zh: '光谱 (彩虹)', en: 'Spectrum (rainbow)' },
  residue: { zh: '残基类型', en: 'Residue type' },
  ss: { zh: '二级结构', en: 'Secondary structure' },
  bfactor: { zh: 'B 因子', en: 'B-factor' },
  sasa: { zh: '溶剂可及 (SASA)', en: 'Solvent accessibility (SASA)' },
  uniform: { zh: '统一颜色', en: 'Uniform color' },
  pocket: { zh: '口袋 (配体距离)', en: 'Pocket (ligand distance)' },
}

/** 链调色板：黄金角 HSL，稳定可复现 */
export function chainColor(index: number): THREE.Color {
  const hue = (index * 137.508) % 360
  return new THREE.Color().setHSL(hue / 360, 0.62, 0.55)
}

const RESIDUE_COLORS: Record<ResidueClass, string> = {
  // r56：整体降饱和 ~15%（保色相语义前提下从「糖果感」收敛到 Jalview Taylor 式沉稳色板）
  nonpolar: '#e6c179',
  polar: '#96c6a4',
  positive: '#62b1c2',
  negative: '#d97b76',
  aromatic: '#b4a1cf',
  cysteine: '#e9d787',
  proline: '#b7aad9',
  glycine: '#c5cad2',
  nucleic: '#7fc0b7',
  water: '#85a2c3',
  ligand: '#dfa8bc',
  unknown: '#b6bbc4',
}

export function residueClassColor(resName: string): THREE.Color {
  return new THREE.Color(RESIDUE_COLORS[residueClass(resName)] ?? '#b8bcc4')
}

const NA_BASE_COLORS: Record<string, string> = {
  A: '#9ccd87', G: '#e6c179', C: '#62b1c2', T: '#d97b76', U: '#d97b76',
}

export function naBaseColor(resName: string): THREE.Color | null {
  const r = resName.toUpperCase()
  const base = r.startsWith('D') ? r.slice(1) : r
  if (NA_BASE_COLORS[base]) return new THREE.Color(NA_BASE_COLORS[base])
  return null
}

const SS_COLORS = { H: '#e2777c', E: '#e3c27c', L: '#a4adb6' } as const

/** B 因子渐变停靠点（蓝→青→绿→黄→红；t∈[0,1] 归一化 B 值）——图例卡与着色共用 */
export const BFACTOR_STOPS: [number, string][] = [
  [0.0, '#2c7bb6'], [0.25, '#66c2a5'], [0.5, '#f2c46d'], [0.75, '#e05d5d'], [1.0, '#b61515'],
]

/** SASA 暴露度渐变停靠点（0 埋藏深蓝 → 1 完全暴露橙红）——图例卡与着色共用 */
export const SASA_STOPS: [number, string][] = [
  [0.0, '#2e4a8f'], [0.3, '#4fa3c7'], [0.6, '#f2d74c'], [1.0, '#e0563d'],
]

/** 口袋距离渐变停靠点（0 近配体深紫红 → 1 远端浅粉）——图例卡与着色共用。
 *  色板刻意避开黄/蓝/红三色：这三个色相留给杂原子元素色（S 黄 · N 蓝 · O 红），
 *  距离渐变只染碳原子，杂原子永远按元素色醒目可辨（PyMOL 出版图惯例） */
export const POCKET_STOPS: [number, string][] = [
  [0.0, '#a02fd0'], [0.5, '#c76fdd'], [1.0, '#f4b6e4'],
]

/** 口袋方案里配体碳的专属色（鲜绿）——与距离渐变紫粉、杂原子黄蓝红、铁锈橙全部拉开 */
export const LIGAND_CARBON_COLOR = '#4caf50'

/** 口袋距离渐变的距离锚点：≤2.7Å 视为紧贴配体（t=0），≥4.5Å 视为口袋外围（t=1） */
export const POCKET_D_NEAR = 2.7
export const POCKET_D_FAR = 4.5

/** 渐变停靠点 → CSS linear-gradient 字符串（图例卡用） */
export function stopsToGradient(stops: [number, string][]): string {
  return `linear-gradient(to right, ${stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})`
}

/** B 因子渐变：蓝→青→绿→黄→红 */
function bfactorColor(t: number): THREE.Color {
  const c = new THREE.Color()
  t = Math.max(0, Math.min(1, t))
  for (let i = 0; i < BFACTOR_STOPS.length - 1; i++) {
    const [t0, c0] = BFACTOR_STOPS[i]
    const [t1, c1] = BFACTOR_STOPS[i + 1]
    if (t >= t0 && t <= t1) {
      return c.set(c0).lerp(new THREE.Color(c1), (t - t0) / (t1 - t0))
    }
  }
  return c.set(BFACTOR_STOPS[BFACTOR_STOPS.length - 1][1])
}

export interface ColorContext {
  uniformColor?: string
}

// ---------- 口袋方案：配体距离场（WeakMap 缓存，结构不可变时只算一次） ----------

interface PocketField {
  /** 配体重原子索引（无配体为空 → 方案退化为元素色） */
  ligandAtoms: number[]
  /** 每残基到最近配体重原子距离（配体自身 = 0；未触及 = Infinity） */
  resDist: Float32Array
}
const pocketFieldCache = new WeakMap<StructureData, PocketField>()

/** 失效口袋距离场缓存：ensemble/morph 帧改写坐标后由引擎调用（距离场随构象变化，
 *  刚体 superpose 不需要——平移旋转不改变残基-配体距离） */
export function invalidatePocketField(structure: StructureData) {
  pocketFieldCache.delete(structure)
}

const isLigandResidue = (r: { hetero: boolean; water: boolean; polymer: boolean }) =>
  r.hetero && !r.water && !r.polymer

function pocketField(structure: StructureData): PocketField {
  const hit = pocketFieldCache.get(structure)
  if (hit) return hit
  const nRes = structure.residues.length
  const resDist = new Float32Array(nRes).fill(Infinity)
  const ligandAtoms: number[] = []
  const pos = structure.atoms.positions
  const els = structure.atoms.elements
  for (let ri = 0; ri < nRes; ri++) {
    const r = structure.residues[ri]
    if (!isLigandResidue(r)) continue
    for (let i = r.start; i < r.end; i++) {
      if (els[i] !== 'H' && els[i] !== 'D') ligandAtoms.push(i)
    }
  }
  if (ligandAtoms.length) {
    // 每个配体重原子间 5.5Å 球内找聚合物重原子，记录残基级最近距离
    for (const li of ligandAtoms) {
      const lx = pos[li * 3], ly = pos[li * 3 + 1], lz = pos[li * 3 + 2]
      const cand = structure.grid.queryRadius(lx, ly, lz, 5.5, pos)
      for (const j of cand) {
        const e = els[j]
        if (e === 'H' || e === 'D') continue
        const d = Math.hypot(pos[j * 3] - lx, pos[j * 3 + 1] - ly, pos[j * 3 + 2] - lz)
        const rj = structure.atomResidue[j]
        if (d < resDist[rj]) resDist[rj] = d
      }
    }
    for (const li of ligandAtoms) resDist[structure.atomResidue[li]] = 0
  }
  const field = { ligandAtoms, resDist }
  pocketFieldCache.set(structure, field)
  return field
}

/** 距离 → 渐变色（近深紫红 → 远浅粉，线性插值） */
const pocketNearColor = new THREE.Color(POCKET_STOPS[0][1])
const pocketFarColor = new THREE.Color(POCKET_STOPS[POCKET_STOPS.length - 1][1])
function pocketDistColor(d: number, out: THREE.Color): THREE.Color {
  const t = Math.max(0, Math.min(1, (d - POCKET_D_NEAR) / (POCKET_D_FAR - POCKET_D_NEAR)))
  return out.copy(pocketNearColor).lerp(pocketFarColor, t)
}

/** 计算整个结构的逐原子颜色（rgb Float32Array，线性空间） */
export function computeAtomColors(
  structure: StructureData,
  scheme: ColorScheme,
  opts: ColorContext = {},
): Float32Array {
  const n = structure.atoms.count
  const out = new Float32Array(n * 3)
  const atoms = structure.atoms
  const tmp = new THREE.Color()

  if (scheme === 'uniform') {
    tmp.set(opts.uniformColor ?? '#cccccc')
    for (let i = 0; i < n; i++) {
      out[i * 3] = tmp.r; out[i * 3 + 1] = tmp.g; out[i * 3 + 2] = tmp.b
    }
    return out
  }

  if (scheme === 'element') {
    const cache = new Map<string, THREE.Color>()
    for (let i = 0; i < n; i++) {
      const el = atoms.elements[i]
      let c = cache.get(el)
      if (!c) { c = new THREE.Color(elementInfo(el).color); cache.set(el, c) }
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'chain') {
    const chainColors: THREE.Color[] = []
    for (let ci = 0; ci < structure.chains.length; ci++) chainColors.push(chainColor(ci))
    for (let i = 0; i < n; i++) {
      const c = chainColors[structure.atomChain[i]] ?? tmp.set('#b8bcc4')
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'spectrum') {
    // 每条聚合物链内按残基序做彩虹
    const colorCache = new Map<number, THREE.Color>()
    for (const ch of structure.chains) {
      const rs = ch.residueIdx.length
      ch.residueIdx.forEach((ri, k) => {
        const t = rs > 1 ? k / (rs - 1) : 0
        colorCache.set(ri, new THREE.Color().setHSL((0.66 - 0.66 * t), 0.75, 0.55))
      })
    }
    for (let i = 0; i < n; i++) {
      const c = colorCache.get(structure.atomResidue[i]) ?? tmp.set('#b8bcc4')
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'residue') {
    // r63-fix-c #4：hetero（配体）分支逐原子按元素着色（按元素缓存），不进 resName 级缓存——
    // 旧版首原子（如 HEM 的 FE）元素色以 resName 缓存后污染整残基内全部原子；
    // standard/水残基颜色只依赖 resName，保持按 resName 缓存的收益
    const cache = new Map<string, THREE.Color>()
    const hetCache = new Map<string, THREE.Color>()
    for (let i = 0; i < n; i++) {
      const rn = atoms.resNames[i]
      let c: THREE.Color | undefined
      if (atoms.hetero[i] && !residueClass(rn).match(/water/)) {
        // 配体保持元素感
        const el = atoms.elements[i]
        c = hetCache.get(el)
        if (!c) { c = new THREE.Color(elementInfo(el).color); hetCache.set(el, c) }
      } else {
        c = cache.get(rn)
        if (!c) { c = naBaseColor(rn) ?? residueClassColor(rn); cache.set(rn, c) }
      }
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'ss') {
    const colors = { H: new THREE.Color(SS_COLORS.H), E: new THREE.Color(SS_COLORS.E), L: new THREE.Color(SS_COLORS.L) }
    const na = new THREE.Color('#7ac9c0')
    const het = new THREE.Color('#b8bcc4')
    for (let i = 0; i < n; i++) {
      const r = structure.residues[structure.atomResidue[i]]
      const isNA = structure.chains[structure.atomChain[i]]?.type === 'nucleic'
      const c = r.water ? het : isNA ? na : colors[r.ss]
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'bfactor') {
    let min = Infinity, max = -Infinity
    for (let i = 0; i < n; i++) {
      const b = atoms.bfactors[i]
      if (b < min) min = b
      if (b > max) max = b
    }
    const span = max - min || 1
    for (let i = 0; i < n; i++) {
      const c = bfactorColor((atoms.bfactors[i] - min) / span)
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'sasa') {
    // 暴露分数 = 原子 SASA / 扩展球面积：埋藏蓝紫 → 暴露橙红（需先运行 SASA 分析，否则灰色）
    const fallback = new THREE.Color('#b8bcc4')
    const sasa = structure.sasa
    for (let i = 0; i < n; i++) {
      const c = sasa ? sasaExposureColor(sasa[i], atoms.elements[i], 1.4) : fallback
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    return out
  }

  if (scheme === 'pocket') {
    // 口袋专业配色（配体分析/出版互作图）：
    //  · 配体残基：碳 = 鲜绿专属色，杂原子 = 元素色 → 配体作为一个整体从环境中脱颖而出
    //  · 聚合物残基：碳 = 到配体最近距离的紫→粉渐变（残基级统一色，读作完整氨基酸），
    //    杂原子 = 元素色（距离球外的残基无距离数据 → 退化为元素灰）
    const field = pocketField(structure)
    const ligRes = new Uint8Array(structure.residues.length)
    for (let ri = 0; ri < structure.residues.length; ri++) {
      if (isLigandResidue(structure.residues[ri])) ligRes[ri] = 1
    }
    const elemCache = new Map<string, THREE.Color>()
    const ligC = new THREE.Color(LIGAND_CARBON_COLOR)
    const resCache = new Map<number, THREE.Color>()
    for (let i = 0; i < n; i++) {
      const el = atoms.elements[i]
      const ri = structure.atomResidue[i]
      let col: THREE.Color
      if (el !== 'C') {
        // 杂原子一律元素色（N 蓝/O 红/S 黄/金属本色）——渐变只染碳，色板避开黄蓝红保杂原子醒目
        let e = elemCache.get(el)
        if (!e) { e = new THREE.Color(elementInfo(el).color); elemCache.set(el, e) }
        col = e
      } else if (ligRes[ri]) {
        col = ligC
      } else {
        const d = field.resDist[ri]
        if (Number.isFinite(d)) {
          let rc = resCache.get(ri)
          if (!rc) { rc = pocketDistColor(d, new THREE.Color()); resCache.set(ri, rc) }
          col = rc
        } else {
          let e = elemCache.get(el)
          if (!e) { e = new THREE.Color(elementInfo(el).color); elemCache.set(el, e) }
          col = e
        }
      }
      out[i * 3] = col.r; out[i * 3 + 1] = col.g; out[i * 3 + 2] = col.b
    }
    return out
  }

  // uniform 兜底（已被上方分支拦截，不会到达）
  tmp.set(opts.uniformColor ?? '#cccccc')
  for (let i = 0; i < n; i++) {
    out[i * 3] = tmp.r; out[i * 3 + 1] = tmp.g; out[i * 3 + 2] = tmp.b
  }
  return out
}

/** SASA 暴露分数渐变：0 埋藏（深蓝）→ 1 完全暴露（橙红），4 段过渡 */
const sasaColorCache = new Map<string, THREE.Color>()

export function sasaExposureColor(atomSasa: number, element: string, probe: number): THREE.Color {
  const maxA = maxAtomSasa(element, probe)
  const f = Math.max(0, Math.min(1, atomSasa / maxA))
  const key = element + '|' + f.toFixed(2)
  const hit = sasaColorCache.get(key)
  if (hit) return hit
  const c = new THREE.Color()
  for (let i = 0; i < SASA_STOPS.length - 1; i++) {
    const [t0, c0] = SASA_STOPS[i]
    const [t1, c1] = SASA_STOPS[i + 1]
    if (f >= t0 && f <= t1) {
      c.set(c0).lerp(new THREE.Color(c1), (f - t0) / (t1 - t0))
      break
    }
  }
  if (sasaColorCache.size > 600) sasaColorCache.clear()
  sasaColorCache.set(key, c)
  return c
}

/** CSS 颜色名 → hex（常用集） */
export const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080',
  red: '#e04545', green: '#4caf50', blue: '#4a7fd4', yellow: '#f2d74c',
  orange: '#f28a2e', purple: '#a45ad4', cyan: '#48c8c8', magenta: '#d456b0',
  pink: '#f08fb0', brown: '#a5703c', lime: '#a8e05f', teal: '#3aa9a9',
  silver: '#c0c0c0', gold: '#f0c040', violet: '#9a5fd4', salmon: '#fa8072',
  crimson: '#dc143c', indigo: '#5b4bd4', coral: '#ff7f50', slate: '#708090',
}

export function parseCssColor(s: string): string | null {
  const t = s.trim().toLowerCase()
  if (NAMED_COLORS[t]) return NAMED_COLORS[t]
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t)) return t
  return null
}

/** 序列条残基底色（CSS，用于 UI） */
export function residueCssColor(resName: string): string {
  return naBaseColor(resName)?.getStyle() ?? RESIDUE_COLORS[residueClass(resName)] ?? '#b8bcc4'
}

/** 残基格自适应墨色：按背景相对亮度选近黑/近白文字（WCAG 对比保障）
 *  兼容 #rrggbb 与 rgb(r,g,b) 两种输入（naBaseColor 走 THREE getStyle 输出 rgb() 串） */
export function readableInk(color: string): string {
  let r = 255, g = 255, b = 255
  const t = color.trim()
  const hex = /^#?([0-9a-f]{6})$/i.exec(t)
  const rgb = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/i.exec(t)
  if (hex) {
    const v = parseInt(hex[1], 16)
    r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255
  } else if (rgb) {
    r = +rgb[1]; g = +rgb[2]; b = +rgb[3]
  }
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const L = 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255)
  return L > 0.45 ? '#16191d' : '#ffffff'
}

export function ssCssColor(ss: string): string {
  return SS_COLORS[ss as keyof typeof SS_COLORS] ?? SS_COLORS.L
}
