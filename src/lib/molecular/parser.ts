// PDB / mmCIF 解析器 → StructureData（原子、残基、链、键、二级结构、晶胞）
import { tt } from '@/i18n'
import {
  AMINO_ACIDS, NUCLEIC_ACIDS, WATERS, SUGAR_LIKE, elementFromAtomName, elementInfo,
} from './chemistry'
import { computeDSSP } from './dssp'
import { parseCryst1, type CrystalInfo } from './symmetry'

export type SSType = 'H' | 'E' | 'L' // helix / sheet / loop

// ---- 病态文件防护（r67）：解析层硬上限 ----
// 背景：乱坐标/非连续 resSeq 的损坏文件可使键推断 n² 爆炸（Set/数组吃光内存）、
// 或每原子裂变为独立残基（序列条渲染十万级按钮冻结主线程）。
// 超限直接抛双语错误——四处调用方（loader/session×2/registerStructure）均有
// try/catch 包裹，错误经既有 toast 管道直达用户，页面零副作用。
/** 残基数硬上限：真实蛋白 ~1 残基/8 原子，300K 原子上限下正常文件 ≤ ~40K 残基；
 *  超限即 resSeq 逐原子裂变（损坏文件签名） */
export const MAX_RESIDUES = 60_000
/** 化学键数上限 = 原子数 × 该因子（真实蛋白约 1.3 键/原子，12× 已极宽裕） */
export const MAX_BONDS_PER_ATOM = 12

export interface AtomData {
  count: number
  positions: Float32Array      // xyz * count
  serial: Int32Array
  names: string[]
  elements: string[]
  resNames: string[]
  resSeqs: Int32Array
  iCodes: string[]
  chainIds: string[]
  bfactors: Float32Array
  occupancies: Float32Array
  hetero: Uint8Array
}

export interface Residue {
  chainId: string
  resSeq: number
  iCode: string
  resName: string
  start: number // 起始原子索引（含）
  end: number   // 结束原子索引（不含）
  ss: SSType
  polymer: boolean
  water: boolean
  hetero: boolean
}

export type ChainType = 'protein' | 'nucleic' | 'water' | 'ligand'

export interface Chain {
  id: string
  type: ChainType
  start: number
  end: number
  residueIdx: number[] // 残基索引列表
}

/** 配体分子：非聚合物异源残基经化学键/距离连通的分量（水不参与） */
export interface LigandMolecule {
  /** 构成残基索引（升序） */
  residues: number[]
  /** 原子总数 */
  atoms: number
  /** 残基名去重（首现顺序） */
  resNames: string[]
  /** 链 ID 去重 */
  chainIds: string[]
  /** 主标签：单残基 = 残基名；同名多残基 = NAG×2；异名多残基 = NAG+SO4 */
  label: string
}

export interface StructureData {
  id: string
  name: string
  format: 'pdb' | 'cif'
  atoms: AtomData
  residues: Residue[]
  chains: Chain[]
  bonds: { a: Int32Array; b: Int32Array; count: number }
  atomResidue: Int32Array // 原子 → 残基索引
  atomChain: Int32Array   // 原子 → 链索引
  /** 配体分子列表（连通分量，按首残基升序稳定编号；水不在其中） */
  molecules: LigandMolecule[]
  /** 原子 → 配体分子索引（-1 = 非配体分子：聚合物/水） */
  atomMolecule: Int32Array
  meta: { title: string; method: string; resolution: number | null; pdbId: string | null }
  ssFromRecords: boolean
  hasHydrogens: boolean
  /** 逐原子溶剂可及面积（Shrake–Rupley，分析后填充；氢为 0）。用于 SASA 着色与统计 */
  sasa?: Float32Array
  /** NMR ensemble：多构象坐标帧（frames[0] 即初始坐标副本，长度与 atoms.positions 相同） */
  ensemble?: { frames: Float32Array[] }
  /** ensemble 来源标记：NMR 多模型（默认）/ morph 双构象插值 / multimorph 多态样条插值（UI 徽章区分显示） */
  ensembleKind?: 'nmr' | 'morph' | 'multimorph'
  /** multimorph 的构象态（样条结点）数 */
  ensembleKnots?: number
  /** 晶胞与空间群（CRYST1 / _cell）——对称伴侣与电子密度图计算用 */
  crystal?: CrystalInfo
  /** 空间哈希网格（用于 within 选择、近邻查询） */
  grid: SpatialGrid
  bbox: { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; radius: number }
}

// ---------- 空间哈希网格 ----------

export class SpatialGrid {
  cell: number
  private map = new Map<number, number[]>()
  private minIx = 0; private minIy = 0; private minIz = 0
  private maxIx = 0; private maxIy = 0; private maxIz = 0

  constructor(positions: Float32Array, count: number, cell = 6) {
    this.cell = cell
    if (count > 0) {
      this.minIx = this.maxIx = this.ix(positions[0])
      this.minIy = this.maxIy = this.ix(positions[1])
      this.minIz = this.maxIz = this.ix(positions[2])
    }
    for (let i = 0; i < count; i++) {
      const ix = this.ix(positions[i * 3]), iy = this.ix(positions[i * 3 + 1]), iz = this.ix(positions[i * 3 + 2])
      if (ix < this.minIx) this.minIx = ix; if (ix > this.maxIx) this.maxIx = ix
      if (iy < this.minIy) this.minIy = iy; if (iy > this.maxIy) this.maxIy = iy
      if (iz < this.minIz) this.minIz = iz; if (iz > this.maxIz) this.maxIz = iz
      const key = this.key(ix, iy, iz)
      let arr = this.map.get(key)
      if (!arr) { arr = []; this.map.set(key, arr) }
      arr.push(i)
    }
  }

