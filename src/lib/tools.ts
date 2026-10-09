// Computational tool definitions + command builder.
//
// The tool surface has two families:
//   ① The comp tools (RFdiffusion, RFantibody, ProteinMPNN, LigandMPNN,
//      SolubleMPNN, Rosetta, PyRosetta, RF3, ESMFold, ColabFold) — each a
//      standalone node/command on the canvas and the cluster lane.
//   ② AlphaFold2 structure prediction, following the cluster tutorial:
//
//   # 1. on the mgt login node, request one GPU:
//   salloc -N 1 --gres=gpu:1 -p brain2
//   ssh gpu05                      # stage 2 only runs on GPU05
//   # 2. load the environment:
//   module load alphafold2
//   # 3. check free GPUs, then predict from a FASTA…
//   nvidia-smi
//   CUDA_VISIBLE_DEVICES="6" run_alphafold.py \
//     --fasta_paths $test_fa --output_dir T1078_AF2 \
//     --max_template_date 2021-07-20
//   #   …or continue from precomputed features (skips the MSA stage):
//   CUDA_VISIBLE_DEVICES="7" run_alphafold.py \
//     --feature_file $test_ft --output_dir T1078_AF2
//
// Execution lanes:
//   - CLUSTER: the app SSHes to the mgt login node, stages inputs, and runs
//     the tool directly, via Slurm, or via the salloc → ssh gpu05 → module
//     load → run_alphafold.py chain for AlphaFold.
//   - LOCAL: the built-in real algorithm engines run offline (honest
//     positioning: classical published algorithms, NOT the trained networks —
//     see tool-registry provenance).
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
  type: "number" | "text" | "bool" | "select" | "path" | "textarea";
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
  /** Engine-only concept with no upstream CLI flag — never emitted to a
   *  native/cluster command (e.g. RFdiffusion has no `inference.total_length`). */
  engineOnly?: boolean;
  /** Text field whose native value is a hydra LIST of strings — the builder
   *  emits `flag=['<value>']` so hydra keeps it a string list (RFdiffusion's
   *  ContigMap requires contigs[0].strip() to exist). */
  hydraList?: boolean;
  /** Environment-variable prefix instead of a CLI flag — the executor exports
   *  `envPrefix=<value>` for the process (e.g. CUDA_VISIBLE_DEVICES="6"). */
  envPrefix?: string;
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
      // RFdiffusion's real CLI has no --total-length: length comes from the
      // contig string. Kept for the built-in engine only (native runs must
      // not pass a nonexistent hydra key — hydra rejects unknown overrides).
      { key: "total_length", label: "Total length (residues)", type: "number", default: 150, min: 30, max: 1000, step: 10, group: "Contigs", engineOnly: true, hint: "Built-in engine default length when no contig map is given." },
      { key: "contigmap", label: "Contig map", type: "text", default: "150", flag: "contigmap.contigs", hydraList: true, group: "Contigs", hint: "e.g. 150 · 100/0 · A30-60/0 · 100-150 (multiple: comma-separated)" },
      { key: "hotspot", label: "Hotspot residues", type: "text", default: "", flag: "ppi.hotspot_res", group: "PPI", hint: "Target residues to bind (e.g. A30,A45)" },
      { key: "symmetry", label: "Symmetry", type: "select", default: "none", options: ["none", "C2", "C3", "C4", "C5", "D2", "icos"], flag: "inference.symmetry", group: "Symmetry" },
      // No `inference.seed` in RFdiffusion's hydra struct (upstream seeds via
      // `inference.deterministic`); the built-in engine uses this for
      // reproducible sampling. Never emitted to the native CLI.
      { key: "seed", label: "Random seed", type: "number", default: 314, min: 0, max: 99999, step: 1, group: "Inference", advanced: true, engineOnly: true },
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
      { key: "cdr_h3_length", label: "CDR-H3 length", type: "number", default: 0, min: 0, max: 25, step: 1, group: "Antibody", engineOnly: true, hint: "0 = auto-sample per run (5–17). Set 4–25 for a fixed H3 loop length — the backbone of affinity-maturation length-ladder sweeps. Built-in engine only: the native/cluster CLI ignores this parameter." },
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
  // --- AlphaFold2 (the cluster tutorial flow) --------------------------------
  {
    key: "alphafold",
    label: "AlphaFold2",
    icon: "boxes",
    color: "teal",
    description:
      "Protein structure prediction with AlphaFold2 (Jumper et al. 2021) on the GPU cluster: salloc a GPU on the mgt node, ssh to the compute node (GPU05), module load alphafold2, run run_alphafold.py from a FASTA sequence or a precomputed features.pkl. Outputs five models ranked by pLDDT (ranked_0.pdb is the highest-confidence prediction).",
    cliStyle: "argparse",
    cliCommand: "run_alphafold.py",
    defaultParams: {},
    paramFields: [
      {
        key: "sequence",
        label: "Protein sequence (FASTA)",
        type: "textarea",
        default: "",
        group: "Input",
        engineOnly: true,
        hint: "Paste a FASTA (a >name header line + residues). It is uploaded to the cluster as <name>.fa when no path is given.",
      },
      {
        key: "fasta_path",
        label: "FASTA path",
        type: "path",
        default: "",
        flag: "--fasta_paths",
        group: "Input",
        hint: "Local file (auto-uploaded to the cluster) or an absolute cluster path (e.g. /data03/lipan/Protein_Structure/examples/T1078.fa).",
      },
      {
        key: "feature_file",
        label: "features.pkl path (skip preprocessing)",
        type: "path",
        default: "",
        flag: "--feature_file",
        group: "Input",
        hint: "Start from AlphaFold preprocessing output — skips the expensive MSA search stage.",
      },
      {
        key: "output_dir",
        label: "Output directory",
        type: "text",
        default: "alphafold_out",
        flag: "--output_dir",
        group: "Output",
        required: true,
        hint: "Created inside the job workdir (tutorial convention: T1078_AF2).",
      },
      {
        key: "max_template_date",
        label: "Max template date",
        type: "text",
        default: "2021-07-20",
        flag: "--max_template_date",
        group: "Templates",
        hint: "Only PDB templates deposited before this date are used.",
      },
      {
        key: "gpu",
        label: "GPU card",
        type: "select",
        default: "0",
        options: ["0", "1", "2", "3", "4", "5", "6", "7"],
        envPrefix: "CUDA_VISIBLE_DEVICES",
        group: "Execution",
        hint: "CUDA_VISIBLE_DEVICES — check which cards are free with nvidia-smi first.",
      },
      // Local built-in engine tuning only — never emitted to the cluster CLI
      // (the tutorial's run_alphafold.py does not expose these flags).
      { key: "num_recycles", label: "Recycles (local engine)", type: "number", default: 3, min: 0, max: 24, step: 1, group: "Local engine", advanced: true, engineOnly: true },
      { key: "seed", label: "Random seed (local engine)", type: "number", default: 42, min: 0, max: 99999, step: 1, group: "Local engine", advanced: true, engineOnly: true },
    ],
    resultSummary: (p, stdout) => {
      const ranked = /ranked_(\d)\.pdb/.test(stdout);
      const from = p.feature_file ? "precomputed features.pkl" : "FASTA sequence";
      return ranked
        ? `AlphaFold2 prediction from ${from} complete — five models produced and ranked by pLDDT (ranked_0.pdb = highest confidence).`
        : `AlphaFold2 prediction from ${from} dispatched — outputs include ranked_*.pdb, relaxed/unrelaxed models, ranking_debug.json and msas/.`;
    },
  },
];

