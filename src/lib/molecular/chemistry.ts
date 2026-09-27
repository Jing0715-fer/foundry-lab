// 化学数据：元素信息（vdW/共价半径、CPK 颜色、金属标记）、残基分类、核酸信息

export interface ElementInfo {
  /** CPK / Jmol 风格颜色 */
  color: string;
  /** vdW 半径 (Å) */
  vdw: number;
  /** 共价半径 (Å) */
  cov: number;
  metal: boolean;
}

const D: Record<string, [string, number, number, number]> = {
  // symbol: [hex, vdw, cov, metal?1:0]
  H: ['#f0f0f0', 1.1, 0.31, 0],
  D: ['#f0f0f0', 1.1, 0.31, 0],
  HE: ['#d9ffff', 1.4, 0.28, 0],
  LI: ['#cc80ff', 1.82, 1.28, 1],
  BE: ['#c2ff00', 1.53, 0.96, 1],
  B: ['#ffb5b5', 1.92, 0.84, 0],
  C: ['#909090', 1.7, 0.76, 0],
  N: ['#3050f8', 1.55, 0.71, 0],
  O: ['#ff0d0d', 1.52, 0.66, 0],
  F: ['#90e050', 1.47, 0.57, 0],
  NE: ['#b3e3f5', 1.54, 0.58, 0],
  NA: ['#ab5cf2', 2.27, 1.66, 1],
  MG: ['#8aff00', 1.73, 1.41, 1],
  AL: ['#bfa6a6', 1.84, 1.21, 1],
  SI: ['#f0c8a0', 2.1, 1.11, 0],
  P: ['#ff8000', 1.8, 1.07, 0],
  S: ['#ffff30', 1.8, 1.05, 0],
  CL: ['#1ff01f', 1.75, 1.02, 0],
  AR: ['#80d1e3', 1.88, 1.06, 0],
  K: ['#8f40d4', 2.75, 2.03, 1],
  CA: ['#3dff00', 2.31, 1.76, 1],
  TI: ['#bfc2c7', 1.76, 1.6, 1],
  V: ['#a6a6ab', 1.76, 1.53, 1],
  CR: ['#8a99c7', 1.76, 1.39, 1],
  MN: ['#9c7ac7', 1.76, 1.39, 1],
  FE: ['#e06633', 2.0, 1.32, 1],
  CO: ['#f090a0', 1.76, 1.26, 1],
  NI: ['#50d050', 1.63, 1.24, 1],
  CU: ['#c88033', 1.4, 1.32, 1],
  ZN: ['#7d80b0', 1.39, 1.22, 1],
  GA: ['#c28f8f', 1.87, 1.22, 1],
  GE: ['#668f8f', 2.11, 1.2, 1],
  AS: ['#bd80e3', 1.85, 1.19, 0],
  SE: ['#ffa100', 1.9, 1.2, 0],
  BR: ['#a62929', 1.85, 1.2, 0],
  KR: ['#5cb8d1', 2.02, 1.16, 0],
  RB: ['#708b90', 3.03, 2.2, 1],
  SR: ['#00ff00', 2.49, 1.95, 1],
  Y: ['#94ffff', 1.76, 1.9, 1],
  ZR: ['#94e0e0', 1.76, 1.75, 1],
  NB: ['#73c2c9', 1.76, 1.64, 1],
  MO: ['#54b5b5', 2.0, 1.45, 1],
  TC: ['#3b9e9e', 1.76, 1.56, 1],
  RU: ['#248f8f', 1.76, 1.6, 1],
  RH: ['#0a7d8c', 1.76, 1.42, 1],
  PD: ['#006985', 1.63, 1.39, 1],
  AG: ['#c0c0c0', 1.72, 1.45, 1],
  CD: ['#ffd98f', 1.58, 1.44, 1],
  IN: ['#a67573', 1.93, 1.42, 1],
  SN: ['#668080', 2.17, 1.39, 1],
  SB: ['#9e63b5', 2.06, 1.39, 1],
  TE: ['#d47a00', 2.06, 1.38, 1],
  I: ['#940094', 1.98, 1.39, 0],
  XE: ['#429eb0', 2.16, 1.4, 0],
  CS: ['#57178f', 3.43, 2.44, 1],
  BA: ['#00c900', 2.68, 2.15, 1],
  LA: ['#70d5ff', 1.87, 2.07, 1],
  CE: ['#ffffc7', 1.82, 2.04, 1],
  HF: ['#99ccca', 1.76, 1.75, 1],
  TA: ['#99ccca', 1.76, 1.7, 1],
  W: ['#b999b9', 1.76, 1.62, 1],
  RE: ['#9e9eb9', 1.76, 1.59, 1],
  OS: ['#7e9eb9', 1.76, 1.44, 1],
  IR: ['#63789a', 1.76, 1.41, 1],
  PT: ['#d0d0e0', 1.75, 1.36, 1],
  AU: ['#ffd123', 1.66, 1.36, 1],
  HG: ['#b8b8d0', 1.55, 1.32, 1],
  TL: ['#a65487', 1.96, 1.45, 1],
  PB: ['#575961', 2.02, 1.46, 1],
  BI: ['#9e4fb5', 2.07, 1.48, 1],
  U: ['#00835c', 1.86, 1.7, 1],
}