  private ix(v: number) { return Math.floor(v / this.cell) + 2048 }
  private key(ix: number, iy: number, iz: number) { return (ix << 20) | (iy << 10) | iz }

  /** 返回半径 r 内的原子索引（不保证排序） */
  query(x: number, y: number, z: number, r: number): number[] {
    const out: number[] = []
    const r2 = r * r
    const cx = this.ix(x), cy = this.ix(y), cz = this.ix(z)
    const span = Math.ceil(r / this.cell)
    for (let ix = cx - span; ix <= cx + span; ix++) {
      if (ix < this.minIx - 1 || ix > this.maxIx + 1) continue
      for (let iy = cy - span; iy <= cy + span; iy++) {
        if (iy < this.minIy - 1 || iy > this.maxIy + 1) continue
        for (let iz = cz - span; iz <= cz + span; iz++) {
          if (iz < this.minIz - 1 || iz > this.maxIz + 1) continue
          const arr = this.map.get(this.key(ix, iy, iz))
          if (!arr) continue
          out.push(...arr)
        }
      }
    }
    return out
  }

  /** query + 距离过滤（需要 positions） */
  queryRadius(x: number, y: number, z: number, r: number, positions: Float32Array): number[] {
    const cand = this.query(x, y, z, r)
    const out: number[] = []
    const r2 = r * r
    for (const i of cand) {
      const dx = positions[i * 3] - x, dy = positions[i * 3 + 1] - y, dz = positions[i * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(i)
    }
    return out
  }
}

// ---------- 解析入口 ----------

export function detectFormat(text: string, filename = ''): 'pdb' | 'cif' {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'cif'
  if (lower.endsWith('.pdb') || lower.endsWith('.ent')) return 'pdb'
  if (/^\s*(data_|#\w+_\w+.*\n.*_atom_site|loop_)/m.test(text) && !/^ATOM/m.test(text)) return 'cif'
  if (/^\s*data_/m.test(text)) return 'cif'
  return 'pdb'
}

export function parseStructure(text: string, name: string, format: 'pdb' | 'cif', id = ''): StructureData {
  return format === 'cif' ? parseCIF(text, name, id) : parsePDB(text, name, id)
}

// ---------- PDB 解析 ----------

function parsePDB(text: string, name: string, id = ''): StructureData {
  const lines = text.split(/\r?\n/)
  const x: number[] = [], y: number[] = [], z: number[] = []
  const serial: number[] = [], names: string[] = [], elements: string[] = [], resNames: string[] = []
  const resSeqs: number[] = [], iCodes: string[] = [], chainIds: string[] = []
  const bfactors: number[] = [], occupancies: number[] = [], heteroFlags: number[] = []
  const conects: number[][] = []
  const helixRanges: { chain: string; start: number; end: number; ic1: string; ic2: string }[] = []
  const sheetRanges: { chain: string; start: number; end: number; ic1: string; ic2: string }[] = []
  let title = ''
  let method = ''
  let resolution: number | null = null
  let pdbId: string | null = id || null
  let inFirstModel = true
  let seenModel = false
  // 晶胞（CRYST1）
  let crystal: CrystalInfo | null = null
  // NMR ensemble：非首 MODEL 的坐标缓冲
  let modelNo = 0
  let frameCoords: number[] | null = null
  const extraFrames: Float32Array[] = []

  for (const line of lines) {
    const rec = line.slice(0, 6)
    if (rec === 'ATOM  ' || rec === 'HETATM') {
      const het = rec === 'HETATM' ? 1 : 0
      const altLoc = line[16]
      if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '0') continue
      const px = parseFloat(line.slice(30, 38)) || 0
      const py = parseFloat(line.slice(38, 46)) || 0
      const pz = parseFloat(line.slice(46, 54)) || 0
      if (!inFirstModel) {
        // ensemble 帧：只收集坐标（原子序与首 model 一致时有效）
        if (frameCoords) frameCoords.push(px, py, pz)
        continue
      }
      const atomName = line.slice(12, 16)
      const resName = line.slice(17, 20).trim()
      const chainId = line[21] || ' '
      const resSeq = parseInt(line.slice(22, 26), 10) || 0
      const iCode = line[26] || ' '
      let el = line.slice(76, 78).trim().toUpperCase()
      if (!el) el = elementFromAtomName(atomName, het === 1)
      x.push(px)
      y.push(py)
      z.push(pz)
      serial.push(parseInt(line.slice(6, 11), 10) || 0)
      names.push(atomName.trim())
      elements.push(el)
      resNames.push(resName)
      resSeqs.push(resSeq)
      iCodes.push(iCode.trim())
      chainIds.push(chainId)
      occupancies.push(parseFloat(line.slice(54, 60)) || 1)
      bfactors.push(parseFloat(line.slice(60, 66)) || 0)
      heteroFlags.push(het)
    } else if (rec === 'MODEL ') {
      modelNo++
      if (seenModel) inFirstModel = false
      seenModel = true
      if (modelNo > 1) frameCoords = []
    } else if (rec === 'ENDMDL') {
      if (seenModel) inFirstModel = false
      if (frameCoords && frameCoords.length === x.length * 3) {
        extraFrames.push(new Float32Array(frameCoords))
      }
      frameCoords = null
    } else if (rec === 'TITLE ') {
      title += (title ? ' ' : '') + line.slice(10, 80).trim()
    } else if (rec === 'HEADER') {
      const cid = line.slice(62, 66).trim()
      if (cid && !pdbId) pdbId = cid
    } else if (rec === 'EXPDTA') {
      method += (method ? ' ' : '') + line.slice(10, 80).trim()
    } else if (rec === 'REMARK' && line.slice(6, 10) === '   2') {
      const m = line.match(/RESOLUTION\.\s+([0-9.]+)/)
      if (m) {
        const v = parseFloat(m[1])
        if (!isNaN(v)) resolution = v
      }
    } else if (rec === 'HELIX ') {
      // 列位（0-indexed，实测 RCSB 文件）：helixID 12-14 / initResName 15-17 /
      // initChainID 19 / initSeqNum 右对齐至 24 / iCode 25 / endResName 27-29 /
      // endChainID 31 / endSeqNum 右对齐至 36 / iCode 37
      helixRanges.push({
        chain: line[19] || ' ',
        start: parseInt(line.slice(21, 25), 10) || 0,
        end: parseInt(line.slice(33, 37), 10) || 0,
        ic1: (line[25] || ' ').trim(),
        ic2: (line[37] || ' ').trim(),
      })
    } else if (rec === 'SHEET ') {
      // 列位（0-indexed，实测 RCSB 文件）：sheetID 11-13 / numStrands 15 /
      // initResName 17-19 / initChainID 21 / initSeqNum 右对齐至 25 / iCode 26 /
      // endResName 28-30 / endChainID 32 / endSeqNum 右对齐至 36 / iCode 37
      sheetRanges.push({
        chain: line[21] || ' ',
        start: parseInt(line.slice(22, 26), 10) || 0,
        end: parseInt(line.slice(33, 37), 10) || 0,
        ic1: (line[26] || ' ').trim(),
        ic2: (line[37] || ' ').trim(),
      })
    } else if (rec === 'CRYST1') {
      crystal = parseCryst1(line)
    } else if (rec === 'CONECT') {
      const from = parseInt(line.slice(6, 11), 10)
      if (!from) continue
      for (let c = 11; c + 5 <= 80; c += 5) {
        const to = parseInt(line.slice(c, c + 5), 10)
        if (to) conects.push([from, to])
      }
    }
  }

  return buildStructure({
    name, format: 'pdb', pdbId, title: title || name, method, resolution,
    x, y, z, serial, names, elements, resNames, resSeqs, iCodes, chainIds,
    bfactors, occupancies, heteroFlags, conects, helixRanges, sheetRanges,
    extraFrames, crystal: crystal ?? undefined,
  })
}

// ---------- mmCIF 解析 ----------

function cifTokenizeLine(line: string): string[] | null {
  // 返回 token 列表；若行以 ';' 开头返回 null（多行文本）
  if (line.startsWith(';')) return null
  const tokens: string[] = []
  let i = 0
  const n = line.length
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++
    if (i >= n) break
    const ch = line[i]
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1)
      if (end === -1) { tokens.push(line.slice(i + 1)); break }
      tokens.push(line.slice(i + 1, end))
      i = end + 1
    } else {
      let j = i
      while (j < n && !/\s/.test(line[j])) j++
      tokens.push(line.slice(i, j))
      i = j
    }
  }
  return tokens
}

