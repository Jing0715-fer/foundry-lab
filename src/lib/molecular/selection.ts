// PyMOL 风格原子选择表达式：chain A and (resi 50-60 or resn HEM) | within 4 of (ligand) | byres(...)
import { AMINO_ACIDS, NUCLEIC_ACIDS, WATERS, elementInfo, BACKBONE_ATOMS } from './chemistry'
import type { StructureData } from './parser'
import { tt, type DualText } from '@/i18n'

export interface EvalContext {
  structure: StructureData
  named: Map<string, Uint8Array>
}

export interface EvalResult {
  mask: Uint8Array
  count: number
  error?: string
}

// ---------- 词法 ----------

type Tok = { t: 'word'; v: string } | { t: 'num'; v: number } | { t: 'punct'; v: string }

function tokenize(src: string): Tok[] | { error: string } {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '(' || ch === ')' || ch === '&' || ch === '|' || ch === '!' || ch === '+' || ch === '-' || ch === '<' || ch === '>' || ch === '=') {
      toks.push({ t: 'punct', v: ch })
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1)
      if (end === -1) return { error: tt({ zh: '未闭合的引号', en: 'Unclosed quote' }) }
      toks.push({ t: 'word', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    let j = i
    while (j < n && !/[\s()&|!+\-<>="']/.test(src[j])) j++
    const w = src.slice(i, j)
    if (/^[0-9]*\.?[0-9]+$/.test(w)) toks.push({ t: 'num', v: parseFloat(w) })
    else toks.push({ t: 'word', v: w })
    i = j
  }
  return toks
}

// ---------- 语法解析 + 求值（直接融合，简单清晰） ----------

class Evaluator {
  toks: Tok[]
  pos = 0
  ctx: EvalContext

  constructor(toks: Tok[], ctx: EvalContext) {
    this.toks = toks
    this.ctx = ctx
  }

  peek(): Tok | null { return this.toks[this.pos] ?? null }
  next(): Tok | null { return this.toks[this.pos++] ?? null }
  isWord(...vs: string[]): boolean {
    const t = this.peek()
    return !!t && t.t === 'word' && vs.includes(t.v.toLowerCase())
  }
  expectPunct(v: string): boolean {
    const t = this.next()
    return !!t && t.t === 'punct' && t.v === v
  }

  parse(): Uint8Array | { error: string } {
    const r = this.parseOr()
    if (r && 'error' in r) return r
    if (this.pos < this.toks.length) return { error: tt({ zh: `无法解析的多余内容：${JSON.stringify(this.toks[this.pos])}`, en: `Unparseable trailing content: ${JSON.stringify(this.toks[this.pos])}` }) }
    return r
  }

  parseOr(): Uint8Array | { error: string } {
    let left = this.parseAnd()
    if (left && 'error' in left) return left
    while (this.isWord('or') || (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '|')) {
      this.next()
      const right = this.parseAnd()
      if (right && 'error' in right) return right
      for (let i = 0; i < left.length; i++) if (right[i]) left[i] = 1
    }
    return left
  }

  parseAnd(): Uint8Array | { error: string } {
    let left = this.parseUnary()
    if (left && 'error' in left) return left
    for (;;) {
      const p = this.peek()
      const isAnd = this.isWord('and') || (p?.t === 'punct' && (p as { v: string }).v === '&')
      // PyMOL 二元扩展操作符：A in B / A like B（与 and 同优先级，左结合）
      const isIn = this.isWord('in')
      const isLike = this.isWord('like')
      if (!isAnd && !isIn && !isLike) break
      this.next()
      const right = this.parseUnary()
      if (right && 'error' in right) return right
      if (isIn || isLike) {
        left = matchByResidue(this.ctx, left, right, isLike)
      } else {
        for (let i = 0; i < left.length; i++) left[i] = left[i] && right[i] ? 1 : 0
      }
    }
    return left
  }

  parseUnary(): Uint8Array | { error: string } {
    if (this.isWord('not') || (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '!')) {
      this.next()
      const inner = this.parseUnary()
      if (inner && 'error' in inner) return inner
      for (let i = 0; i < inner.length; i++) inner[i] = inner[i] ? 0 : 1
      return inner
    }
    return this.parsePrimary()
  }

  parsePrimary(): Uint8Array | { error: string } {
    const t = this.peek()
    if (!t) return { error: tt({ zh: '表达式意外结束', en: 'Unexpected end of expression' }) }
    if (t.t === 'punct' && t.v === '(') {
      this.next()
      const inner = this.parseOr()
      if (inner && 'error' in inner) return inner
      if (!this.expectPunct(')')) return { error: tt({ zh: '缺少右括号 )', en: 'Missing closing parenthesis )' }) }
      return inner
    }
    if (t.t !== 'word') return { error: tt({ zh: `意外的符号 ${t.v}`, en: `Unexpected token ${t.v}` }) }
    const kw = t.v.toLowerCase()

    // 零参数谓词
    const zero = zeroPredicates[kw]
    if (zero) {
      this.next()
      return zero(this.ctx)
    }
    if (kw === 'within' || kw === 'within5' || kw === 'near') {
      this.next()
      const num = this.next()
      if (!num || num.t !== 'num') return { error: tt({ zh: 'within 需要距离数值，如 within 5 of (...)', en: 'within requires a distance value, e.g. within 5 of (...)' }) }
      if (!this.isWord('of')) return { error: tt({ zh: 'within 语法：within <距离> of (<表达式>)', en: 'within syntax: within <distance> of (<expression>)' }) }
      this.next()
      const inner = this.parsePrimary()
      if (inner && 'error' in inner) return inner
      return withinOf(this.ctx, inner, num.v)
    }
    if (kw === 'byres' || kw === 'byresi') {
      this.next()
      const inner = this.parsePrimary()
      if (inner && 'error' in inner) return inner
      return expandResidues(this.ctx, inner)
    }
    if (kw === 'bychain') {
      this.next()
      const inner = this.parsePrimary()
      if (inner && 'error' in inner) return inner
      return expandChains(this.ctx, inner)
    }
    if (kw === 'bfactor' || kw === 'b') {
      this.next()
      const op = this.next()
      if (!op || op.t !== 'punct' || !['<', '>', '='].includes(op.v)) return { error: tt({ zh: 'bfactor 需要比较符 < > =', en: 'bfactor requires a comparison operator < > =' }) }
      const val = this.next()
      if (!val || val.t !== 'num') return { error: tt({ zh: 'bfactor 需要数值', en: 'bfactor requires a numeric value' }) }
      return bfactorCmp(this.ctx, op.v, val.v)
    }
    // PyMOL q：占据率比较（q > 0.3 / q < 1）
    if (kw === 'q' || kw === 'occupancy') {
      this.next()
      const op = this.next()
      if (!op || op.t !== 'punct' || !['<', '>', '='].includes(op.v)) return { error: tt({ zh: 'q 需要比较符 < > =', en: 'q requires a comparison operator < > =' }) }
      const val = this.next()
      if (!val || val.t !== 'num') return { error: tt({ zh: 'q 需要数值', en: 'q requires a numeric value' }) }
      return occupancyCmp(this.ctx, op.v, val.v)
    }
    // PyMOL byobject：扩展到选择所含原子所在的整个对象（单结构 = 单对象：命中任一原子则全选）
    if (kw === 'byobject') {
      this.next()
      const inner = this.parsePrimary()
      if (inner && 'error' in inner) return inner
      for (let i = 0; i < inner.length; i++) {
        if (inner[i]) { inner.fill(1); return inner }
      }
      return inner
    }
    // 单参数谓词
    const one = onePredicates[kw]
    if (one) {
      this.next()
      const values = this.parseValueList()
      if (values instanceof Array === false) return values as { error: string }
      if (!values.length) return { error: tt({ zh: `${t.v} 需要参数值`, en: `${t.v} requires argument values` }) }
      return one(this.ctx, values)
    }
    // 命名选择
    const namedMask = this.ctx.named.get(t.v)
    if (namedMask) {
      this.next()
      return namedMask.slice()
    }
    return { error: tt({ zh: `无法识别的选择词 "${t.v}"`, en: `Unrecognized selection keyword "${t.v}"` }) }
  }

  parseValueList(): string[] | { error: string } {
    const values: string[] = []
    // PyMOL 宽容语法：谓词后裸 '='（resn = ALA / chain = A）——静默跳过，语义与省略等价
    if (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === '=') this.next()
    const first = this.next()
    if (!first) return { error: tt({ zh: '缺少参数值', en: 'Missing argument value' }) }
    // 负数首值：'-5'（'-' 是独立 punct）
    if (first.t === 'punct' && first.v === '-') {
      const v = this.next()
      if (!v) return { error: tt({ zh: '缺少参数值', en: 'Missing argument value' }) }
      values.push(`-${(v as { v: number | string }).v}`)
    } else {
      values.push(String((first as { v: string | number }).v))
    }
    // 支持 a+b+c 列表与 a-b 范围：'-' 与前一个数值组合成范围串（'60-120'），
    // 非数值前项则视为负数列表项（'-5'）
    for (;;) {
      const p = this.peek()
      if (!p || p.t !== 'punct' || (p.v !== '+' && p.v !== '-')) break
      this.next()
      const v = this.next()
      if (!v) return { error: tt({ zh: '列表/范围不完整', en: 'Incomplete list/range' }) }
      const val = String((v as { v: string | number }).v)
      if (p.v === '+') {
        values.push(val)
      } else {
        const last = values[values.length - 1]
        if (/^-?\d+$/.test(last)) {
          // 范围：60-120（允许负端点 -5--1）
          values[values.length - 1] = `${last}-${val}`
        } else {
          values.push(`-${val}`)
        }
      }
    }
    return values
  }
}

// ---------- 谓词实现 ----------

type ZeroPred = (ctx: EvalContext) => Uint8Array
type OnePred = (ctx: EvalContext, values: string[]) => Uint8Array

function newMask(ctx: EvalContext): Uint8Array {
  return new Uint8Array(ctx.structure.atoms.count)
}

const zeroPredicates: Record<string, ZeroPred> = {
  all: (ctx) => newMask(ctx).fill(1),
  none: (ctx) => newMask(ctx),
  protein: (ctx) => predRes(ctx, (r) => AMINO_ACIDS.has(r.resName.toUpperCase())),
  amino: (ctx) => predRes(ctx, (r) => AMINO_ACIDS.has(r.resName.toUpperCase())),
  nucleic: (ctx) => predRes(ctx, (r) => NUCLEIC_ACIDS.has(r.resName.toUpperCase())),
  polymer: (ctx) => predRes(ctx, (r) => r.polymer),
  hetero: (ctx) => predRes(ctx, (r) => r.hetero && !r.water),
  het: (ctx) => predRes(ctx, (r) => r.hetero && !r.water),
  water: (ctx) => predRes(ctx, (r) => r.water),
  ligand: (ctx) => predRes(ctx, (r) => r.hetero && !r.water && !r.polymer),
  metal: (ctx) => predAtom(ctx, (i) => elementInfo(ctx.structure.atoms.elements[i]).metal),
  // PyMOL hydrogen：元素氢（常用于 not hydrogen）
  hydrogen: (ctx) => predAtom(ctx, (i) => ctx.structure.atoms.elements[i].toUpperCase() === 'H'),
  // ChimeraX ions / solvent：离子残基 / 水+离子（两种软件的溶剂语义并轨）
  ions: (ctx) => predAtom(ctx, (i) => elementInfo(ctx.structure.atoms.elements[i]).metal && !ctx.structure.residues[ctx.structure.atomResidue[i]].water),
  solvent: (ctx) => predAtom(ctx, (i) => ctx.structure.residues[ctx.structure.atomResidue[i]].water || elementInfo(ctx.structure.atoms.elements[i]).metal),
  backbone: (ctx) => predAtom(ctx, (i) => BACKBONE_ATOMS.has(ctx.structure.atoms.names[i]) && ctx.structure.residues[ctx.structure.atomResidue[i]].polymer),
  sidechain: (ctx) => predAtom(ctx, (i) => !BACKBONE_ATOMS.has(ctx.structure.atoms.names[i]) && ctx.structure.residues[ctx.structure.atomResidue[i]].polymer),
  helix: (ctx) => predRes(ctx, (r) => r.ss === 'H'),
  sheet: (ctx) => predRes(ctx, (r) => r.ss === 'E'),
  coil: (ctx) => predRes(ctx, (r) => r.ss === 'L' && r.polymer && AMINO_ACIDS.has(r.resName.toUpperCase())),
  turn: (ctx) => predRes(ctx, (r) => r.ss === 'L'),
}

const onePredicates: Record<string, OnePred> = {
  chain: (ctx, vs) => predAtom(ctx, (i) => vs.map(v => v.toUpperCase()).includes(ctx.structure.atoms.chainIds[i].toUpperCase())),
  // 按链组索引选择：同一链 ID 可能拆成多个不连续链组（蛋白链 A 与其 HETATM 配体/水各自成组）。
  // chainidx 4 = 第 5 个链组（与结构面板「链」列表行号一致），能精确选中「链 A 的配体」而不波及整条链。
  chainidx: (ctx, vs) => {
    const set = new Set<number>()
    for (const v of vs) {
      const n = parseInt(v, 10)
      if (!isNaN(n)) set.add(n)
    }
    return predAtom(ctx, (i) => set.has(ctx.structure.atomChain[i]))
  },
  // 按配体分子索引选择（0 基，与链面板配体行/序列条配体 chip 编号一致）：
  // molecule 2 = 第 3 个配体分子——多残基配体（多糖/肽类）整体选中，不波及同链其它分子
  molecule: (ctx, vs) => {
    const set = new Set<number>()
    for (const v of vs) {
      const n = parseInt(v, 10)
      if (!isNaN(n)) set.add(n)
    }
    return predAtom(ctx, (i) => {
      const m = ctx.structure.atomMolecule[i]
      return m >= 0 && set.has(m)
    })
  },
  mol: (ctx, vs) => onePredicates.molecule(ctx, vs),
  resn: (ctx, vs) => {
    const set = new Set(vs.map(v => v.toUpperCase()))
    return predAtom(ctx, (i) => set.has(ctx.structure.atoms.resNames[i].toUpperCase()))
  },
  name: (ctx, vs) => {
    const set = new Set(vs.map(v => v.toUpperCase()))
    return predAtom(ctx, (i) => set.has(ctx.structure.atoms.names[i].toUpperCase()))
  },
  elem: (ctx, vs) => {
    const set = new Set(vs.map(v => v.toUpperCase()))
    return predAtom(ctx, (i) => set.has(ctx.structure.atoms.elements[i].toUpperCase()))
  },
  element: (ctx, vs) => onePredicates.elem(ctx, vs),
  resi: (ctx, vs) => {
    // 解析范围列表：45, 45-60, -5
    const ranges: [number, number][] = []
    for (const v of vs) {
      const m = v.match(/^(\d+)-(\d+)$/) || v.match(/^(-\d+)-(-\d+)$/)
      if (m) { ranges.push([parseInt(m[1], 10), parseInt(m[2], 10)]); continue }
      const num = parseInt(v, 10)
      if (!isNaN(num)) ranges.push([num, num])
    }
    return predAtom(ctx, (i) => {
      const s = ctx.structure.atoms.resSeqs[i]
      return ranges.some(([a, b]) => s >= a && s <= b)
    })
  },
  // PyMOL id：按 PDB 原子序号（ATOM/HETATM serial）选择，支持 id 100 / id 100-200
  id: (ctx, vs) => {
    const set = new Set<number>()
    for (const v of vs) {
      const m = v.match(/^(\d+)-(\d+)$/)
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10)
        if (b - a > 200000) return predAtom(ctx, () => false)
        for (let k = a; k <= b; k++) set.add(k)
        continue
      }
      const n = parseInt(v, 10)
      if (!isNaN(n)) set.add(n)
    }
    return predAtom(ctx, (i) => set.has(ctx.structure.atoms.serial[i]))
  },
  // PyMOL ss h/s/l：按二级结构选择（h=螺旋 s=折叠 l/c=环——PyMOL 字母体系）
  ss: (ctx, vs) => {
    const types = new Set<string>()
    for (const v of vs) {
      const c = v.toLowerCase()
      types.add(c === 'h' ? 'H' : c === 's' ? 'E' : c === 'c' ? 'L' : c)
    }
    return predRes(ctx, (r) => types.has(r.ss))
  },
}

