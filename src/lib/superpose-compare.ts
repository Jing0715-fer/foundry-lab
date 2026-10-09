// Structural superposition comparison — the glue between the screening /
// sweep UIs and the molecular superposition core (parser + matchmaker).
//
// Pure module: no React, no DOM, no fetch. The caller hands in two PDB texts
// (reference FIRST — it stays put; the mobile structure is moved onto it)
// and gets back everything the overlay viewer renders:
//   - both CA backbone paths (mobile already rigid-transformed),
//   - per-residue deviation (Å) for every aligned pair (NaN on unmatched
//     mobile residues — they render neutral gray),
//   - chain ids, matched count, RMSD, alignment errors.
//
// Failure semantics: parsing problems and low-similarity structures return
// { ok: false, error } instead of throwing — the dialogs render the message.

import { parseStructure, type StructureData } from "@/lib/molecular/parser";
import {
  quatToMatrix,
  superposeStructures,
} from "@/lib/molecular/superpose";

export interface SuperposePoint {
  x: number;
  y: number;
  z: number;
}

export interface SuperposeComparison {
  ok: boolean;
  error?: string;
  /** Display names (caller-supplied). */
  refName: string;
  mobileName: string;
  /** Aligned chain ids as reported by the superposition core. */
  refChain: string;
  mobileChain: string;
  /** Number of residue pairs used by the rigid fit. */
  matched: number;
  /** Total polymer residues with CA on each aligned chain. */
  refLength: number;
  mobileLength: number;
  /** Global CA RMSD after optimal superposition (Å). */
  rmsd: number;
  /** Reference chain CA path (original coordinates). */
  refPath: SuperposePoint[];
  /** Mobile chain CA path (rigid-transformed onto the reference). */
  mobilePath: SuperposePoint[];
  /**
   * Per-point deviation (Å) aligned with mobilePath — NaN where the residue
   * has no aligned partner (gapped in the sequence alignment).
   */
  mobileDeviations: number[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** CA position of one residue, or null when the residue has no CA atom. */
function residueCA(data: StructureData, residueIdx: number): SuperposePoint | null {
  const r = data.residues[residueIdx];
  if (!r) return null;
  const pos = data.atoms.positions;
  for (let i = r.start; i < r.end; i++) {
    if (data.atoms.names[i] === "CA") {
      return { x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] };
    }
  }
  return null;
}

/**
 * The protein chain of the structure whose id matches (trim + case
 * insensitive). `"?"` is the core's report for a BLANK chain id — match it
 * back to a blank/whitespace id (falling back to the longest protein chain
 * only when nothing matches), so the rendered path is the ALIGNED chain and
 * the deviation join never silently degrades to all-NaN.
 */
function matchedProteinChain(
  data: StructureData,
  chainId: string,
): number {
  const raw = chainId.trim();
  const want = raw.toUpperCase();
  const blank = raw === "?" || raw === "";
  let best = -1;
  let bestLen = -1;
  let bestMatch = -1;
  let bestMatchLen = -1;
  data.chains.forEach((c, i) => {
    if (c.type !== "protein") return;
    const len = c.residueIdx.length;
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
    const id = c.id.trim();
    const hit = blank ? id === "" : want !== "" && id.toUpperCase() === want;
    if (hit && len > bestMatchLen) {
      bestMatchLen = len;
      bestMatch = i;
    }
  });
  return bestMatch >= 0 ? bestMatch : best;
}

/** Ordered [residueIdx, CA] pairs of one protein chain (polymer residues only). */
function chainCAEntries(
  data: StructureData,
  chainIdx: number,
): { residueIdx: number; ca: SuperposePoint }[] {
  const chain = data.chains[chainIdx];
  if (!chain) return [];
  const out: { residueIdx: number; ca: SuperposePoint }[] = [];
  for (const ri of chain.residueIdx) {
    const r = data.residues[ri];
    if (!r || !r.polymer) continue;
    const ca = residueCA(data, ri);
    if (ca) out.push({ residueIdx: ri, ca });
  }
  return out;
}

function fail(refName: string, mobileName: string, error: string): SuperposeComparison {
  return {
    ok: false,
    error,
    refName,
    mobileName,
    refChain: "—",
    mobileChain: "—",
    matched: 0,
    refLength: 0,
    mobileLength: 0,
    rmsd: NaN,
    refPath: [],
    mobilePath: [],
    mobileDeviations: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Superpose the MOBILE structure onto the REFERENCE structure (both PDB
 * texts). Sequence alignment + Horn quaternion rigid fit happen inside
 * `superposeStructures`; this wrapper extracts the aligned chains' CA paths,
 * applies the transform to the mobile path, and computes per-residue
 * deviations for the matched pairs.
 */
export function compareStructures(
  refText: string,
  mobileText: string,
  refName: string,
  mobileName: string,
): SuperposeComparison {
  let ref: StructureData;
  let mobile: StructureData;
  try {
    ref = parseStructure(refText, refName, "pdb");
    mobile = parseStructure(mobileText, mobileName, "pdb");
  } catch (e) {
    return fail(
      refName,
      mobileName,
      `PDB parse failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = superposeStructures(mobile, ref);
  if (!result.ok) {
    return fail(refName, mobileName, result.error ?? "Superposition failed");
  }

  // Rigid transform (R from the optimal quaternion, t from centroid match).
  const R = quatToMatrix(result.quat);
  const t = result.translation;
  const transform = (p: SuperposePoint): SuperposePoint => ({
    x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t[0],
    y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t[1],
    z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t[2],
  });

  // Aligned chain CA paths (ordered by residue index).
  const refChainIdx = matchedProteinChain(ref, result.refChain);
  const mobChainIdx = matchedProteinChain(mobile, result.mobileChain);
  const refEntries = chainCAEntries(ref, refChainIdx);
  const mobEntries = chainCAEntries(mobile, mobChainIdx);

  const refPath = refEntries.map((e) => e.ca);
  const mobilePath = mobEntries.map((e) => transform(e.ca));

  // Deviation per mobile residue (aligned pairs only).
  const refCAByIdx = new Map<number, SuperposePoint>();
  for (const e of refEntries) refCAByIdx.set(e.residueIdx, e.ca);
  const deviationByIdx = new Map<number, number>();
  for (const [mobResIdx, refResIdx] of result.pairs) {
    const q = refCAByIdx.get(refResIdx);
    const mobCA = residueCA(mobile, mobResIdx);
    if (!q || !mobCA) continue;
    const p = transform(mobCA);
    deviationByIdx.set(
      mobResIdx,
      Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    );
  }
  const mobileDeviations = mobEntries.map(
    (e) => deviationByIdx.get(e.residueIdx) ?? NaN,
  );

  return {
    ok: true,
    refName,
    mobileName,
    refChain: result.refChain,
    mobileChain: result.mobileChain,
    matched: result.matched,
    refLength: refEntries.length,
    mobileLength: mobEntries.length,
    rmsd: result.rmsd,
    refPath,
    mobilePath,
    mobileDeviations,
  };
}

/** Deviation bucket thresholds (Å) — shared by the viewer coloring + legend. */
export const DEV_THRESHOLDS = { good: 1.0, warn: 2.5 } as const;

export type DeviationBucket = "emerald" | "amber" | "rose" | "none";

/** Bucket one deviation value (NaN → "none"). */
export function deviationBucket(dev: number): DeviationBucket {
  if (!Number.isFinite(dev)) return "none";
  if (dev < DEV_THRESHOLDS.good) return "emerald";
  if (dev < DEV_THRESHOLDS.warn) return "amber";
  return "rose";
}