function parseCIF(text: string, name: string, id = ''): StructureData {
  const lines = text.split(/\r?\n/)
  const simple = new Map<string, string>()
  let title = '', method = '', resolution: number | null = null

  // 先扫非 loop 的简单键值
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (!line.startsWith('_')) continue
    if (line.startsWith('_atom_site')) continue
    const toks = cifTokenizeLine(line)
    if (!toks || toks.length < 2) continue
    const key = toks[0]
    let val = toks.slice(1).join(' ')
    if (val === '.' || val === '?') val = ''
    if (!simple.has(key)) simple.set(key, val)
  }
  title = simple.get('_struct.title') || ''
  method = simple.get('_exptl.method') || ''
  const resHigh = parseFloat(simple.get('_refine.ls_d_res_high') || '')
  if (!isNaN(resHigh) && resHigh > 0) resolution = resHigh
  if (resolution === null) {
    const em = parseFloat(simple.get('_em_3d_reconstruction.resolution') || '')
    if (!isNaN(em) && em > 0) resolution = em
  }
  // 晶胞与空间群（_cell / _symmetry 或 _space_group）
  const cellA = parseFloat(simple.get('_cell.length_a') || '')
  const cellB = parseFloat(simple.get('_cell.length_b') || '')
  const cellC = parseFloat(simple.get('_cell.length_c') || '')
  const cellAlpha = parseFloat(simple.get('_cell.angle_alpha') || '')
  const cellBeta = parseFloat(simple.get('_cell.angle_beta') || '')
  const cellGamma = parseFloat(simple.get('_cell.angle_gamma') || '')
  const spaceGroup = simple.get('_symmetry.space_group_name_H-M')
    || simple.get('_space_group.name_H-M_alt')
    || simple.get('_symmetry.space_group_name_H-M_alt')
    || ''
  const crystal: CrystalInfo | undefined = (!isNaN(cellA) && !isNaN(cellB) && !isNaN(cellC)
    && cellA > 0 && cellB > 0 && cellC > 0)
    ? {
      a: cellA, b: cellB, c: cellC,
      alpha: isNaN(cellAlpha) ? 90 : cellAlpha,
      beta: isNaN(cellBeta) ? 90 : cellBeta,
      gamma: isNaN(cellGamma) ? 90 : cellGamma,
      spaceGroup: spaceGroup.trim(),
    }
    : undefined

  // 找 _atom_site loop
  const x: number[] = [], y: number[] = [], z: number[] = []
  const serial: number[] = [], names: string[] = [], elements: string[] = [], resNames: string[] = []
  const resSeqs: number[] = [], iCodes: string[] = [], chainIds: string[] = []
  const bfactors: number[] = [], occupancies: number[] = [], heteroFlags: number[] = []
  const conects: number[][] = []
  const extraFrames: Float32Array[] = []

  for (let li = 0; li < lines.length; li++) {
    if (lines[li].trim() !== 'loop_') continue
    // 收集 tag 名
    const tags: string[] = []
    let lj = li + 1
    while (lj < lines.length && lines[lj].trim().startsWith('_')) {
      tags.push(lines[lj].trim().split(/\s+/)[0])
      lj++
    }
    if (!tags.includes('_atom_site.Cartn_x')) continue
    const col = (t: string) => tags.indexOf(t)
    const iGroup = col('_atom_site.group_PDB'), iName = col('_atom_site.label_atom_id')
    const iAlt = col('_atom_site.label_alt_id'), iResName = col('_atom_site.label_comp_id')
    const iAuthAsym = col('_atom_site.auth_asym_id'), iLabelAsym = col('_atom_site.label_asym_id')
    const iAuthSeq = col('_atom_site.auth_seq_id'), iLabelSeq = col('_atom_site.label_seq_id')
    const iIns = col('_atom_site.pdbx_PDB_ins_code')
    const iX = col('_atom_site.Cartn_x'), iY = col('_atom_site.Cartn_y'), iZ = col('_atom_site.Cartn_z')
    const iOcc = col('_atom_site.occupancy'), iB = col('_atom_site.B_iso_or_equiv')
    const iEl = col('_atom_site.type_symbol'), iModel = col('_atom_site.pdbx_PDB_model_num')
    const iSerial = col('_atom_site.id')
    const nCol = tags.length
    let rowIdx = 0
    // NMR ensemble：按 model num 分组缓冲额外帧坐标
    const cifFrames = new Map<number, number[]>()
    while (lj < lines.length) {
      const line = lines[lj]
      const t = line.trim()
      if (t === '' || t.startsWith('#') || t.startsWith('loop_') || t.startsWith('data_') || t.startsWith('stop_') || t.startsWith('save_') || t.startsWith('_')) break
      const toks = cifTokenizeLine(line)
      if (!toks || toks.length < nCol) { lj++; break }
      const alt = iAlt >= 0 ? toks[iAlt] : '.'
      if (alt !== '.' && alt !== '?' && alt !== 'A') { lj++; rowIdx++; continue }
      const model = iModel >= 0 ? toks[iModel] : '1'
      const modelNum = (model === '.' || model === '?') ? 1 : (parseInt(model, 10) || 1)
      if (modelNum > 1) {
        // ensemble 帧：只收集坐标（原子序与首 model 一致时有效）
        let buf = cifFrames.get(modelNum)
        if (!buf) { buf = []; cifFrames.set(modelNum, buf) }
        buf.push(parseFloat(toks[iX]) || 0, parseFloat(toks[iY]) || 0, parseFloat(toks[iZ]) || 0)
        lj++; rowIdx++; continue
      }
      const group = iGroup >= 0 ? toks[iGroup] : 'ATOM'
      const het = group.toUpperCase().startsWith('HETATM') ? 1 : 0
      const atomName = (iName >= 0 ? toks[iName] : '').replace(/"/g, '')
      const resName = (iResName >= 0 ? toks[iResName] : '').replace(/"/g, '')
      const chainId = (iAuthAsym >= 0 && toks[iAuthAsym] !== '.' && toks[iAuthAsym] !== '?'
        ? toks[iAuthAsym] : (iLabelAsym >= 0 ? toks[iLabelAsym] : ' ')).replace(/"/g, '') || ' '
      let resSeq = iAuthSeq >= 0 ? parseInt(toks[iAuthSeq], 10) : NaN
      if (isNaN(resSeq)) resSeq = iLabelSeq >= 0 ? (parseInt(toks[iLabelSeq], 10) || 0) : 0
      let iCode = iIns >= 0 ? toks[iIns] : '?'
      if (iCode === '.' || iCode === '?') iCode = ''
      let el = (iEl >= 0 ? toks[iEl] : '').replace(/"/g, '').toUpperCase()
      if (!el) el = elementFromAtomName(atomName, het === 1)
      x.push(parseFloat(toks[iX]) || 0)
      y.push(parseFloat(toks[iY]) || 0)
      z.push(parseFloat(toks[iZ]) || 0)
      serial.push(iSerial >= 0 ? (parseInt(toks[iSerial], 10) || 0) : rowIdx + 1)
      names.push(atomName)
      elements.push(el)
      resNames.push(resName)
      resSeqs.push(resSeq)
      iCodes.push(iCode)
      chainIds.push(chainId)
      occupancies.push(iOcc >= 0 ? (parseFloat(toks[iOcc]) || 1) : 1)
      bfactors.push(iB >= 0 ? (parseFloat(toks[iB]) || 0) : 0)
      heteroFlags.push(het)
      lj++; rowIdx++
    }
    // 收集 ensemble 帧（按 model num 排序，原子数一致才有效）
    for (const mnum of [...cifFrames.keys()].sort((a, b) => a - b)) {
      const buf = cifFrames.get(mnum)!
      if (buf.length === x.length * 3) extraFrames.push(new Float32Array(buf))
    }
    // 跳到 loop 之后
    li = lj - 1
  }

  return buildStructure({
    name, format: 'cif', pdbId: id || null, title: title || name, method, resolution,
    x, y, z, serial, names, elements, resNames, resSeqs, iCodes, chainIds,
    bfactors, occupancies, heteroFlags, conects: [], helixRanges: [], sheetRanges: [],
    extraFrames, crystal,
  })
}

// ---------- 通用组装：残基/链/键/SS ----------

interface RawAtoms {
  name: string; format: 'pdb' | 'cif'; pdbId: string | null; title: string; method: string
  resolution: number | null
  x: number[]; y: number[]; z: number[]; serial: number[]; names: string[]; elements: string[]
  resNames: string[]; resSeqs: number[]; iCodes: string[]; chainIds: string[]
  bfactors: number[]; occupancies: number[]; heteroFlags: number[]
  conects: number[][]
  helixRanges: { chain: string; start: number; end: number; ic1: string; ic2: string }[]
  sheetRanges: { chain: string; start: number; end: number; ic1: string; ic2: string }[]
  /** NMR ensemble：非首 model 的额外坐标帧（每帧长度 = count*3） */
  extraFrames?: Float32Array[]
  /** 晶胞与空间群（CRYST1 / _cell） */
  crystal?: CrystalInfo
}

function buildStructure(raw: RawAtoms): StructureData {
  const count = raw.x.length
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = raw.x[i]; positions[i * 3 + 1] = raw.y[i]; positions[i * 3 + 2] = raw.z[i]
  }
  const atoms: AtomData = {
    count,
    positions,
    serial: Int32Array.from(raw.serial),
    names: raw.names,
    elements: raw.elements,
    resNames: raw.resNames,
    resSeqs: Int32Array.from(raw.resSeqs),
    iCodes: raw.iCodes,
    chainIds: raw.chainIds,
    bfactors: Float32Array.from(raw.bfactors),
    occupancies: Float32Array.from(raw.occupancies),
    hetero: Uint8Array.from(raw.heteroFlags),
  }

  // ---- 残基分组（连续相同 chain/resSeq/iCode/resName）----
  const residues: Residue[] = []
  const atomResidue = new Int32Array(count)
  let cur: Residue | null = null
  for (let i = 0; i < count; i++) {
    const chainId = atoms.chainIds[i]
    const resSeq = atoms.resSeqs[i]
    const iCode = atoms.iCodes[i]
    const resName = atoms.resNames[i]
    if (!cur || cur.chainId !== chainId || cur.resSeq !== resSeq || cur.iCode !== iCode || cur.resName !== resName) {
      const upper = resName.toUpperCase()
      const isAA = AMINO_ACIDS.has(upper)
      const isNA = NUCLEIC_ACIDS.has(upper)
      const isWater = WATERS.has(upper)
      cur = {
        chainId, resSeq, iCode, resName,
        start: i, end: i + 1,
        ss: 'L',
        polymer: isAA || isNA || (!atoms.hetero[i] && !isWater),
        water: isWater,
        hetero: atoms.hetero[i] === 1,
      }
      residues.push(cur)
    } else {
      cur.end = i + 1
    }
    atomResidue[i] = residues.length - 1
  }

  // ---- 病态防护：残基逐原子裂变检查（在下游 DSSP/键推断/渲染爆炸前拦截） ----
  if (residues.length > MAX_RESIDUES) {
    throw new Error(tt({
      zh: `残基数量超出上限（${residues.length.toLocaleString()} > ${MAX_RESIDUES.toLocaleString()}）：文件疑似损坏（resSeq 非连续致每原子裂变为独立残基），已拒绝加载`,
      en: `Residue count exceeds the limit (${residues.length.toLocaleString()} > ${MAX_RESIDUES.toLocaleString()}): the file looks corrupted (non-contiguous resSeq split every atom into its own residue) — loading rejected`,
    }))
  }

  // ---- 链分组（连续相同 chainId 的残基） ----
  const chains: Chain[] = []
  const atomChain = new Int32Array(count)
  let curChain: Chain | null = null
  for (let ri = 0; ri < residues.length; ri++) {
    const r = residues[ri]
    if (!curChain || curChain.id !== r.chainId) {
      curChain = { id: r.chainId, type: 'ligand', start: r.start, end: r.end, residueIdx: [] }
      chains.push(curChain)
    }
    curChain.end = r.end
    curChain.residueIdx.push(ri)
  }
  // 链类型判定（水残基不参与聚合物类型投票——同链蛋白+大量晶体水不应被稀释成 ligand）
  for (const ch of chains) {
    let aa = 0, na = 0, water = 0, other = 0
    for (const ri of ch.residueIdx) {
      const r = residues[ri]
      if (AMINO_ACIDS.has(r.resName.toUpperCase())) aa++
      else if (NUCLEIC_ACIDS.has(r.resName.toUpperCase())) na++
      else if (r.water) water++
      else other++
    }
    const polymerTotal = aa + na + other
    if (water > 0 && polymerTotal === 0) ch.type = 'water'
    else if (aa >= na && aa / Math.max(1, polymerTotal) > 0.5) ch.type = 'protein'
    else if (na > aa && na / Math.max(1, polymerTotal) > 0.3) ch.type = 'nucleic'
    else ch.type = 'ligand'
  }
  // 原子 → 链索引（残基按链顺序分布）
  {
    const resChain = new Int32Array(residues.length)
    for (let k = 0; k < chains.length; k++) {
      for (const ri of chains[k].residueIdx) resChain[ri] = k
    }
    for (let i = 0; i < count; i++) atomChain[i] = resChain[atomResidue[i]]
  }

  // ---- 二级结构：记录优先，DSSP 兜底（需网格，在网格构建后执行）----
  const ssFromRecords = raw.helixRanges.length + raw.sheetRanges.length > 0
  if (ssFromRecords) {
    const mark = (ranges: { chain: string; start: number; end: number; ic1: string; ic2: string }[], type: SSType) => {
      for (const rg of ranges) {
        for (const r of residues) {
          if (r.chainId !== rg.chain) continue
          const sameIc = (a: string, b: string) => (a || '') === (b || '')
          if (r.resSeq >= rg.start && r.resSeq <= rg.end) {
            // 插入码粗匹配：首末残基容忍
            r.ss = type
          } else if (r.resSeq === rg.start && sameIc(r.iCode, rg.ic1)) {
            r.ss = type
          }
        }
      }
    }
    mark(raw.helixRanges, 'H')
    mark(raw.sheetRanges, 'E')
  }

  // ---- 化学键 ----
  const bonds = computeBonds(atoms, residues, atomResidue, chains, raw.conects)

  // ---- 网格 & 包围盒 ----
  const grid = new SpatialGrid(positions, count, 6)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) {
      const v = positions[i * 3 + d]
      if (v < min[d]) min[d] = v
      if (v > max[d]) max[d] = v
    }
  }
  if (count === 0) { min[0] = min[1] = min[2] = -1; max[0] = max[1] = max[2] = 1 }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ]
  const radius = Math.max(1, 0.5 * Math.sqrt(
    (max[0] - min[0]) ** 2 + (max[1] - min[1]) ** 2 + (max[2] - min[2]) ** 2,
  ))

  let hasHydrogens = false
  for (let i = 0; i < count; i++) {
    const e = atoms.elements[i]
    if (e === 'H' || e === 'D') { hasHydrogens = true; break }
  }

  // ---- 配体分子（连通分量）----
  // 分子 = 非聚合物异源残基经化学键（含 CONECT）或重原子近距离（≤2.45Å，共价键范围）连通的分量；
  // 水不参与（单个水残基本身就是完整分子，保持残基级选择即可）。
  // 用途：点击配体 → 选中整个分子而非整个链组；多残基配体（多糖/肽类抑制剂）作为一个整体。
  const molecules: LigandMolecule[] = []
  const atomMolecule = new Int32Array(count).fill(-1)
  {
    const ligandRes = new Set<number>()
    for (let ri = 0; ri < residues.length; ri++) {
      const r = residues[ri]
      if (r.hetero && !r.polymer && !r.water) ligandRes.add(ri)
    }
    if (ligandRes.size > 0) {
      // 并查集（残基级）
      const parent = new Map<number, number>()
      for (const ri of ligandRes) parent.set(ri, ri)
      const find = (x: number): number => {
        let p = parent.get(x)!
        while (p !== parent.get(p)!) p = parent.get(p)!
        parent.set(x, p)
        return p
      }
      const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b)
        if (ra !== rb) parent.set(ra, rb)
      }
      // ① 化学键连通（含 CONECT 注释键；跨链也认可——CONECT 是权威连接记录）
      for (let bi = 0; bi < bonds.count; bi++) {
        const ra = atomResidue[bonds.a[bi]], rb = atomResidue[bonds.b[bi]]
        if (ra !== rb && ligandRes.has(ra) && ligandRes.has(rb)) union(ra, rb)
      }
      // ② 重原子近距离连通（补齐距离成键的分子内残基；不跨链，防晶体堆积误连）
      //    阈值 2.45Å：覆盖最长共价键（S-S 2.05 / 金属-配体 ~2.3），非键重原子接触通常 ≥ 2.7Å
      for (const ri of ligandRes) {
        const r = residues[ri]
        for (let i = r.start; i < r.end; i++) {
          const e = atoms.elements[i]
          if (e === 'H' || e === 'D') continue // 氢原子近距离是氢键非共价
          const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2]
          const cand = grid.queryRadius(xi, yi, zi, 2.45, positions)
          for (const j of cand) {
            const rj = atomResidue[j]
            if (rj === ri || !ligandRes.has(rj)) continue // 同残基 / 非配体残基
            if (atoms.chainIds[j] !== atoms.chainIds[i]) continue
            const ej = atoms.elements[j]
            if (ej === 'H' || ej === 'D') continue
            union(ri, rj)
          }
        }
      }
      // ③ 分量收集 + 稳定编号（按首残基升序）
      const groups = new Map<number, number[]>()
      for (const ri of ligandRes) {
        const root = find(ri)
        let arr = groups.get(root)
        if (!arr) { arr = []; groups.set(root, arr) }
        arr.push(ri)
      }
      const ordered = [...groups.values()].sort((a, b) => a[0] - b[0])
      for (const resList of ordered) {
        resList.sort((a, b) => a - b)
        const resNames: string[] = []
        const chainIds: string[] = []
        let atomCount = 0
        for (const ri of resList) {
          const r = residues[ri]
          atomCount += r.end - r.start
          if (!resNames.includes(r.resName.toUpperCase())) resNames.push(r.resName.toUpperCase())
          if (!chainIds.includes(r.chainId)) chainIds.push(r.chainId)
          for (let i = r.start; i < r.end; i++) atomMolecule[i] = molecules.length
        }
        const label = resNames.length === 1
          ? (resList.length > 1 ? `${resNames[0]}×${resList.length}` : resNames[0])
          : resNames.join('+')
        molecules.push({ residues: resList, atoms: atomCount, resNames, chainIds, label })
      }
    }
  }

  // 无 HELIX/SHEET 记录：DSSP 兜底（Kabsch–Sander 氢键能量指认螺旋/折叠，
  // 取代旧 CA 间距启发式——旧方法无法检测 β 折叠）
  if (!ssFromRecords) {
    const partial = {
      id: '', name: raw.name, format: raw.format, atoms, residues, chains, bonds,
      atomResidue, atomChain,
      meta: { title: raw.title || raw.name, method: raw.method, resolution: raw.resolution, pdbId: raw.pdbId },
      ssFromRecords: false, hasHydrogens,
      grid, bbox: { min, max, center, radius },
    } as unknown as StructureData
    try {
      const dssp = computeDSSP(partial)
      for (let ri = 0; ri < residues.length; ri++) {
        residues[ri].ss = dssp.ss[ri] === 1 ? 'H' : dssp.ss[ri] === 2 ? 'E' : 'L'
      }
    } catch { /* DSSP 失败时保持 loop，不影响加载 */ }
  }

  // NMR ensemble：初始坐标副本 + 额外帧（至少 2 帧才启用）
  let ensemble: StructureData['ensemble'] | undefined
  if (raw.extraFrames && raw.extraFrames.length >= 1 && raw.extraFrames.every(f => f.length === count * 3)) {
    ensemble = { frames: [positions.slice(), ...raw.extraFrames] }
  }

  return {
    id: '',
    name: raw.name,
    format: raw.format,
    atoms,
    residues,
    chains,
    bonds,
    atomResidue,
    atomChain,
    molecules,
    atomMolecule,
    meta: {
      title: raw.title || raw.name,
      method: raw.method,
      resolution: raw.resolution,
      pdbId: raw.pdbId,
    },
    ssFromRecords,
    hasHydrogens,
    ensemble,
    crystal: raw.crystal,
    grid,
    bbox: { min, max, center, radius },
  }
}