export function getCompTool(key: string): CompToolDef | undefined {
  return COMP_TOOLS.find((t) => t.key === key);
}

/** Normalize a contig value into a single space/comma-joined contig string.
 *  Accepts what users type — `150`, `100/0`, `A30-60/0`, `[100-150]`,
 *  `['100-150', 'A30/0']` (hydra list syntax) — and yields one plain string
 *  (e.g. `100-150 A30/0`). */
export function normalizeContigValue(raw: string): string {
  let s = String(raw).trim();
  // Strip hydra list wrapping: ['a', 'b'] / ["a", "b"] / [a,b]
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
    s = s.replace(/['\"]/g, "");
  }
  // Comma-separated pieces → space-joined (ContigMap splits on whitespace).
  return s
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Build the structured argv for a tool invocation. Tokens keep values
 *  intact (no shell quoting) — callers either spawn directly or shQuote each
 *  token for remote execution. */
export function buildArgs(
  tool: CompToolDef,
  params: Record<string, unknown>,
): string[] {
  const parts: string[] = [tool.cliCommand];
  // --feature_file and --fasta_paths are mutually exclusive (the tutorial
  // grammar): a features.pkl input means the preprocessing stage is skipped.
  const hasFeatureFile = (() => {
    const v = params["feature_file"];
    return typeof v === "string" ? v.trim().length > 0 : !!v;
  })();

  for (const f of tool.paramFields) {
    const v = params[f.key] ?? f.default;
    if (v === "" || v == null) continue;
    // Engine-only params never reach a native CLI.
    if (f.engineOnly) continue;
    // Environment-prefix params (CUDA_VISIBLE_DEVICES) are applied by the
    // executor as env, not as argv.
    if (f.envPrefix) continue;
    // FASTA input is dropped when a features.pkl is given.
    if (f.key === "fasta_path" && hasFeatureFile) continue;
    // Template date is meaningless when preprocessing is skipped (the
    // tutorial's features.pkl command omits it).
    if (f.key === "max_template_date" && hasFeatureFile) continue;
    // "none"/"null" symmetry → upstream default (no symmetric generation).
    if (f.key === "symmetry" && /^(none|null|)$/i.test(String(v))) continue;
    if (f.type === "bool") {
      if (v === true) parts.push(f.flag!);
      continue;
    }
    if (tool.cliStyle === "hydra") {
      if (f.hydraList) {
        // List-of-strings grammar: contigmap.contigs=['100/0 A10-30']
        // (single quotes force string typing — bare [100] parses as an int
        // list and crashes ContigMap.get_sampled_mask). Values with quotes
        // are stripped by the hydra grammar before we re-emit one string.
        const inner = normalizeContigValue(String(v)).replace(/'/g, "");
        parts.push(`${f.flag}=['${inner}']`);
      } else {
        parts.push(`${f.flag}=${String(v)}`);
      }
    } else {
      // argparse / rosetta / click — dashed two-token grammar.
      parts.push(f.flag!, String(v));
    }
  }
  return parts;
}

/** Build a CLI string from a tool def + params. */
export function buildCommand(
  tool: CompToolDef,
  params: Record<string, unknown>,
): string {
  return buildArgs(tool, params).join(" ");
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

// ── AlphaFold helpers ───────────────────────────────────────────────────────

/** Parse a FASTA string → { name, seq }. Accepts with/without line breaks,
 *  with/without a >header (a bare sequence gets the name "sequence"). */
export function parseFastaInput(raw: string): { name: string; seq: string } | null {
  const text = raw.trim();
  if (!text) return null;
  let name = "sequence";
  let body = text;
  if (text.startsWith(">")) {
    const nl = text.indexOf("\n");
    const first = nl === -1 ? text : text.slice(0, nl);
    name = first.replace(/^>\s*/, "").trim() || "sequence";
    body = nl === -1 ? "" : text.slice(nl + 1);
  }
  const seq = body.replace(/\s+/g, "").toUpperCase();
  if (!seq) return null;
  // Standard 20 amino acids + a few common ambiguity codes.
  if (!/^[ACDEFGHIKLMNPQRSTVWYBXZU*-]+$/.test(seq)) return null;
  return { name: name.replace(/[^\w.-]/g, "_").slice(0, 64) || "sequence", seq };
}

/** Derive the tutorial-convention output directory name (<seqname>_AF2). */
export function af2OutputDirFor(rawName: string): string {
  const name = rawName.replace(/[^\w.-]/g, "_").slice(0, 48) || "alphafold";
  return `${name}_AF2`;
}

// ── Tutorial command preview (client-safe, pure) ─────────────────────────────

export interface TutorialPreviewArgs {
  /** ssh target shown in the preview (the mgt login host). */
  loginHost: string;
  /** salloc partition (brain2). */
  partition: string;
  /** compute node to ssh into after allocation (gpu05). */
  node: string;
  /** environment module to load (alphafold2). */
  module: string;
  /** CUDA card index — the tutorial's CUDA_VISIBLE_DEVICES. */
  cudaDevice: string;
  /** remote FASTA path (cluster-absolute or staged input path). */
  fastaPath?: string;
  /** remote features.pkl path (mutually exclusive with fastaPath). */
  featureFile?: string;
  outputDir: string;
  maxTemplateDate: string;
  /** remote job workdir (outputs land in <workdir>/<outputDir>/). */
  remoteWorkdir: string;
}

/** Render the tutorial command chain as a shell transcript — exactly the
 *  steps the app performs over SSH (mgt → salloc → gpu05 → module → run). */
export function buildTutorialPreview(a: TutorialPreviewArgs): string {
  const inputToken = a.featureFile
    ? `--feature_file ${a.featureFile}`
    : `--fasta_paths ${a.fastaPath ?? "input/query.fa"}`;
  const cmd = `CUDA_VISIBLE_DEVICES="${a.cudaDevice}" run_alphafold.py ${inputToken} --output_dir ${a.outputDir}${a.featureFile ? "" : ` --max_template_date ${a.maxTemplateDate}`}`;
  return [
    `# 1. on the mgt login node — request one GPU card (${a.loginHost})`,
    `salloc -N 1 --gres=gpu:1 -p ${a.partition}`,
    `ssh ${a.node}`,
    "",
    "# 2. load the AlphaFold2 environment",
    `module load ${a.module}`,
    "",
    "# 3. check which GPU cards are free",
    "nvidia-smi",
    "",
    a.featureFile
      ? "# 4. predict from precomputed features (skips the MSA stage)"
      : "# 4. predict from the protein sequence (end-to-end)",
    cmd,
    "",
    "# the app runs, verbatim:",
    `cd ${a.remoteWorkdir} && ${cmd}`,
  ].join("\n");
}
