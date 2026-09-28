// PDB 文本导出：StructureData → ATOM/HETATM/CRYST1 记录（save 命令 / create 对象的会话持久化共用）
// 坐标取 data.atoms.positions 当前值（即世界坐标——superpose 变换已烘焙）
import type { StructureData } from './parser'

const padL = (v: string, w: number) => v.slice(0, w).padEnd(w)
const padR = (v: string | number, w: number) => String(v).slice(0, w).padStart(w)
const fmt = (v: number, w: number, d = 3) => (isNaN(v) ? '0' : v.toFixed(d)).padStart(w).slice(0, w)

/** 原子名 4 列格式：单字母元素从第 13 列起（' CA '），双字母元素从第 12 列起（'FE  '） */
function atomNameField(name: string, element: string): string {
  let n = name.slice(0, 4)
  if (n.length >= 4) return n
  const two = element.trim().length >= 2
  if (!two) n = ' ' + n
  return n.padEnd(4).slice(0, 4)
}

/**
 * 将结构导出为 PDB 文本。
 * 包含 CRYST1（有晶胞时）/ TITLE / ATOM / HETATM / TER / END。
 */
export function structureToPdbText(data: StructureData): string {
  const lines: string[] = []
  const title = (data.meta.title || data.name || '').replace(/\s+/g, ' ').trim()
  if (title) {
    // TITLE 续行（每行 70 字符，列 9-80）
    const chunks = title.match(/.{1,70}/g) ?? []
    chunks.forEach((chunk, i) => {
      lines.push(`TITLE    ${i + 1 > 1 ? String(i + 1).padStart(2) + ' ' : '  '}${chunk}`)
    })
  }
  if (data.crystal) {
    const c = data.crystal
    const sg = padL((c.spaceGroup || 'P 1').trim() || 'P 1', 11)
    lines.push(
      `CRYST1${fmt(c.a, 9)}${fmt(c.b, 9)}${fmt(c.c, 9)}${fmt(c.alpha, 7, 2)}${fmt(c.beta, 7, 2)}${fmt(c.gamma, 7, 2)} ${sg}          1`,
    )
  }
  if (data.meta.pdbId) lines.push(`HEADER    MOLECULE NAME             ${data.meta.pdbId}`)
  const a = data.atoms
  let serial = 0
  let prevChain: string | null = null
  let prevRes: { resName: string; resSeq: number; iCode: string } | null = null
  const linesOut: string[] = []
  for (let i = 0; i < a.count; i++) {
    const chain = (a.chainIds[i] || ' ').slice(0, 1)
    // 换链 → TER
    if (prevChain !== null && chain !== prevChain && prevRes) {
      serial = (serial + 1) % 100000
      linesOut.push(`TER   ${padR(serial, 5)}      ${padL(prevRes.resName.slice(0, 3), 3)} ${prevChain}${padR(prevRes.resSeq, 4)}${prevRes.iCode ? prevRes.iCode.slice(0, 1) : ' '}`)
    }
    prevChain = chain
    const res = prevRes = { resName: a.resNames[i] || 'UNK', resSeq: a.resSeqs[i], iCode: a.iCodes[i] || '' }
    serial = (serial + 1) % 100000
    const name = atomNameField(a.names[i] || 'X', a.elements[i] || 'X')
    const elem = (a.elements[i] || 'X').toUpperCase().padStart(2).slice(0, 2)
    const line =
      `${a.hetero[i] ? 'HETATM' : 'ATOM  '}${padR(serial, 5)} ${name} ` +
      `${padL(res.resName.slice(0, 3), 3)} ${chain}${padR(res.resSeq, 4)}${res.iCode ? res.iCode.slice(0, 1) : ' '}   ` +
      `${fmt(a.positions[i * 3], 8)}${fmt(a.positions[i * 3 + 1], 8)}${fmt(a.positions[i * 3 + 2], 8)}` +
      `${fmt(a.occupancies[i] ?? 1, 6, 2)}${fmt(a.bfactors[i] ?? 0, 6, 2)}          ${elem}  `
    linesOut.push(line)
  }
  if (prevChain !== null && prevRes) {
    serial = (serial + 1) % 100000
    linesOut.push(`TER   ${padR(serial, 5)}      ${padL(prevRes.resName.slice(0, 3), 3)} ${prevChain}${padR(prevRes.resSeq, 4)}${prevRes.iCode ? prevRes.iCode.slice(0, 1) : ' '}`)
  }
  linesOut.push('END')
  return [...lines, ...linesOut].join('\n') + '\n'
}
