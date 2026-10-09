// Parameter-sweep axis templates — one-click value ladders for the common
// computational-protein-design sweeps. A template only fills the axes whose
// keys exist on the node's spec; **multi-axis templates additionally require
// EVERY axis to match** (a partially-matching "affinity library" on a
// non-antibody node would sweep a different experiment than its label
// promises — hiding it is the honest behavior). Frontend affordance only:
// the sweep API re-validates everything server-side.

import type { ParamSchema, SweepValue } from "./types";

export interface SweepTemplate {
  id: string;
  label: string;
  description: string;
  /** paramKey → value ladder. */
  values: Record<string, SweepValue[]>;
}

export const SWEEP_TEMPLATES: SweepTemplate[] = [
  {
    id: "design-count",
    label: "Design count ladder",
    description: "num_designs: 2 / 4 / 8 / 16 — throughput vs. diversity",
    values: { num_designs: [2, 4, 8, 16] },
  },
  {
    id: "length-series",
    label: "Length series",
    description: "total_length: 80–160 — fold stability across sizes",
    values: { total_length: [80, 100, 120, 160] },
  },
  {
    id: "sampling-temp",
    label: "Sampling temperature",
    description: "sampling_temp: 0.1 / 0.3 / 0.5 — sequence diversity",
    values: { sampling_temp: [0.1, 0.3, 0.5] },
  },
  {
    id: "recycle-ladder",
    label: "Recycle ladder",
    description: "num_recycles: 1 / 3 / 6 / 12 — prediction refinement",
    values: { num_recycles: [1, 3, 6, 12] },
  },
  {
    id: "symmetry-series",
    label: "Symmetry series",
    description: "symmetry: C2 / C3 / C4 — oligomeric assemblies",
    values: { symmetry: ["C2", "C3", "C4"] },
  },
  {
    id: "llm-temperature",
    label: "Agent temperature",
    description: "temperature: 0.3 / 0.7 / 1.1 — generation variance",
    values: { temperature: [0.3, 0.7, 1.1] },
  },
  // --- D2: antibody affinity-maturation templates (RFantibody axes) ---------
  {
    id: "cdr-scheme",
    label: "CDR numbering schemes",
    description: "cdr_scheme: IMGT / Kabat / Chothia — graft geometry conventions",
    values: { cdr_scheme: ["imgt", "kabat", "chothia"] },
  },
  {
    id: "h3-length-ladder",
    label: "CDR-H3 length ladder",
    description:
      "cdr_h3_length: 6 / 9 / 12 / 15 — paratope loop length series (h3_len becomes a compare column)",
    values: { cdr_h3_length: [6, 9, 12, 15] },
  },
  {
    id: "affinity-library",
    label: "Affinity maturation library",
    description:
      "cdr_h3_length × num_designs: 8 / 12 × 4 / 8 — diversified libraries for shotgunning into ProteinMPNN",
    values: { cdr_h3_length: [8, 12], num_designs: [4, 8] },
  },
];

/**
 * Which of a template's axes match the node's spec (key present + type
 * compatible)? Templates with zero matches are hidden in the dialog;
 * multi-axis templates must match on ALL of their axes (see header).
 */
export function templateMatches(
  template: SweepTemplate,
  params: ParamSchema[],
): { key: string; schema: ParamSchema; values: SweepValue[] }[] {
  const out: { key: string; schema: ParamSchema; values: SweepValue[] }[] = [];
  for (const [key, values] of Object.entries(template.values)) {
    const schema = params.find((p) => p.key === key);
    if (!schema) continue;
    // Keep only values the schema accepts (min/max/options) so applying a
    // template can never produce an invalid axis state.
    const ok =
      schema.type === "select"
        ? values.filter((v) => (schema.options ?? []).includes(String(v)))
        : schema.type === "bool"
          ? values.filter((v) => typeof v === "boolean")
          : values.filter(
              (v) =>
                (schema.min === undefined || Number(v) >= schema.min) &&
                (schema.max === undefined || Number(v) <= schema.max),
            );
    if (ok.length < 2) continue;
    out.push({ key, schema, values: ok });
  }
  // P2-4: partial multi-axis matches change the experiment's meaning —
  // require the full axis set (single-axis templates are unaffected).
  if (out.length !== Object.keys(template.values).length) return [];
  return out;
}
