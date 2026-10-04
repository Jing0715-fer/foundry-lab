// Pure scoring utilities for the Screening panel — NO React, NO DOM (except
// the small downloadCsv helper, which is browser-only by nature).
//
// Scoring model (frozen contract):
//   norm(v)  = domain max===min ? 0.5 : clamp((v-min)/(max-min), 0, 1);
//              inverted (1 - norm) when !higherIsBetter.
//   score    = 100 · Σ(wᵢ·normᵢ)/Σwᵢ over metrics PRESENT on the candidate
//              (missing metric contributes nothing — weights renormalize
//              over the present metrics). Weights are integers 0–5.
//   rank     = 1-based position when all candidates are sorted by score desc.
//
// Quality coloring per RAW metric value:
//   higherIsBetter → v ≥ good = emerald, v ≥ warn = amber, else rose;
//   lowerIsBetter  → v ≤ good = emerald, v ≤ warn = amber, else rose;
//   no thresholds  → neutral.

import type {
  ScreeningCandidateDTO,
  ScreeningDTO,
  ScreeningMetricDef,
} from "@/lib/types";

// --- Normalization -----------------------------------------------------------

/** Min-max normalize a raw value into [0,1] respecting the metric direction. */
export function normalize(value: number, def: ScreeningMetricDef): number {
  const [min, max] = def.domain;
  if (!Number.isFinite(value)) return 0.5;
  if (max === min) return 0.5;
  let n = (value - min) / (max - min);
  n = Math.min(1, Math.max(0, n));
  return def.higherIsBetter ? n : 1 - n;
}

// --- Quality classes ---------------------------------------------------------

export type QualityClass = "emerald" | "amber" | "rose" | "neutral";

/** Quality bucket of a RAW metric value (emerald / amber / rose / neutral). */
export function qualityClass(value: number, def: ScreeningMetricDef): QualityClass {
  if (def.good === undefined && def.warn === undefined) return "neutral";
  if (def.higherIsBetter) {
    if (def.good !== undefined && value >= def.good) return "emerald";
    if (def.warn !== undefined && value >= def.warn) return "amber";
    return "rose";
  }
  // lower is better
  if (def.good !== undefined && value <= def.good) return "emerald";
  if (def.warn !== undefined && value <= def.warn) return "amber";
  return "rose";
}

/** Tailwind text classes for a quality bucket. */
export const QUALITY_TEXT: Record<QualityClass, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  rose: "text-rose-600 dark:text-rose-400",
  neutral: "text-foreground",
};

/** Tailwind bg classes for histogram bars / small fills. */
export const QUALITY_BG: Record<QualityClass, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  neutral: "bg-muted-foreground/40",
};

/** Composite score color: emerald ≥70, amber ≥50, rose <50. */
export function scoreColorClass(score: number): QualityClass {
  if (score >= 70) return "emerald";
  if (score >= 50) return "amber";
  return "rose";
}

// --- Composite scoring -------------------------------------------------------

/**
 * Compute the composite score (0–100) for every candidate under the given
 * weights. Missing metrics are skipped; weights renormalize over PRESENT
 * metrics; weight 0 effectively excludes a metric.
 */
export function computeScores(
  candidates: ScreeningCandidateDTO[],
  defs: ScreeningMetricDef[],
  weights: Record<string, number>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const c of candidates) {
    let sum = 0;
    let wsum = 0;
    for (const d of defs) {
      const raw = c.metrics?.[d.key];
      if (raw === undefined || raw === null || !Number.isFinite(raw)) continue;
      const w = weights[d.key];
      const weight = typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
      if (weight === 0) continue;
      sum += weight * normalize(raw, d);
      wsum += weight;
    }
    scores.set(c.id, wsum > 0 ? (100 * sum) / wsum : 0);
  }
  return scores;
}

/** A candidate row enriched with its live composite score and global rank. */
export interface ScoredRow {
  candidate: ScreeningCandidateDTO;
  score: number;
  rank: number;
}

