// Computational tool definitions + command builder + simulation (enhanced from V2).
import type { CompToolKey } from "./types";

export interface CompToolDef {
  key: CompToolKey;
  label: string;
  icon: string;
  color: string;
  description: string;
  cliStyle: "hydra" | "click" | "argparse" | "rosetta";
  cliCommand: string;
  defaultParams: Record<string, string | number | boolean>;
  paramFields: CompParamField[];
  resultSummary: (params: Record<string, unknown>, stdout: string) => string;
}

export interface CompParamField {
  key: string;
  label: string;
  type: "number" | "text" | "bool" | "select" | "path";
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
  hint?: string;
  flag?: string;
  group?: string;
  required?: boolean;
  advanced?: boolean;
}

export const COMP_TOOLS: CompToolDef[] = [
  {
    key: "rfdiffusion",
    label: "RFdiffusion",
    icon: "atom",
    color: "teal",
    description: "De novo protein structure design via diffusion. Generate scaffolds, binders, and symmetric assemblies.",
    cliStyle: "hydra",
    cliCommand: "RFdiffusion",
    defaultParams: {},
    paramFields: [
      { key: "num_designs", label: "Number of designs", type: "number", default: 8, min: 1, max: 100, step: 1, flag: "inference.num_designs", group: "Inference", required: true },
      { key: "total_length", label: "Total length (residues)", type: "number", default: 150, min: 30, max: 1000, step: 10, flag: "inference.total_length", group: "Inference" },
      { key: "contigmap", label: "Contig map", type: "text", default: "150", flag: "contigmap.contigmap", group: "Contigs", hint: "e.g. 100/0 or [100-150]" },
      { key: "hotspot", label: "Hotspot residues", type: "text", default: "", flag: "ppi.hotspot_res", group: "PPI", hint: "Target residues to bind (e.g. A30,A45)" },
      { key: "symmetry", label: "Symmetry", type: "select", default: "none", options: ["none", "C2", "C3", "C4", "C5", "D2", "icos"], flag: "inference.symmetry", group: "Symmetry" },
      { key: "seed", label: "Random seed", type: "number", default: 314, min: 0, max: 99999, step: 1, flag: "inference.seed", group: "Inference", advanced: true },
    ],
    resultSummary: (p) =>
      `RFdiffusion produced ${p.num_designs ?? 8} scaffolds (length ${p.total_length ?? 150}). All outputs written as PDB.`,
  },
  {
    key: "rfantibody",
    label: "RFantibody",
    icon: "beaker",
    color: "cyan",
    description: "Antibody structure design & CDR grafting. Generates Fv regions against target epitopes.",
    cliStyle: "hydra",
    cliCommand: "RFantibody",
    defaultParams: {},
    paramFields: [
      { key: "num_designs", label: "Number of designs", type: "number", default: 4, min: 1, max: 50, step: 1, flag: "inference.num_designs", group: "Inference", required: true },
      { key: "target_pdb", label: "Target PDB path", type: "path", default: "", flag: "inference.target_pdb", group: "Target", hint: "Path to target structure" },
      { key: "hotspot", label: "Hotspot residues", type: "text", default: "", flag: "inference.hotspot_res", group: "Target" },
      { key: "cdr_scheme", label: "CDR scheme", type: "select", default: "imgt", options: ["imgt", "kabat", "chothia"], flag: "inference.cdr_scheme", group: "Antibody" },
    ],
    resultSummary: (p) =>
      `RFantibody designed ${p.num_designs ?? 4} Fv candidates against the target.`,
  },
  {
    key: "proteinmpnn",
    label: "ProteinMPNN",
    icon: "dna",
    color: "violet",
    description: "Inverse folding — design sequences for given backbones. Soluble/LigandMPNN variants available.",
    cliStyle: "argparse",
    cliCommand: "proteinmpnn_run",
    defaultParams: {},
    paramFields: [
      { key: "pdb_path", label: "Input PDB path", type: "path", default: "", flag: "--pdb_path", group: "Input", required: true },
      { key: "num_seq", label: "Sequences per backbone", type: "number", default: 8, min: 1, max: 64, step: 1, flag: "--num_seq_per_targets", group: "Sampling" },
      { key: "sampling_temp", label: "Sampling temperature", type: "number", default: 0.1, min: 0.01, max: 1.0, step: 0.01, flag: "--sampling_temp", group: "Sampling", advanced: true },
      { key: "soluble", label: "SolubleMPNN mode", type: "bool", default: false, flag: "--soluble", group: "Variant" },
      { key: "ligand", label: "LigandMPNN mode", type: "bool", default: false, flag: "--ligand_mpnn", group: "Variant" },
      { key: "seed", label: "Random seed", type: "number", default: 42, min: 0, max: 99999, flag: "--seed", group: "Sampling", advanced: true },
    ],
    resultSummary: (p) =>
      `ProteinMPNN generated ${p.num_seq ?? 8} sequences per backbone (T=${p.sampling_temp ?? 0.1}).`,
  },
  {
    key: "rosetta",
    label: "Rosetta",
    icon: "flask-conical",
    color: "amber",
    description: "Energy minimization, docking, and interface analysis via rosetta_scripts.",
    cliStyle: "rosetta",
    cliCommand: "rosetta_scripts",
    defaultParams: {},
    paramFields: [
      { key: "s", label: "Input structure(s)", type: "path", default: "", flag: "-s", group: "Input", required: true },
      { key: "protocol", label: "Protocol XML", type: "text", default: "minimize", flag: "-parser:protocol", group: "Protocol" },
      { key: "nstruct", label: "Output structures", type: "number", default: 1, min: 1, max: 1000, flag: "-nstruct", group: "Output" },
      { key: "ddG", label: "Compute ΔΔG (mutate)", type: "bool", default: false, flag: "-ddG:mut_file", group: "Analysis" },
    ],
    resultSummary: (p) =>
      `Rosetta ran protocol "${p.protocol ?? "minimize"}" producing ${p.nstruct ?? 1} structure(s).`,
  },
];