function predRes(ctx: EvalContext, fn: (r: StructureData['residues'][number]) => boolean): Uint8Array {
  const m = newMask(ctx)
  const st = ctx.structure
  for (let ri = 0; ri < st.residues.length; ri++) {
    const r = st.residues[ri]
    if (fn(r)) for (let i = r.start; i < r.end; i++) m[i] = 1
  }
  return m
}

function predAtom(ctx: EvalContext, fn: (i: number) => boolean): Uint8Array {
  const m = newMask(ctx)
  for (let i = 0; i < m.length; i++) if (fn(i)) m[i] = 1
  return m
}

function withinOf(ctx: EvalContext, inner: Uint8Array, radius: number): Uint8Array {
  const st = ctx.structure
  const m = newMask(ctx)
  const seeds: number[] = []
  for (let i = 0; i < inner.length; i++) if (inner[i]) seeds.push(i)
  const r2 = radius * radius
  const pos = st.atoms.positions
  for (let s = 0; s < seeds.length; s++) {
    const si = seeds[s]
    const sx = pos[si * 3], sy = pos[si * 3 + 1], sz = pos[si * 3 + 2]
    const cand = st.grid.queryRadius(sx, sy, sz, radius, pos)
    for (const j of cand) {
      const dx = pos[j * 3] - sx, dy = pos[j * 3 + 1] - sy, dz = pos[j * 3 + 2] - sz
      if (dx * dx + dy * dy + dz * dz <= r2) m[j] = 1
    }
  }
  return m
}