export const ELEMENTS: Record<string, ElementInfo> = Object.fromEntries(
  Object.entries(D).map(([k, [color, vdw, cov, metal]]) => [
    k,
    { color, vdw, cov, metal: metal === 1 },
  ]),
)

export const DEFAULT_ELEMENT: ElementInfo = {
  color: '#dd77bb',
  vdw: 1.6,
  cov: 1.2,
  metal: false,
}

export function elementInfo(sym: string): ElementInfo {
  return ELEMENTS[sym.toUpperCase()] ?? DEFAULT_ELEMENT
}

/** 从 PDB 原子名推断元素符号（element 列缺失时） */
export function elementFromAtomName(name: string, het: boolean): string {
  const raw = name.replace(/[^A-Za-z]/g, '')
  if (!raw) return 'C'
  // 原子名列右对齐规则：首字符为空格 → 单字母元素
  const nameStartsWithSpace = /^\s/.test(name) || name[0] === ' '
  if (!het && (nameStartsWithSpace || raw.length < 2)) {
    return raw[0].toUpperCase()
  }
  const two = raw.slice(0, 2).toUpperCase()
  if (ELEMENTS[two]) return two
  const one = raw[0].toUpperCase()
  if (ELEMENTS[one]) return one
  return two
}

// ---------- 残基分类 ----------

export const AMINO_ACIDS = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  // 非标准但属于聚合物
  'MSE', 'SEC', 'PYL', 'UNK', 'HYP', 'CSO', 'SEP', 'TPO', 'PTR', 'KCX',
  'LLP', 'MLY', 'MLZ', 'CAS', 'CSS', 'CSX', 'CSD', 'OCS', 'CSW', 'CYM',
  'HSD', 'HSE', 'HSP', 'ASH', 'GLH', 'LYN', 'ALY',
])

export const NUCLEIC_ACIDS = new Set([
  'A', 'C', 'G', 'T', 'U', 'DA', 'DC', 'DG', 'DT', 'DU',
  'RA', 'RC', 'RG', 'RU', 'ADE', 'CYT', 'GUA', 'THY', 'URA',
  'BRA', 'CFZ', 'C5M', '2MG', '5MC', 'H2U', 'PSU', 'UMP', 'CMP', 'AMP', 'GMP',
])

export const WATERS = new Set(['HOH', 'DOD', 'WAT', 'H2O', 'TIP3', 'SOL', 'TIP'])

/** 常见糖/糖链残基（HETATM 但需按聚合物方式成键） */
export const SUGAR_LIKE = new Set([
  'NAG', 'FUC', 'MAN', 'GAL', 'GLC', 'BMA', 'XYP', 'SIA', 'KDN', 'MLR',
  'NGC', 'AXP', 'A2G',
])

export type ResidueClass =
  | 'nonpolar' | 'polar' | 'positive' | 'negative' | 'aromatic'
  | 'cysteine' | 'proline' | 'glycine' | 'nucleic' | 'water' | 'ligand' | 'unknown'

const AA_CLASS: Record<string, ResidueClass> = {
  ALA: 'nonpolar', VAL: 'nonpolar', LEU: 'nonpolar', ILE: 'nonpolar', MET: 'nonpolar',
  MSE: 'nonpolar',
  SER: 'polar', THR: 'polar', ASN: 'polar', GLN: 'polar',
  LYS: 'positive', ARG: 'positive', HIS: 'positive',
  ASP: 'negative', GLU: 'negative',
  PHE: 'aromatic', TYR: 'aromatic', TRP: 'aromatic',
  CYS: 'cysteine', CSO: 'cysteine', CSS: 'cysteine', SEC: 'cysteine',
  PRO: 'proline',
  GLY: 'glycine',
}

export function residueClass(resName: string): ResidueClass {
  const r = resName.toUpperCase()
  if (AMINO_ACIDS.has(r)) return AA_CLASS[r] ?? 'unknown'
  if (NUCLEIC_ACIDS.has(r)) return 'nucleic'
  if (WATERS.has(r)) return 'water'
  if (r.length > 0) return 'ligand'
  return 'unknown'
}

/** 氨基酸单字母代码 */
export const AA_ONE_LETTER: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  MSE: 'M', SEC: 'U', PYL: 'O', UNK: 'X',
}

export const NA_ONE_LETTER: Record<string, string> = {
  A: 'A', DA: 'A', ADE: 'A', AMP: 'A', RA: 'A',
  C: 'C', DC: 'C', CYT: 'C', CMP: 'C', RC: 'C',
  G: 'G', DG: 'G', GUA: 'G', GMP: 'G', RG: 'G',
  T: 'T', DT: 'T', THY: 'T',
  U: 'U', DU: 'U', URA: 'U', UMP: 'U', RU: 'U',
}

export function residueOneLetter(resName: string): string {
  const r = resName.toUpperCase()
  return AA_ONE_LETTER[r] ?? NA_ONE_LETTER[r] ?? (r.length === 1 ? r : '·')
}

/** 主链原子 */
export const BACKBONE_ATOMS = new Set([
  'N', 'CA', 'C', 'O', 'OXT', "O5'", "C5'", "C4'", "C3'", "O3'", 'P', 'H', 'HA',
])
