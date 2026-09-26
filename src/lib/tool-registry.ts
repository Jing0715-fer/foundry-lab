// Tool registry — runtime deps, built-in compute engines, and external tools.
//
// Three tiers of "tooling" are tracked:
//   1. RUNTIME dependencies — python3, numpy, git… required by the built-in
//      real algorithm engines. Each has a real one-click install command.
//   2. BUILT-IN ENGINES — the real Python algorithm implementations shipped
//      in scripts/algorithms/ (inverse folding, folding, backbone diffusion,
//      antibody builder, knowledge-based scorer). Detected via a fast
//      self-test run; they run real science with zero external deps beyond
//      the runtime tier.
//   3. EXTERNAL TOOLS — the heavyweight upstream packages (RFdiffusion,
//      ProteinMPNN, Rosetta…). When installed natively they are used
//      directly; when missing, execution falls back to the corresponding
//      built-in engine (still a real algorithm — never a simulation).

export type ToolCategory =
  | "runtime"
  | "engine"
  | "design"
  | "inverse-folding"
  | "structure-prediction"
  | "scoring"
  | "bio";

export type DetectType = "binary" | "python" | "path";
export type InstallMethod = "pip" | "github" | "binary" | "runtime";

export type NativeExecution =
  | { mode: "binary" }                        // spawn parts[0] of buildCommand
  | { mode: "script"; script: string; outFolderFlag?: string } // spawn `<python> <script> <rest…>`
  | { mode: "python-module"; module: string } // spawn `<python> -m <module> <rest…>`;

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
      "Interpreter for the built-in real algorithm engines (numpy-based scientific computing).",
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
    description: "Vectorised math for every built-in engine (SASA, contacts, sampling).",
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
    description: "Optional scientific routines (engines degrade gracefully without it).",
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
    description: "Optional bio helpers (PDB/FASTA utilities for future engines).",
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
    description: "Required for one-click installs of GitHub-based external tools.",
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

// ── 2. Built-in real algorithm engines ──────────────────────────────────────

export interface BuiltinEngine {
  key: string;
  label: string;
  script: string;
  description: string;
  algorithms: string[];
  /** Tools served by this engine. */
  serves: string[];
}