function expandResidues(ctx: EvalContext, inner: Uint8Array): Uint8Array {
  const st = ctx.structure
  const m = new Uint8Array(inner.length)
  for (let i = 0; i < inner.length; i++) {
    if (inner[i]) {
      const r = st.residues[st.atomResidue[i]]
      for (let k = r.start; k < r.end; k++) m[k] = 1
    }
  }
  return m
}

function expandChains(ctx: EvalContext, inner: Uint8Array): Uint8Array {
  const st = ctx.structure
  const m = new Uint8Array(inner.length)
  const chainSet = new Set<number>()
  for (let i = 0; i < inner.length; i++) if (inner[i]) chainSet.add(st.atomChain[i])
  for (let i = 0; i < inner.length; i++) if (chainSet.has(st.atomChain[i])) m[i] = 1
  return m
}

function bfactorCmp(ctx: EvalContext, op: string, val: number): Uint8Array {
  const m = newMask(ctx)
  const b = ctx.structure.atoms.bfactors
  for (let i = 0; i < m.length; i++) {
    const ok = op === '<' ? b[i] < val : op === '>' ? b[i] > val : Math.abs(b[i] - val) < 0.01
    if (ok) m[i] = 1
  }
  return m
}

function occupancyCmp(ctx: EvalContext, op: string, val: number): Uint8Array {
  const m = newMask(ctx)
  const occ = ctx.structure.atoms.occupancies
  for (let i = 0; i < m.length; i++) {
    const ok = op === '<' ? occ[i] < val : op === '>' ? occ[i] > val : Math.abs(occ[i] - val) < 0.01
    if (ok) m[i] = 1
  }
  return m
}