/**
 * Attach score + global rank (1-based, by score desc — name then id as
 * deterministic tie-breakers) to every candidate.
 */
export function buildScoredRows(
  candidates: ScreeningCandidateDTO[],
  defs: ScreeningMetricDef[],
  weights: Record<string, number>,
): ScoredRow[] {
  const scoreMap = computeScores(candidates, defs, weights);
  const rows: Omit<ScoredRow, "rank">[] = candidates.map((candidate) => ({
    candidate,
    score: scoreMap.get(candidate.id) ?? 0,
  }));
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.name.localeCompare(b.candidate.name) ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// --- Weight presets ----------------------------------------------------------

export interface WeightPreset {
  key: string;
  label: string;
  /** Overrides on top of "everything else = 1". */
  weights: Record<string, number>;
}

export const PRESETS: WeightPreset[] = [
  { key: "balanced", label: "Balanced", weights: {} },
  { key: "confidence", label: "Confidence first", weights: { plddt: 5, ptm: 4 } },
  { key: "diversity", label: "Diversity first", weights: { diversity: 5, helix_pct: 2 } },
  { key: "designability", label: "Designability", weights: { clashes: 5, rama_ll: 4, helix_pct: 2 } },
];

/** Apply a preset to the available metric keys (others stay at 1). */
export function applyPreset(
  preset: WeightPreset,
  defs: ScreeningMetricDef[],
): Record<string, number> {
  const w: Record<string, number> = {};
  for (const d of defs) w[d.key] = preset.weights[d.key] ?? 1;
  return w;
}

/** Normalize a screening's persisted weights into a full 0–5 integer map. */
export function initWeights(screening: ScreeningDTO | null): Record<string, number> {
  const w: Record<string, number> = {};
  if (!screening) return w;
  for (const d of screening.metricDefs ?? []) {
    const raw = screening.weights?.[d.key];
    const v = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
    w[d.key] = Math.min(5, Math.max(0, Math.round(v)));
  }
  return w;
}

/** Do the local weights differ from the persisted ones? (unsaved dot) */
export function weightsDirty(
  defs: ScreeningMetricDef[],
  local: Record<string, number>,
  saved: Record<string, number>,
): boolean {
  return defs.some((d) => (local[d.key] ?? 1) !== (saved[d.key] ?? 1));
}

// --- Formatting --------------------------------------------------------------

/** Format a metric value with 1–2 decimals, trailing zeros trimmed. */
export function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const s = value.toFixed(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

// --- CSV export --------------------------------------------------------------

/** CSV-escape one cell: quote when it contains a comma, quote, or newline. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Build the export CSV. Columns:
 * rank, name, source, sourceLabel, status, starred, score, length,
 * …one column per metric key…, tags, notes.
 */
export function buildCsv(
  screening: ScreeningDTO,
  rows: { candidate: ScreeningCandidateDTO; rank: number; score: number }[],
  defs: ScreeningMetricDef[],
): string {
  const header = [
    "rank",
    "name",
    "source",
    "sourceLabel",
    "status",
    "starred",
    "score",
    "length",
    ...defs.map((d) => d.key),
    "tags",
    "notes",
  ];
  const lines: string[] = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const c = r.candidate;
    const cells = [
      String(r.rank),
      c.name ?? "",
      c.source ?? "",
      c.sourceLabel ?? "",
      c.status ?? "new",
      c.starred ? "true" : "false",
      r.score.toFixed(1),
      c.length === null || c.length === undefined ? "" : String(c.length),
      ...defs.map((d) => {
        const v = c.metrics?.[d.key];
        return v === undefined || v === null || !Number.isFinite(v)
          ? ""
          : String(v);
      }),
      (c.tags ?? []).join("; "),
      c.notes ?? "",
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

/** Trigger a client-side download of a CSV string (browser-only helper). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