// ---------- 子集构建（create / split_chains / save 命令共用） ----------

/**
 * 从已有结构抽取原子子集，构建一个新的独立 StructureData。
 * 残基/链/键重新推导（键按距离重算），二级结构按 (chain,resSeq,iCode,resName) 匹配从源复制，
 * 晶胞信息原样传递；ensemble/SASA 不保留。
 */
export function subsetStructure(src: StructureData, indices: readonly number[], name: string): StructureData {
  const uniq = [...new Set(indices)].sort((a, b) => a - b)
  if (!uniq.length) throw new Error(tt({ zh: '选择为空，无法创建子结构', en: 'Selection is empty — cannot create a sub-structure' }))
  if (uniq.some(i => i < 0 || i >= src.atoms.count)) throw new Error(tt({ zh: '原子索引越界', en: 'Atom index out of range' }))
  const a = src.atoms
  const x: number[] = [], y: number[] = [], z: number[] = []
  const serial: number[] = [], names: string[] = [], elements: string[] = [], resNames: string[] = []
  const resSeqs: number[] = [], iCodes: string[] = [], chainIds: string[] = []
  const bfactors: number[] = [], occupancies: number[] = [], heteroFlags: number[] = []
  for (const i of uniq) {
    x.push(a.positions[i * 3]); y.push(a.positions[i * 3 + 1]); z.push(a.positions[i * 3 + 2])
    serial.push(a.serial[i]); names.push(a.names[i]); elements.push(a.elements[i])
    resNames.push(a.resNames[i]); resSeqs.push(a.resSeqs[i]); iCodes.push(a.iCodes[i])
    chainIds.push(a.chainIds[i]); bfactors.push(a.bfactors[i]); occupancies.push(a.occupancies[i])
    heteroFlags.push(a.hetero[i])
  }
  const out = buildStructure({
    name, format: src.format, pdbId: src.meta.pdbId,
    title: tt({ zh: `${src.meta.title} — 子集 ${uniq.length}`, en: `${src.meta.title} — subset ${uniq.length}` }), method: '', resolution: null,
    x, y, z, serial, names, elements, resNames, resSeqs, iCodes, chainIds,
    bfactors, occupancies, heteroFlags,
    conects: [], helixRanges: [], sheetRanges: [],
    extraFrames: [], crystal: src.crystal,
  })
  // 二级结构从源复制（按残基标识匹配；subset 无 SS 记录 → 兜底 DSSP 已跑过但可能噪声）
  const resKey = (chainId: string, resSeq: number, iCode: string, resName: string) =>
    `${chainId}|${resSeq}|${iCode}|${resName.toUpperCase()}`
  const srcSS = new Map<string, SSType>()
  for (const r of src.residues) {
    const k = resKey(r.chainId, r.resSeq, r.iCode, r.resName)
    if (!srcSS.has(k)) srcSS.set(k, r.ss)
  }
  let copied = 0
  for (const r of out.residues) {
    const ss = srcSS.get(resKey(r.chainId, r.resSeq, r.iCode, r.resName))
    if (ss) { r.ss = ss; copied++ }
  }
  if (copied > 0) out.ssFromRecords = true
  return out
}