export const BUILTIN_ENGINES: BuiltinEngine[] = [
  {
    key: "engine-diffusion",
    label: "Backbone Diffusion Engine",
    script: "diffusion_engine.py",
    description:
      "De-novo backbone generation via Ramachandran-basin torsion sampling with crash-filtered fragment growth and backtracking.",
    algorithms: [
      "Ramachandran basin statistics (bivariate Gaussians)",
      "NeRF chain construction (Engh & Huber geometry)",
      "Rodrigues point-group symmetry (Cn / D2)",
      "Steric quality control + resampling",
    ],
    serves: ["rfdiffusion"],
  },
  {
    key: "engine-fold",
    label: "Structure Prediction Engine",
    script: "fold_engine.py",
    description:
      "Secondary-structure prediction with the published Chou-Fasman algorithm, recycled consensus smoothing, and geometry-based 3D assembly.",
    algorithms: [
      "Chou-Fasman 1978 (nucleation + extension rules)",
      "Recycle consensus refinement",
      "Propensity-margin confidence (pLDDT-style)",
      "NeRF backbone assembly",
    ],
    serves: ["esmfold", "rf3", "colabfold"],
  },
  {
    key: "engine-mpnn",
    label: "Inverse Folding Engine",
    script: "mpnn_engine.py",
    description:
      "Gibbs-sampled sequence design over a knowledge-based statistical potential computed from the real input backbone.",
    algorithms: [
      "Chou-Fasman SS-conditioned propensities",
      "Miyazawa-Jernigan contact potential (1996)",
      "Shrake-Rupley SASA burial terms",
      "Boltzmann sampling at ProteinMPNN-style temperatures",
    ],
    serves: ["proteinmpnn", "ligandmpnn", "solublempnn"],
  },
  {
    key: "engine-score",
    label: "Knowledge-Based Scoring Engine",
    script: "score_engine.py",
    description:
      "Rosetta-style scoring: MJ contacts + Ramachandran likelihood + solvation + steric clashes, MC minimization, ΔSASA interfaces, alanine-scan ΔΔG.",
    algorithms: [
      "Miyazawa-Jernigan contact energy",
      "Metropolis Monte-Carlo minimization",
      "Shrake-Rupley ΔSASA interface analysis (γ=0.025 kcal/mol/Å²)",
      "Computational alanine scan",
    ],
    serves: ["rosetta", "pyrosetta"],
  },
  {
    key: "engine-antibody",
    label: "Antibody Design Engine",
    script: "antibody_engine.py",
    description:
      "Germline-framework Fv builder with IMGT canonical CDR loops sampled from the real Tyr/Gly/Ser-enriched CDR composition.",
    algorithms: [
      "Human germline consensus frameworks",
      "IMGT canonical CDR lengths",
      "CDR composition sampling (Sidhu & Fellouse)",
      "VH/VL pairing geometry + interface ΔSASA",
    ],
    serves: ["rfantibody"],
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
    key: "rfdiffusion",
    label: "RFdiffusion",
    category: "design",
    description:
      "De novo protein structure design via diffusion (scaffolds, binders, symmetric assemblies).",
    detect: { type: "binary", binary: "RFdiffusion" },
    nativeExecution: { mode: "binary" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/RosettaCommons/RFdiffusion.git external-tools/RFdiffusion && cd external-tools/RFdiffusion && pip install -e .",
      label: "Clone repo + pip install",
      docs: "https://github.com/RosettaCommons/RFdiffusion",
      oneClick: true,
      sizeHint: "~1 GB (checkpoints not included)",
    },
    builtinEngine: "engine-diffusion",
  },
  {
    key: "rfantibody",
    label: "RFantibody",
    category: "design",
    description: "Antibody structure design & CDR grafting against target epitopes.",
    detect: { type: "binary", binary: "RFantibody" },
    nativeExecution: { mode: "binary" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/RosettaCommons/rfantibody.git external-tools/rfantibody && cd external-tools/rfantibody && pip install -e .",
      label: "Clone repo + pip install",
      docs: "https://github.com/RosettaCommons/rfantibody",
      oneClick: true,
      sizeHint: "large",
    },
    builtinEngine: "engine-antibody",
  },
  {
    key: "proteinmpnn",
    label: "ProteinMPNN",
    category: "inverse-folding",
    description: "Inverse folding — design sequences for given backbones.",
    detect: { type: "path", path: "external-tools/ProteinMPNN" },
    nativeExecution: { mode: "script", script: "external-tools/ProteinMPNN/protein_mpnn_run.py", outFolderFlag: "--out_folder" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/dauparas/ProteinMPNN.git external-tools/ProteinMPNN && python3 -m pip install torch --index-url https://download.pytorch.org/whl/cpu",
      label: "Clone repo + install CPU torch",
      docs: "https://github.com/dauparas/ProteinMPNN",
      oneClick: true,
      sizeHint: "~800 MB incl. CPU torch",
    },
    builtinEngine: "engine-mpnn",
  },
  {
    key: "ligandmpnn",
    label: "LigandMPNN",
    category: "inverse-folding",
    description: "Inverse folding with ligand context awareness.",
    detect: { type: "path", path: "external-tools/LigandMPNN" },
    nativeExecution: { mode: "script", script: "external-tools/LigandMPNN/ligandmpnn_run.py", outFolderFlag: "--out_folder" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/dauparas/LigandMPNN.git external-tools/LigandMPNN",
      label: "Clone repo",
      docs: "https://github.com/dauparas/LigandMPNN",
      oneClick: true,
      sizeHint: "~50 MB",
    },
    builtinEngine: "engine-mpnn",
  },
  {
    key: "solublempnn",
    label: "SolubleMPNN",
    category: "inverse-folding",
    description: "Solubility-optimized inverse folding variant.",
    detect: { type: "path", path: "external-tools/ProteinMPNN" },
    nativeExecution: { mode: "script", script: "external-tools/ProteinMPNN/protein_mpnn_run.py", outFolderFlag: "--out_folder" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/dauparas/ProteinMPNN.git external-tools/ProteinMPNN && python3 -m pip install torch --index-url https://download.pytorch.org/whl/cpu",
      label: "Clone repo + install CPU torch",
      docs: "https://github.com/dauparas/ProteinMPNN",
      oneClick: true,
      sizeHint: "~50 MB",
    },
    builtinEngine: "engine-mpnn",
  },
  {
    key: "rosetta",
    label: "Rosetta",
    category: "scoring",
    description: "Energy minimization, docking, and interface analysis via rosetta_scripts.",
    detect: { type: "binary", binary: "rosetta_scripts" },
    nativeExecution: { mode: "binary" },
    install: {
      method: "binary",
      command: "",
      label: "Manual download (license required)",
      docs: "https://www.rosettacommons.org/software",
      oneClick: false,
      sizeHint: "~5 GB, academic license",
    },
    builtinEngine: "engine-score",
  },
  {
    key: "pyrosetta",
    label: "PyRosetta",
    category: "scoring",
    description: "Interactive Rosetta scoring in Python.",
    detect: { type: "python", pythonModule: "pyrosetta" },
    install: {
      method: "pip",
      command: "pip install pyrosetta",
      label: "pip install (requires license credentials)",
      docs: "https://pyrosetta.org",
      oneClick: true,
      sizeHint: "license-gated",
    },
    builtinEngine: "engine-score",
  },
  {
    key: "rf3",
    label: "RoseTTAFold3",
    category: "structure-prediction",
    description: "Structure prediction from sequence with confidence metrics.",
    detect: { type: "binary", binary: "rf3" },
    nativeExecution: { mode: "binary" },
    install: {
      method: "github",
      command:
        "git clone --depth 1 https://github.com/RosettaCommons/RoseTTAFold3.git external-tools/RoseTTAFold3",
      label: "Clone repo",
      docs: "https://github.com/RosettaCommons/RoseTTAFold3",
      oneClick: true,
      sizeHint: "~2 GB",
    },
    builtinEngine: "engine-fold",
  },
  {
    key: "esmfold",
    label: "ESMFold",
    category: "structure-prediction",
    description: "Fast single-sequence structure prediction (fair-esm).",
    detect: { type: "python", pythonModule: "esm" },
    install: {
      method: "pip",
      command: "pip install fair-esm torch",
      label: "pip install fair-esm torch (full stack)",
      docs: "https://github.com/facebookresearch/esm",
      oneClick: true,
      sizeHint: "~2.5 GB incl. torch",
    },
    builtinEngine: "engine-fold",
  },
  {
    key: "colabfold",
    label: "ColabFold",
    category: "structure-prediction",
    description: "AlphaFold2-based prediction with MSA.",
    detect: { type: "binary", binary: "colabfold_batch" },
    nativeExecution: { mode: "binary" },
    install: {
      method: "pip",
      command: 'pip install "colabfold[alphafold]"',
      label: "pip install colabfold",
      docs: "https://github.com/sokrypton/ColabFold",
      oneClick: true,
      sizeHint: "~1 GB",
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