export function getCompTool(key: string): CompToolDef | undefined {
  return COMP_TOOLS.find((t) => t.key === key);
}

/** Build a CLI string from a tool def + params. */
export function buildCommand(
  tool: CompToolDef,
  params: Record<string, unknown>,
): string {
  const parts: string[] = [tool.cliCommand];
  for (const f of tool.paramFields) {
    const v = params[f.key] ?? f.default;
    if (v === "" || v == null) continue;
    if (f.type === "bool") {
      if (v === true) parts.push(f.flag!);
      continue;
    }
    if (tool.cliStyle === "hydra") {
      parts.push(`${f.flag}=${String(v)}`);
    } else if (tool.cliStyle === "argparse") {
      parts.push(f.flag!, String(v));
    } else if (tool.cliStyle === "rosetta") {
      parts.push(f.flag!, String(v));
    } else {
      parts.push(f.flag!, String(v));
    }
  }
  return parts.join(" ");
}

/** Extract tool/bio calls from LLM fenced blocks. */
export function extractToolCalls(text: string): {
  comp: { tool: string; params: Record<string, unknown> }[];
  bio: { type: string; query: string; [k: string]: unknown }[];
} {
  const comp: { tool: string; params: Record<string, unknown> }[] = [];
  const bio: { type: string; query: string; [k: string]: unknown }[] = [];
  const compRe = /```tool\s*\n([\s\S]*?)```/g;
  const bioRe = /```bio\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = compRe.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.tool === "string") comp.push({ tool: obj.tool, params: obj.params ?? {} });
    } catch { /* ignore */ }
  }
  while ((m = bioRe.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.type === "string") bio.push(obj as { type: string; query: string });
    } catch { /* ignore */ }
  }
  return { comp, bio };
}

/** Deterministic simulation of a comp tool run. Returns {stdout, outputFiles}. */
export function simulateCompRun(
  tool: CompToolDef,
  params: Record<string, unknown>,
): { stdout: string; outputFiles: string[] } {
  const seed = Number(params.seed ?? 42);
  const designs = Number(params.num_designs ?? params.num_seq ?? 4);
  const ts = new Date().toISOString().slice(11, 19);
  const lines: string[] = [
    `[${ts}] ${tool.label} starting (simulated)`,
    `[${ts}] Loaded checkpoint for ${tool.key}`,
    `[${ts}] Effective seed: ${seed}`,
  ];
  const files: string[] = [];
  for (let i = 0; i < designs; i++) {
    const plddt = 70 + ((seed + i * 7) % 25);
    lines.push(`[${ts}] Design ${i + 1}/${designs} — pLDDT=${plddt} rmsd=${(1.2 + (i % 5) * 0.3).toFixed(2)}Å`);
    if (tool.key === "proteinmpnn") {
      const seq = Array.from({ length: 12 }, (_, k) => "ACDEFGHIKLMNPQRSTVWY"[(seed + i + k) % 20]).join("");
      lines.push(`[${ts}]   seq: ${seq}...`);
      files.push(`outputs/proteinmpnn/seq_${i}.fasta`);
    } else {
      files.push(`outputs/${tool.key}/design_${i}.pdb`);
    }
  }
  lines.push(`[${ts}] ${tool.label} completed. ${files.length} output file(s).`);
  lines.push(tool.resultSummary(params, lines.join("\n")));
  return { stdout: lines.join("\n"), outputFiles: files };
}

/** Brief capability summary injected into agent system prompts. */
export function compToolCapabilitySummary(): string {
  return COMP_TOOLS.map(
    (t) => `- ${t.key}: ${t.label} — ${t.description}`,
  ).join("\n");
}
