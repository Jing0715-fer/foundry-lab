// Tool registry — runtime deps, the built-in compute engine, and AlphaFold2.
//
// Tiers of "tooling" tracked:
//   1. RUNTIME dependencies — python3, numpy, git… required by the built-in
//      real algorithm engine. Each has a real one-click install command.
//   2. BUILT-IN ENGINE — the real Python algorithm implementation shipped
//      in scripts/algorithms/fold_engine.py (Chou-Fasman + NeRF assembly).
//      Detected via a fast self-test run; it runs real science with zero
//      external deps beyond the runtime tier. It is the LOCAL fallback for
//      the alphafold tool (honest positioning: classical algorithm, NOT the
//      AF2 network — the real AlphaFold2 runs on the GPU cluster via
//      `module load alphafold2`).
//   3. EXTERNAL TOOL — AlphaFold2 itself, provided on the GPU cluster
//      (salloc → ssh gpu05 → module load alphafold2 → run_alphafold.py).
//      When a local `run_alphafold.py` is on PATH it is used directly;
//      when missing, local runs fall back to the built-in engine.

export type ToolCategory =
  | "runtime"
  | "engine"
  | "structure-prediction"
  | "bio";

export type DetectType = "binary" | "python" | "path";
export type InstallMethod = "pip" | "github" | "binary" | "runtime";

/** Optional native-execution extras shared by every mode. */
export interface NativeExecutionExtras {
  /** Output flag with PREFIX semantics — the tool writes `<base>_0.pdb`, so
   *  the base is pinned to `<workDir>/design` to keep artifacts inside the
   *  job workDir. Dotted flags (hydra) are single `key=value` tokens. */
  outputPrefixFlag?: string;
  /** Dashed output flag (e.g. `--out_folder`). FOLDER semantics by default
   *  (the tool writes inside the given dir); set `outFolderIsPrefix` for
   *  prefix-taking dashed flags. */
  outFolderFlag?: string;
  outFolderIsPrefix?: boolean;
  /** Fixed args appended verbatim after the built command. */
  fixedArgs?: string[];
  /** Per-tool execution timeout; default 5 min. Heavy tools raise it. */
  timeoutMs?: number;
}

export type NativeExecution =
  // spawn parts[0] of buildCommand
  | ({ mode: "binary" } & NativeExecutionExtras)
  // spawn `<python> <script> <rest…>` (repo-cloned CLIs)
  | ({ mode: "script"; script: string } & NativeExecutionExtras)
  // spawn an executable directly (shebang CLIs in tool-owned venvs)
  | ({ mode: "executable"; path: string } & NativeExecutionExtras)
  // spawn `<python> -m <module> <rest…>`
  | ({ mode: "python-module"; module: string } & NativeExecutionExtras);

export interface ToolRegistryEntry {
  key: string;
  label: string;
  category: ToolCategory;
  description: string;
  /** How to detect if installed on the host. */
  detect: {
    type: DetectType;
    /** For binary: check if this command exists on PATH (via `which`). */
    binary?: string;
    /** For python: try importing this module with the resolved python. */
    pythonModule?: string;
    /** For path: check this directory exists under the project root. */
    path?: string;
    /** Version flag for nicer display (optional). */
    versionFlag?: string;
    /** Cluster-side availability check: a shell snippet that exits 0 when
     *  the tool is usable ON THE CLUSTER (e.g. after `module load`). Runs
     *  inside a login shell so module functions exist. */
    clusterCheck?: string;
  };
  /** How the NATIVE tool executes when its detection passes. Omitted → the
   *  built-in real engine executes (status-only detection). */
  nativeExecution?: NativeExecution;
  /** Install spec. `oneClick` = can be installed from the Tools page. */
  install: {
    method: InstallMethod;
    /** The real command that gets run on one-click install. */
    command: string;
    /** Human-readable summary of what the command does. */
    label: string;
    docs: string;
    /** Can this be installed non-interactively in this environment? */
    oneClick: boolean;
    /** Rough install size / download warning. */
    sizeHint?: string;
  };
  /** For external tools: the built-in engine that takes over when the native
   *  tool is missing (engine key from BUILTIN_ENGINES below). */
  builtinEngine?: string;
}

// ── 1. Runtime dependencies ─────────────────────────────────────────────────

