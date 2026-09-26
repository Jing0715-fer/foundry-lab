// Computational tool definitions + command builder (no simulation —
// execution is handled by real-executor: native tool → built-in real
// algorithm engine).
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
      { key: "diffuser_partial_T", label: "Partial diffusion steps", type: "number", default: 0, min: 0, max: 100, step: 1, flag: "diffuser.partial_T", group: "Diffuser", advanced: true, hint: "Non-zero = noise + denoise an input structure (motif scaffolding / partial diffusion)." },
      { key: "ckpt_override_path", label: "Checkpoint override path", type: "path", default: "", flag: "inference.ckpt_override_path", group: "Inference", advanced: true, hint: "Custom .pt checkpoint (e.g. finetuned binder model)." },
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
      { key: "num_seq", label: "Sequences per backbone", type: "number", default: 8, min: 1, max: 64, step: 1, flag: "--num_seq_per_target", group: "Sampling" },
      { key: "sampling_temp", label: "Sampling temperature", type: "number", default: 0.1, min: 0.01, max: 1.0, step: 0.01, flag: "--sampling_temp", group: "Sampling", advanced: true },
      { key: "soluble", label: "SolubleMPNN mode", type: "bool", default: false, flag: "--use_soluble_model", group: "Variant" },
      { key: "ligand", label: "LigandMPNN mode", type: "bool", default: false, flag: "--ligand_mpnn", group: "Variant" },
      { key: "path_to_fasta", label: "Output FASTA path", type: "path", default: "", flag: "--path_to_fasta", group: "Output", hint: "Where to write the designed sequences (FASTA)." },
      { key: "batch_size", label: "Batch size", type: "number", default: 1, min: 1, max: 32, step: 1, flag: "--batch_size", group: "Performance", advanced: true, hint: "Higher = more memory, faster." },
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
  // --- MPNN variants ---------------------------------------------------------
  {
    key: "ligandmpnn",
    label: "LigandMPNN",
    icon: "dna",
    color: "pink",
    description: "Inverse folding with ligand context — design sequences aware of bound small molecules, ions, or cofactors.",
    cliStyle: "argparse",
    cliCommand: "ligandmpnn_run",
    defaultParams: {},
    paramFields: [
      { key: "pdb_path", label: "Input PDB path", type: "path", default: "", flag: "--pdb_path", group: "Input", required: true },
      { key: "num_seq", label: "Sequences per backbone", type: "number", default: 8, min: 1, max: 64, step: 1, flag: "--num_seq_per_target", group: "Sampling" },
      { key: "sampling_temp", label: "Sampling temperature", type: "number", default: 0.1, min: 0.01, max: 1.0, step: 0.01, flag: "--sampling_temp", group: "Sampling", advanced: true },
      { key: "ligand_mpnn_use_side_chain_context", label: "Use side-chain context", type: "bool", default: true, flag: "--ligand_mpnn_use_side_chain_context", group: "Ligand" },
      { key: "seed", label: "Random seed", type: "number", default: 42, min: 0, max: 99999, flag: "--seed", group: "Sampling", advanced: true },
    ],
    resultSummary: (p) =>
      `LigandMPNN generated ${p.num_seq ?? 8} ligand-aware sequences per backbone (T=${p.sampling_temp ?? 0.1}).`,
  },
  {
    key: "solublempnn",
    label: "SolubleMPNN",
    icon: "beaker",
    color: "emerald",
    description: "Soluble variant of ProteinMPNN — designs sequences optimized for soluble expression (no membrane/aggregation bias).",
    cliStyle: "argparse",
    cliCommand: "solublempnn_run",
    defaultParams: {},
    paramFields: [
      { key: "pdb_path", label: "Input PDB path", type: "path", default: "", flag: "--pdb_path", group: "Input", required: true },
      { key: "num_seq", label: "Sequences per backbone", type: "number", default: 8, min: 1, max: 64, step: 1, flag: "--num_seq_per_target", group: "Sampling" },
      { key: "sampling_temp", label: "Sampling temperature", type: "number", default: 0.1, min: 0.01, max: 1.0, step: 0.01, flag: "--sampling_temp", group: "Sampling", advanced: true },
      { key: "seed", label: "Random seed", type: "number", default: 42, min: 0, max: 99999, flag: "--seed", group: "Sampling", advanced: true },
    ],
    resultSummary: (p) =>
      `SolubleMPNN generated ${p.num_seq ?? 8} solubility-optimized sequences (T=${p.sampling_temp ?? 0.1}).`,
  },
  {
    key: "pyrosetta",
    label: "PyRosetta",
    icon: "calculator",
    color: "orange",
    description: "Interactive PyRosetta scoring — compute Rosetta energy, interface ΔG, and per-residue breakdowns.",
    cliStyle: "argparse",
    cliCommand: "python -m pyrosetta.score",
    defaultParams: {},
    paramFields: [
      { key: "pdb_path", label: "Input PDB path", type: "path", default: "", flag: "--pdb", group: "Input", required: true },
      { key: "scorefunction", label: "Score function", type: "select", default: "ref2015", options: ["ref2015", "beta_nov16", "beta", "talaris2014"], flag: "--scorefunction", group: "Scoring" },
      { key: "interface", label: "Interface analysis", type: "bool", default: true, flag: "--interface", group: "Analysis" },
      { key: "ddG", label: "Compute ΔΔG mutants", type: "bool", default: false, flag: "--ddG", group: "Analysis" },
    ],
    resultSummary: (p) =>
      `PyRosetta scored with ${p.scorefunction ?? "ref2015"}${p.interface ? " + interface ΔG" : ""}${p.ddG ? " + ΔΔG" : ""}.`,
  },
  // --- Structure prediction --------------------------------------------------
  {
    key: "rf3",
    label: "RoseTTAFold3",
    icon: "boxes",
    color: "teal",
    description: "Structure prediction from sequence via RoseTTAFold3 (RF3). Predicts 3D structure with confidence metrics (pLDDT, pTM).",
    cliStyle: "hydra",
    cliCommand: "rf3 fold",
    defaultParams: {},
    paramFields: [
      { key: "fasta_path", label: "Input FASTA path", type: "path", default: "", flag: "input.fasta", group: "Input", required: true },
      { key: "num_recycles", label: "Recycles", type: "number", default: 3, min: 0, max: 24, step: 1, flag: "num_recycles", group: "Inference" },
      { key: "use_msa", label: "Use MSA", type: "bool", default: true, flag: "use_msa", group: "MSA" },
      { key: "seed", label: "Random seed", type: "number", default: 42, min: 0, max: 99999, flag: "seed", group: "Inference", advanced: true },
    ],
    resultSummary: (p) =>
      `RF3 predicted structure from FASTA with ${p.num_recycles ?? 3} recycles${p.use_msa ? " + MSA" : " (no MSA)"}. Outputs pLDDT/pTM confidence.`,
  },
  {
    key: "esmfold",
    label: "ESMFold",
    icon: "atom",
    color: "violet",
    description: "Fast structure prediction from sequence via ESMFold (no MSA needed). Ideal for rapid iteration.",
    cliStyle: "argparse",
    cliCommand: "esmfold predict",
    defaultParams: {},
    paramFields: [
      { key: "sequence", label: "Protein sequence", type: "text", default: "", flag: "--sequence", group: "Input", required: true, hint: "One-letter AA sequence" },
      { key: "num_recycles", label: "Recycles", type: "number", default: 4, min: 0, max: 24, step: 1, flag: "--recycles", group: "Inference" },
      { key: "model_name", label: "Model checkpoint", type: "select", default: "esmfold_v1", options: ["esmfold_v1"], flag: "--model_name", group: "Model", advanced: true },
      { key: "chunk_size", label: "Chunk size", type: "number", default: 512, min: 64, max: 2048, step: 64, flag: "--chunk_size", group: "Performance", advanced: true },
    ],
    resultSummary: (p) =>
      `ESMFold predicted structure (recycles=${p.num_recycles ?? 4}) from ${String(p.sequence ?? "").length} residues. Fast single-sequence prediction.`,
  },
  {
    key: "colabfold",
    label: "ColabFold",
    icon: "cpu",
    color: "cyan",
    description: "AlphaFold2-based structure prediction via ColabFold (with MSA). High-accuracy predictions for complex topologies.",
    cliStyle: "argparse",
    cliCommand: "colabfold_batch",
    defaultParams: {},
    paramFields: [
      { key: "fasta_path", label: "Input FASTA path", type: "path", default: "", flag: "--fasta", group: "Input", required: true },
      { key: "model_type", label: "Model type", type: "select", default: "alphafold2_ptm", options: ["alphafold2", "alphafold2_ptm", "alphafold2_multimer_v3"], flag: "--model-type", group: "Model" },
      { key: "num_recycles", label: "Recycles", type: "number", default: 3, min: 0, max: 24, step: 1, flag: "--recycles", group: "Inference" },
      { key: "use_templates", label: "Use templates", type: "bool", default: true, flag: "--templates", group: "Templates", hint: "Pull PDB templates during MSA generation." },
      { key: "use_amber", label: "AMBER relaxation", type: "bool", default: true, flag: "--amber", group: "Relaxation" },
      { key: "num_predictions", label: "Predictions per target", type: "number", default: 1, min: 1, max: 20, step: 1, flag: "--num-predictions", group: "Output" },
    ],
    resultSummary: (p) =>
      `ColabFold predicted ${p.num_predictions ?? 1} structure(s) using ${p.model_type ?? "alphafold2_ptm"} with ${p.num_recycles ?? 3} recycles${p.use_amber ? " + AMBER relax" : ""}.`,
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

/** Brief capability summary injected into agent system prompts. */
export function compToolCapabilitySummary(): string {
  return COMP_TOOLS.map(
    (t) => `- ${t.key}: ${t.label} — ${t.description}`,
  ).join("\n");
}