/** PyMOL「A in B / A like B」：A 中位于 B 所含残基内的原子子集。
 *  in = 按残基匹配（A 中属于 B 出现过的残基的全部原子）；
 *  like = 更严格（A 中原子且其原子名出现在同残基的 B 中）——这里按 PyMOL 语义近似：先按残基匹配再限 A∩B 原子集 */
function matchByResidue(ctx: EvalContext, left: Uint8Array, right: Uint8Array, strict: boolean): Uint8Array {
  const st = ctx.structure
  const resMask = new Map<number, boolean>()
  for (let i = 0; i < right.length; i++) {
    if (right[i]) resMask.set(st.atomResidue[i], true)
  }
  const m = new Uint8Array(left.length)
  for (let i = 0; i < left.length; i++) {
    if (!left[i]) continue
    if (resMask.get(st.atomResidue[i])) m[i] = strict ? (right[i] ? 1 : 0) : 1
  }
  return m
}

// ---------- 预设选择 ----------

export const PRESET_SELECTIONS: { value: string; label: DualText }[] = [
  { value: 'all', label: { zh: 'all — 全部原子', en: 'all — all atoms' } },
  { value: 'polymer', label: { zh: 'polymer — 聚合物(蛋白+核酸)', en: 'polymer — polymer (protein + nucleic acid)' } },
  { value: 'protein', label: { zh: 'protein — 氨基酸', en: 'protein — amino acids' } },
  { value: 'nucleic', label: { zh: 'nucleic — 核酸', en: 'nucleic — nucleic acids' } },
  { value: 'ligand', label: { zh: 'ligand — 配体', en: 'ligand — ligands' } },
  { value: 'molecule 0', label: { zh: 'molecule N — 第 N 个配体分子（0 基）', en: 'molecule N — the Nth ligand molecule (0-based)' } },
  { value: 'hetero', label: { zh: 'hetero — 非聚合物', en: 'hetero — non-polymer' } },
  { value: 'water', label: { zh: 'water — 水', en: 'water — water' } },
  { value: 'metal', label: { zh: 'metal — 金属离子', en: 'metal — metal ions' } },
  { value: 'backbone', label: { zh: 'backbone — 主链', en: 'backbone — backbone atoms' } },
  { value: 'sidechain', label: { zh: 'sidechain — 侧链', en: 'sidechain — side chains' } },
  { value: 'helix', label: { zh: 'helix — 螺旋', en: 'helix — helices' } },
  { value: 'sheet', label: { zh: 'sheet — β折叠', en: 'sheet — β-strands' } },
  { value: 'ss h', label: { zh: 'ss h/s/l — 二级结构（PyMOL 字母体系）', en: 'ss h/s/l — secondary structure (PyMOL letters)' } },
  { value: 'b > 50', label: { zh: 'b > 50 — B 因子比较（q 占据率同理）', en: 'b > 50 — B-factor comparison (q occupancy works the same)' } },
  { value: 'chain A and resi 50-100', label: { zh: 'chain X and resi N-M — 链+残基号组合', en: 'chain X and resi N-M — chain + residue-number combination' } },
  { value: 'not hydrogen', label: { zh: 'not hydrogen — 排除氢原子', en: 'not hydrogen — exclude hydrogens' } },
]