export const RUNTIME_ENTRIES: ToolRegistryEntry[] = [
  {
    key: "python3",
    label: "Python 3",
    category: "runtime",
    description:
      "Interpreter for the built-in real algorithm engine (numpy-based scientific computing).",
    detect: { type: "binary", binary: "python3", versionFlag: "--version" },
    install: {
      method: "runtime",
      command: "",
      label: "System package",
      docs: "https://www.python.org/downloads/",
      oneClick: false,
    },
  },
  {
    key: "numpy",
    label: "NumPy",
    category: "runtime",
    description: "Vectorised math for the built-in engine (SASA, contacts, sampling).",
    detect: { type: "python", pythonModule: "numpy" },
    install: {
      method: "pip",
      command: "pip install numpy",
      label: "pip install numpy",
      docs: "https://numpy.org",
      oneClick: true,
      sizeHint: "~20 MB",
    },
  },
  {
    key: "scipy",
    label: "SciPy",
    category: "runtime",
    description: "Optional scientific routines (the engine degrades gracefully without it).",
    detect: { type: "python", pythonModule: "scipy" },
    install: {
      method: "pip",
      command: "pip install scipy",
      label: "pip install scipy",
      docs: "https://scipy.org",
      oneClick: true,
      sizeHint: "~40 MB",
    },
  },
  {
    key: "biopython",
    label: "Biopython",
    category: "runtime",
    description: "Optional bio helpers (PDB/FASTA utilities).",
    detect: { type: "python", pythonModule: "Bio" },
    install: {
      method: "pip",
      command: "pip install biopython",
      label: "pip install biopython",
      docs: "https://biopython.org",
      oneClick: true,
      sizeHint: "~30 MB",
    },
  },
  {
    key: "git",
    label: "Git",
    category: "runtime",
    description: "Required for one-click installs of GitHub-based tools.",
    detect: { type: "binary", binary: "git", versionFlag: "--version" },
    install: {
      method: "runtime",
      command: "",
      label: "System package",
      docs: "https://git-scm.com",
      oneClick: false,
    },
  },
];

// ── 2. Built-in real algorithm engine ───────────────────────────────────────

export interface BuiltinEngine {
  key: string;
  label: string;
  script: string;
  description: string;
  algorithms: string[];
  /** Tools served by this engine. */
  serves: string[];
  /** Honest provenance & accuracy positioning — what published science the
   *  engine implements, and how it compares to the native upstream tool
   *  (which remains the gold standard when installed). */
  provenance?: {
    refs: string[];
    accuracy: string;
  };
}

export const BUILTIN_ENGINES: BuiltinEngine[] = [
  {
    key: "engine-fold",
    label: "Structure Prediction Engine",
    script: "fold_engine.py",
    description:
      "Secondary-structure prediction with the published Chou-Fasman algorithm, recycled consensus smoothing, and geometry-based 3D assembly — the LOCAL fallback for AlphaFold runs.",
    algorithms: [
      "Chou-Fasman 1978 (nucleation + extension rules)",
      "Recycle consensus refinement",
      "Propensity-margin confidence (pLDDT-style)",
      "NeRF backbone assembly",
    ],
    serves: ["alphafold"],
    provenance: {
      refs: [
        "Chou & Fasman, Adv. Enzymol. 47:45-148 (1978) — full published algorithm",
        "Kyte & Doolittle, J. Mol. Biol. 157:105-132 (1982) — hydropathy scale",
      ],
      accuracy:
        "Chou-Fasman Q3 accuracy is ~50-65% on average proteins (its published benchmark) — the honest classical baseline. AlphaFold2 (Jumper et al. 2021) reaches ~0.9 GDT_TS on CASP targets with median pLDDT > 90 for well-ordered domains: connect the mgt GPU cluster for real AF2 predictions; use this engine for education, offline scaffolds and quick iteration.",
    },
  },
];

export function getBuiltinEngine(key: string): BuiltinEngine | undefined {
  return BUILTIN_ENGINES.find((e) => e.key === key);
}

export function engineForTool(toolKey: string): BuiltinEngine | undefined {
  return BUILTIN_ENGINES.find((e) => e.serves.includes(toolKey));
}

// ── 3. External tools ───────────────────────────────────────────────────────

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    key: "alphafold",
    label: "AlphaFold2",
    category: "structure-prediction",
    description:
      "Protein structure prediction (Jumper et al. 2021). Provided on the GPU cluster: salloc -N 1 --gres=gpu:1 -p brain2 → ssh gpu05 → module load alphafold2 → run_alphafold.py. Predicts 3D coordinates for every main-chain atom; outputs five models ranked by pLDDT (ranked_0.pdb = highest confidence).",
    detect: {
      type: "binary",
      binary: "run_alphafold.py",
      // Cluster-side check: the tool only exists after loading the environment
      // module — run inside a login shell so the module function is defined.
      clusterCheck:
        "module load alphafold2 >/dev/null 2>&1 && command -v run_alphafold.py >/dev/null 2>&1",
    },
    nativeExecution: {
      mode: "binary",
      // Real AF2 runs are long (MSA + 5 models + relax) — never kill early.
      timeoutMs: 12 * 60 * 60 * 1000,
    },
    install: {
      method: "binary",
      command: "",
      label: "Provided on the GPU cluster (module load alphafold2) — connect it under Cluster",
      docs: "https://www.nature.com/articles/s41586-021-03819-2",
      oneClick: false,
      sizeHint: "cluster-provided (AF2_db ≈ 2.3 TB on the cluster)",
    },
    builtinEngine: "engine-fold",
  },
];

/** Lookup a registry entry by tool key (external tools). */
export function getToolRegistryEntry(key: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.key === key);
}

/** Lookup across runtime + external entries. */
export function getAnyRegistryEntry(key: string): ToolRegistryEntry | undefined {
  return (
    TOOL_REGISTRY.find((t) => t.key === key) ??
    RUNTIME_ENTRIES.find((t) => t.key === key)
  );
}

/** All external-tool registry keys. */
export function listToolRegistryKeys(): string[] {
  return TOOL_REGISTRY.map((t) => t.key);
}
