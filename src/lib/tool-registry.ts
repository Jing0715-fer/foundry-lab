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
//      ProteinMPNN, Rosetta… plus AlphaFold2). When installed natively they
//      are used directly; when missing, execution falls back to the
//      corresponding built-in engine (still a real algorithm — never a
//      simulation). AlphaFold2 itself is provided on the GPU cluster
//      (salloc → ssh gpu05 → module load alphafold2 → run_alphafold.py).

export type ToolCategory =
  | "runtime"
  | "engine"
  | "design"
  | "inverse-folding"
  | "scoring"
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
   *  prefix-taking dashed flags (RFantibody's `-o`). */
  outFolderFlag?: string;
  outFolderIsPrefix?: boolean;
  /** Fixed args appended verbatim after the built command (e.g.
   *  `inference.write_trajectory=False` to keep job outputs clean). */
  fixedArgs?: string[];
  /** Per-tool execution timeout; default 5 min. Heavy CPU tools raise it. */
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
    provenance: {
      refs: [
        "Chou & Fasman, Adv. Enzymol. 47:45-148 (1978) — SS propensity tables",
        "Hovmöller et al., Acta Cryst. D58:768-776 (2002) — observed Ramachandran distributions",
        "Engh & Huber, Acta Cryst. A47:392-400 (1991) — protein bond geometry",
      ],
      accuracy:
        "From-scratch re-implementation of the published statistical methods — NOT the trained RFdiffusion network. Produces geometry-valid backbones (bond lengths/angles within Engh-Huber SD, clash-filtered ≤2-7 per design), but the fold distribution comes from Ramachandran statistics rather than learned protein grammar. Install native RFdiffusion for state-of-the-art design.",
    },
  },
  {
    key: "engine-fold",
    label: "Structure Prediction Engine",
    script: "fold_engine.py",
    description:
      "Secondary-structure prediction with the published Chou-Fasman algorithm, recycled consensus smoothing, and geometry-based 3D assembly — also the LOCAL fallback for AlphaFold runs.",
    algorithms: [
      "Chou-Fasman 1978 (nucleation + extension rules)",
      "Recycle consensus refinement",
      "Propensity-margin confidence (pLDDT-style)",
      "NeRF backbone assembly",
    ],
    serves: ["esmfold", "rf3", "colabfold", "alphafold"],
    provenance: {
      refs: [
        "Chou & Fasman, Adv. Enzymol. 47:45-148 (1978) — full published algorithm",
        "Kyte & Doolittle, J. Mol. Biol. 157:105-132 (1982) — hydropathy scale",
      ],
      accuracy:
        "Chou-Fasman Q3 accuracy is ~50-65% on average proteins (its published benchmark) — the honest classical baseline. Modern trained predictors exceed 80% Q3 / ~0.8 GDT_TS; AlphaFold2 (Jumper et al. 2021) reaches ~0.9 GDT_TS with median pLDDT > 90 for well-ordered domains — connect the mgt GPU cluster for real AF2 predictions. Use this engine for education, offline scaffolds and quick iteration.",
    },
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
    provenance: {
      refs: [
        "Miyazawa & Jernigan, J. Mol. Biol. 256:623-644 (1996) — 20×20 contact matrix",
        "Shrake & Rupley, Biochemistry 12:3361 (1973) — SASA algorithm",
        "Tien et al., PLoS ONE 8:e80635 (2013) — max-SASA normalization",
      ],
      accuracy:
        "REAL Gibbs sampling over a knowledge-based statistical potential computed from your actual backbone (contacts, burial, propensities). Not the trained ProteinMPNN graph neural network — native MPNN recovers ~30-50% of native sequences; this sampler explores the same sequence space with a physics-derived energy, trading recovery for interpretability. Install native ProteinMPNN for production design.",
    },
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
    provenance: {
      refs: [
        "Miyazawa & Jernigan (1996) — contact energies",
        "Chothia, Nature 248:338 (1974) — buried-surface/ΔG correlation (γ)",
        "Tien et al. (2013) — max-SASA for burial fractions",
      ],
      accuracy:
        "Rosetta-STYLE knowledge-based scoring (MJ contacts + Ramachandran likelihood + solvation + steric clashes) — not the full Rosetta ref2015 energy function with its finely tuned Lennard-Jones/electrostatics. Ranking and ΔΔG trends are meaningful for coarse comparison; absolute energies are not comparable to Rosetta REU. Install Rosetta/PyRosetta for publication-grade energies.",
    },
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
    provenance: {
      refs: [
        "Sidhu & Fellouse, Methods Mol. Biol. 207:27-41 (2008) — synthetic antibody libraries",
        "Al-Lazikani et al., J. Mol. Biol. 273:927-948 (1997) — canonical CDR structures",
        "Tien et al. (2013) — SASA normalization for interface analysis",
      ],
      accuracy:
        "Germline frameworks + IMGT canonical loop lengths + Tyr/Gly/Ser-enriched CDR sampling follow the published statistics of real antibody repertoires. Geometry is Engh-Huber-valid and clash-filtered; CDR conformations are statistical (canonical classes), not the RFantibody network's learned structures.",
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
    key: "rfdiffusion",
    label: "RFdiffusion",
    category: "design",
    description:
      "De novo protein structure design via diffusion (scaffolds, binders, symmetric assemblies).",
    // pip-installable package (import check) — fast, no torch import cost.
    detect: { type: "python", pythonModule: "rfdiffusion" },
    nativeExecution: {
      mode: "script",
      script: "external-tools/RFdiffusion/scripts/run_inference.py",
      // RFdiffusion writes to `inference.output_prefix`; route it into the
      // job workDir so output collection picks the designed PDBs up.
      outputPrefixFlag: "inference.output_prefix",
      // Keep per-step trajectory dumps out of the job artifacts.
      fixedArgs: ["inference.write_trajectory=False"],
      // Real diffusion on CPU is slow (≈1.5 min per 50-res design) — allow
      // long runs instead of killing them at the default 5-minute mark.
      timeoutMs: 20 * 60 * 1000,
    },
    install: {
      method: "github",
      command:
        "if [ ! -d external-tools/RFdiffusion/.git ]; then git clone --depth 1 https://github.com/RosettaCommons/RFdiffusion.git external-tools/RFdiffusion; fi && cd external-tools/RFdiffusion && " +
        "pip install ./env/SE3Transformer && " +
        "pip install -e . && " +
        // setup.py under-declares the real runtime deps (their conda env has
        // them all) — install what the inference path actually imports:
        "pip install hydra-core opt_einsum pyrsistent e3nn dgl && " +
        // dgl 2.1 needs the classic datapipes API (0.7.1); newer torchdata
        // dropped it and breaks `import dgl`:
        'pip install "torchdata==0.7.1" && ' +
        // CPU-compat patches (nvtx no-op on CPU, best-effort dgl GraphBolt):
        "python3 ../../scripts/patches/rfdiffusion_cpu.py && " +
        // Default + PPI checkpoints (the two the app's param surface uses):
        "mkdir -p models && " +
        "wget -q -c -O models/Base_ckpt.pt http://files.ipd.uw.edu/pub/RFdiffusion/6f5902ac237024bdd0c176cb93063dc4/Base_ckpt.pt && echo 'checkpoint: Base_ckpt.pt (484 MB)' && " +
        "wget -q -c -O models/Complex_base_ckpt.pt http://files.ipd.uw.edu/pub/RFdiffusion/e29311f6f1bf1af907f9ef9f44b8328b/Complex_base_ckpt.pt && echo 'checkpoint: Complex_base_ckpt.pt (484 MB)' && " +
        "echo 'RFdiffusion ready: package + SE3Transformer + CPU patches + Base/Complex checkpoints.'",
      label:
        "Clone repo + pip install (vendored SE3Transformer + deps) + CPU patches + Base/Complex checkpoints",
      docs: "https://github.com/RosettaCommons/RFdiffusion",
      oneClick: true,
      sizeHint: "~1.1 GB (repo + deps + 2 checkpoints)",
    },
    builtinEngine: "engine-diffusion",
  },
  {
    key: "rfantibody",
    label: "RFantibody",
    category: "design",
    description: "Antibody structure design & CDR grafting against target epitopes.",
    // Official install = `uv sync` → own Python 3.10 venv with the CLI entry:
    detect: { type: "path", path: "external-tools/rfantibody/.venv/bin/rfdiffusion" },
    nativeExecution: {
      mode: "executable",
      path: "external-tools/rfantibody/.venv/bin/rfdiffusion",
      // RFdiffusion-family `-o` takes an output PREFIX (files get suffixed).
      outFolderFlag: "-o",
      outFolderIsPrefix: true,
      fixedArgs: ["--no-trajectory"],
      timeoutMs: 20 * 60 * 1000,
    },
    install: {
      method: "github",
      command:
        "if [ ! -d external-tools/rfantibody/.git ]; then git clone --depth 1 https://github.com/RosettaCommons/rfantibody.git external-tools/rfantibody; fi && cd external-tools/rfantibody && uv sync",
      label: "Clone repo + uv sync (official installer — own Python 3.10 venv)",
      docs: "https://github.com/RosettaCommons/rfantibody",
      oneClick: true,
      sizeHint: "~4 GB (CUDA torch + DGL in its own venv; NVIDIA GPU required to run designs)",
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
    description: "AlphaFold2-based structure prediction with MSA (colabfold_batch).",
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