// ---------- 求值入口 ----------

// ---------- ChimeraX 说明符兼容层 ----------

/**
 * ChimeraX 原子说明符 → 内部 PyMOL 风格语法转写。
 * ChimeraX 记号：`#1` 模型 · `/A` 链 · `:42` 残基号 · `:HEM` 残基名 · `@CA` 原子名 ·
 * `& |` 与或 · `~` 非 · `<spec> zone <Å>` 邻域 · 拼接即交集（`#1/A:42@CA`）。
 * 纯 PyMOL 语法（不含 : / @ # ~ 记号）原样通过——两种软件用户零成本上手的关键。
 */
export function preprocessChimeraX(expr: string): string {
  // 无 ChimeraX 记号且非「zone N」省略形式 → PyMOL 语法零开销直通
  if (!/[:@#~/]/.test(expr) && !/^zone\s+[\d.]+$/i.test(expr)) return expr
  let s = ` ${expr} `
  // 1) ~ 取反 → not（ChimeraX ~sel / ~:A）；& | 操作符加空格（无空格拼接形式 :HEM&/A 可分段）
  s = s.replace(/~(?=[\w@:#/(])/g, ' not ')
  s = s.replace(/([&|])/g, ' $1 ')
  // 2) zone：<说明符块> zone <Å> → within <Å> of (<说明符块>)——在分块展开前做
  //    （zone 词与说明符同属一个空白分块序列，先捕获原始 spec 再统一送展开）
  //    另支持 ChimeraX「select zone 5」省略形式（当前选择的 zone 扩展）
  for (let guard = 0; guard < 12; guard++) {
    const m = s.match(/([:@#/\w][:@#/\w,.\-]*)\s+zone\s+([\d.]+)/)
    if (!m) break
    s = s.replace(m[0], ` within ${m[2]} of (${m[1]}) `)
  }
  s = s.replace(/^\s*zone\s+([\d.]+)\s*$/, ' within $1 of (sele) ')
  // 3) 说明符 token 展开（含拼接形式 #1/A:42-60@CA,CB）
  //    按空白切块；含记号的块做段级展开，其余词原样保留
  s = s.split(/\s+/).map(chunk => expandSpecChunk(chunk)).join(' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** 单个 ChimeraX 说明符块展开为内部子表达式；非说明符块原样返回 */
function expandSpecChunk(chunk: string): string {
  if (!chunk || !/[@:#/]/.test(chunk)) return chunk
  // 剥离块内包裹的操作符（& | ! 与我们语法重合的记号留在字符串里由外层处理）
  // 顺序扫描四种记号段：#model /chain :residue @atom
  const segRe = /(#[\w.]+)|(\/[^\/:@#\s&|(),]+(?:,[^\/:@#\s&|(),]+)*)|(:[^\/:@#\s&|()]+)|(@[^\/:@#\s&|()]+)/g
  const clauses: string[] = []
  let consumed = ''
  let m: RegExpExecArray | null
  while ((m = segRe.exec(chunk)) !== null) {
    consumed += m[0]
    if (m[1]) {
      // #N 模型号 → modelN 命名引用（buildNamedMasks 注册：命中=全部原子，否则空集）
      const num = m[1].slice(1).split('.')[0]
      if (!/^\d+$/.test(num)) return chunk
      clauses.push(`model${num}`)
    } else if (m[2]) {
      const chains = m[2].slice(1).split(',').filter(Boolean).join('+')
      if (!chains) return chunk
      clauses.push(`chain ${chains}`)
    } else if (m[3]) {
      // :残基——数字/范围→resi；名称→resn；逗号列表混排用 or 组合
      const items = m[3].slice(1).split(',').filter(Boolean)
      if (!items.length) return chunk
      const numClauses: string[] = []
      const nameClauses: string[] = []
      for (const it of items) {
        const rm = it.match(/^(\d+)-(\d+)$/)
        if (rm) numClauses.push(`resi ${rm[1]}-${rm[2]}`)
        else if (/^\d+$/.test(it)) numClauses.push(`resi ${it}`)
        else if (it) nameClauses.push(`resn ${it}`)
      }
      const ors: string[] = []
      if (numClauses.length) ors.push(numClauses.length === 1 ? numClauses[0] : `(${numClauses.join(' or ')})`)
      if (nameClauses.length) ors.push(nameClauses.length === 1 ? nameClauses[0] : `(${nameClauses.join(' or ')})`)
      clauses.push(ors.length === 1 ? ors[0] : `(${ors.join(' or ')})`)
    } else if (m[4]) {
      const atoms = m[4].slice(1).split(',').filter(Boolean).join('+')
      if (!atoms) return chunk
      clauses.push(`name ${atoms}`)
    }
  }
  // 块内除记号段外还有未消费内容（如 :A:HEM 双冒号等异形）→ 放弃转写走原路径（会报可读语法错）
  const rest = chunk.replace(consumed, '')
  if (rest.trim() && /[\w]/.test(rest)) return chunk
  if (!clauses.length) return chunk
  return `(${clauses.join(' and ')})`
}

export function evaluateSelection(expr: string, ctx: EvalContext): EvalResult {
  const trimmed = expr.trim()
  if (!trimmed || trimmed.toLowerCase() === 'all' || trimmed === '*') {
    const m = new Uint8Array(ctx.structure.atoms.count).fill(1)
    return { mask: m, count: m.length }
  }
  // ChimeraX 说明符兼容（含记号才转写；PyMOL 语法零开销直通）
  const internal = preprocessChimeraX(trimmed)
  const toks = tokenize(internal)
  if (toks && 'error' in toks) return { mask: new Uint8Array(ctx.structure.atoms.count), count: 0, error: toks.error }
  const ev = new Evaluator(toks as Tok[], ctx)
  const r = ev.parse()
  if (r && 'error' in r) return { mask: new Uint8Array(ctx.structure.atoms.count), count: 0, error: r.error }
  let c = 0
  for (let i = 0; i < r.length; i++) if (r[i]) c++
  return { mask: r, count: c }
}

export function maskToIndices(mask: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i)
  return out
}
