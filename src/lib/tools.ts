// AlphaFold2 prediction tool definition + command builder.
//
// The computational tool surface is a single tool — AlphaFold2 structure
// prediction — following the cluster tutorial exactly:
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
//   - CLUSTER (primary): the app SSHes to the mgt login node, stages inputs,
//     and runs the salloc → ssh gpu05 → module load → run_alphafold.py chain.
//   - LOCAL (fallback): the built-in Structure Prediction Engine runs the
//     published Chou-Fasman algorithm offline (honest positioning: a classical
//     baseline, NOT the AF2 network — see tool-registry provenance).
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
   *  native/cluster command (e.g. the paste-a-sequence input). */
  engineOnly?: boolean;
  /** Environment-variable prefix instead of a CLI flag — the executor exports
   *  `envPrefix=<value>` for the process (e.g. CUDA_VISIBLE_DEVICES="6"). */
  envPrefix?: string;
}

export const COMP_TOOLS: CompToolDef[] = [
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
    if (f.type === "bool") {
      if (v === true) parts.push(f.flag!);
      continue;
    }
    if (tool.cliStyle === "hydra") {
      parts.push(`${f.flag}=${String(v)}`);
    } else {
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