function computeBonds(
  atoms: AtomData, residues: Residue[], atomResidue: Int32Array, chains: Chain[],
  conects: number[][],
): { a: Int32Array; b: Int32Array; count: number } {
  const n = atoms.count
  const positions = atoms.positions
  const cov = new Float32Array(n)
  const isH = new Uint8Array(n)
  const isWaterAtom = new Uint8Array(n)
  const bondable = new Uint8Array(n) // 允许距离成键的原子（非水）
  for (let i = 0; i < n; i++) {
    cov[i] = elementInfo(atoms.elements[i]).cov
    const e = atoms.elements[i]
    if (e === 'H' || e === 'D') isH[i] = 1
    const resName = atoms.resNames[i].toUpperCase()
    isWaterAtom[i] = WATERS.has(resName) ? 1 : 0
    // 键合资格：聚合物残基 或 糖类 或 普通非水 HETATM（配体内成键）
    const ri = atomResidue[i]
    const r = residues[ri]
    const sugar = SUGAR_LIKE.has(resName)
    bondable[i] = (!isWaterAtom[i] && (r.polymer || sugar || r.hetero)) ? 1 : 0
  }

  const grid = new SpatialGrid(positions, n, 5)
  const pairsA: number[] = []
  const pairsB: number[] = []
  const added = new Set<number>() // key = a*n+b (a<b)
  // 病态防护（r67）：键数硬封顶——乱坐标（全部原子挤在近邻距离内）会让候选对
  // 接近 n²，未封顶时 Set/数组先吃光内存再靠 V8 Set 上限报错。超限抛双语错误，
  // 由调用方 catch 后经 toast 直达用户（真实蛋白约 1.3 键/原子，12× 因子极宽裕）。
  const bondCap = n * MAX_BONDS_PER_ATOM + 1024

  const addBond = (a: number, b: number) => {
    if (a === b) return
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const key = lo * n + hi
    if (added.has(key)) return
    if (pairsA.length >= bondCap) {
      throw new Error(tt({
        zh: `化学键数超出上限（≥${bondCap.toLocaleString()}）：坐标异常（原子挤在成键距离内），已拒绝加载`,
        en: `Bond count exceeds the limit (≥${bondCap.toLocaleString()}): coordinates are abnormal (atoms packed within bonding distance) — loading rejected`,
      }))
    }
    added.add(key)
    pairsA.push(lo); pairsB.push(hi)
  }

  for (let i = 0; i < n; i++) {
    if (!bondable[i]) continue
    const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2]
    const maxR = cov[i] + 1.1 + 0.45
    const cand = grid.queryRadius(xi, yi, zi, Math.min(maxR + 1.2, 5), positions)
    for (const j of cand) {
      if (j <= i || !bondable[j]) continue
      const dx = positions[j * 3] - xi, dy = positions[j * 3 + 1] - yi, dz = positions[j * 3 + 2] - zi
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < 0.16) continue // 0.4 Å 以内视为重合
      const cutoff = cov[i] + cov[j] + 0.45
      if (d2 > cutoff * cutoff) {
        // 二硫键特例：S-S < 2.5
        const bothS = atoms.elements[i] === 'S' && atoms.elements[j] === 'S'
        if (bothS && d2 < 6.25 && atoms.resNames[i] === 'CYS' && atoms.resNames[j] === 'CYS') {
          addBond(i, j)
        }
        continue
      }
      // 氢只与其最近的重原子成键
      if (isH[i] || isH[j]) {
        if (isH[i] && isH[j]) continue
        if (d2 > 1.35 * 1.35) continue
        addBond(i, j)
        continue
      }
      // 跨残基限制：同残基 or 同链且均为聚合物
      const ri = atomResidue[i], rj = atomResidue[j]
      if (ri === rj) { addBond(i, j); continue }
      const sameChain = atoms.chainIds[i] === atoms.chainIds[j]
      const bothPoly = residues[ri].polymer && residues[rj].polymer
      const bothSugarOrPoly = (residues[ri].polymer || SUGAR_LIKE.has(atoms.resNames[i].toUpperCase())) &&
        (residues[rj].polymer || SUGAR_LIKE.has(atoms.resNames[j].toUpperCase()))
      if (sameChain && (bothPoly || bothSugarOrPoly)) {
        // 相邻残基编号才允许（避免远距离误连）
        const seqDiff = Math.abs(atoms.resSeqs[i] - atoms.resSeqs[j])
        if (seqDiff <= 1 || bothSugarOrPoly) addBond(i, j)
      }
    }
  }

  // CONECT 补充（含金属配位、二硫键等注释键）
  if (conects.length) {
    const serialMap = new Map<number, number>()
    for (let i = 0; i < n; i++) serialMap.set(atoms.serial[i], i)
    for (const [from, to] of conects) {
      const a = serialMap.get(from), b = serialMap.get(to)
      if (a !== undefined && b !== undefined) {
        const dx = positions[a * 3] - positions[b * 3]
        const dy = positions[a * 3 + 1] - positions[b * 3 + 1]
        const dz = positions[a * 3 + 2] - positions[b * 3 + 2]
        if (dx * dx + dy * dy + dz * dz < 64) addBond(a, b) // 8 Å 内才有效
      }
    }
  }

  return {
    a: Int32Array.from(pairsA),
    b: Int32Array.from(pairsB),
    count: pairsA.length,
  }
}
