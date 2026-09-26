// Real tool registry — detection + install info + execution specs for each comp tool.
// This is the bridge between the abstract COMP_TOOLS definitions (which describe the
// CLI surface and parameters) and the actual host environment (which may or may not
// have the tool installed). The registry is consulted by the real-executor at run
// time to decide whether to spawn a real subprocess or fall back to simulation.

export type ToolCategory =
  | "design"
  | "inverse-folding"
  | "structure-prediction"
  | "scoring"
  | "bio";

export type DetectType = "binary" | "python" | "conda";
export type InstallMethod = "pip" | "conda" | "github" | "binary";
export type ExecuteType = "binary" | "python-script" | "python-function";

export interface ToolRegistryEntry {
  key: string;
  label: string;
  category: ToolCategory;
  /** How to detect if installed on the host. */
  detect: {
    type: DetectType;
    /** For binary: check if this command exists on PATH (via `which`). */
    binary?: string;
    /** For python: try importing this module with /usr/bin/python3. */
    pythonModule?: string;
    /** For conda: check if this conda env exists (conda-based detection reserved). */
    condaEnv?: string;
  };
  /** Install command shown to the user (and runnable via one-click). */
  install: {
    method: InstallMethod;
    command: string;
    docs: string;
  };
  /** Real execution: how to spawn the tool. */
  execute: {
    type: ExecuteType;
    /** For binary type: the binary name (must be on PATH). */
    binaryCommand?: string;
    /** For python-script: path to a script in scripts/ dir. */
    pythonScript?: string;
    /** For python-function: module + function name. */
    pythonModule?: string;
    pythonFunction?: string;
  };
}

/**
 * TOOL_REGISTRY — one entry per comp tool. Keep this in sync with COMP_TOOLS in
 * `./tools.ts` (the keys must match `CompToolKey` in `./types.ts`).
 */
export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    key: "rfdiffusion",
    label: "RFdiffusion",
    category: "design",
    detect: { type: "binary", binary: "RFdiffusion" },
    install: {
      method: "github",
      command:
        "git clone https://github.com/RosettaCommons/RFdiffusion.git && cd RFdiffusion && pip install -e .",
      docs: "https://github.com/RosettaCommons/RFdiffusion",
    },
    execute: { type: "binary", binaryCommand: "RFdiffusion" },
  },
  {
    key: "rfantibody",
    label: "RFantibody",
    category: "design",
    detect: { type: "binary", binary: "RFantibody" },
    install: {
      method: "github",
      command: "git clone https://github.com/RosettaCommons/rfantibody.git",
      docs: "https://github.com/RosettaCommons/rfantibody",
    },
    execute: { type: "binary", binaryCommand: "RFantibody" },
  },
  {
    key: "proteinmpnn",
    label: "ProteinMPNN",
    category: "inverse-folding",
    detect: { type: "python", pythonModule: "proteinmpnn" },
    install: {
      method: "github",
      command:
        "git clone https://github.com/dauparas/ProteinMPNN.git && pip install -r ProteinMPNN/env/SE3Transformer/requirements.txt",
      docs: "https://github.com/dauparas/ProteinMPNN",
    },
    execute: { type: "python-script", pythonScript: "proteinmpnn_run.py" },
  },
  {
    key: "ligandmpnn",
    label: "LigandMPNN",
    category: "inverse-folding",
    detect: { type: "python", pythonModule: "ligandmpnn" },
    install: {
      method: "github",
      command: "git clone https://github.com/dauparas/LigandMPNN.git",
      docs: "https://github.com/dauparas/LigandMPNN",
    },
    execute: { type: "python-script", pythonScript: "ligandmpnn_run.py" },
  },
  {
    key: "solublempnn",
    label: "SolubleMPNN",
    category: "inverse-folding",
    detect: { type: "python", pythonModule: "solublempnn" },
    install: {
      method: "github",
      command: "git clone https://github.com/dauparas/SolubleMPNN.git",
      docs: "https://github.com/dauparas/SolubleMPNN",
    },
    execute: { type: "python-script", pythonScript: "solublempnn_run.py" },
  },
  {
    key: "rosetta",
    label: "Rosetta",
    category: "scoring",
    detect: { type: "binary", binary: "rosetta_scripts" },
    install: {
      method: "binary",
      command: "Download from https://www.rosettacommons.org/software",
      docs: "https://www.rosettacommons.org/software",
    },
    execute: { type: "binary", binaryCommand: "rosetta_scripts" },
  },
  {
    key: "pyrosetta",
    label: "PyRosetta",
    category: "scoring",
    detect: { type: "python", pythonModule: "pyrosetta" },
    install: {
      method: "pip",
      command: "pip install pyrosetta",
      docs: "https://pyrosetta.org",
    },
    execute: {
      type: "python-function",
      pythonModule: "pyrosetta",
      pythonFunction: "score",
    },
  },
  {
    key: "rf3",
    label: "RoseTTAFold3",
    category: "structure-prediction",
    detect: { type: "binary", binary: "rf3" },
    install: {
      method: "github",
      command: "git clone https://github.com/RosettaCommons/RoseTTAFold3.git",
      docs: "https://github.com/RosettaCommons/RoseTTAFold3",
    },
    execute: { type: "binary", binaryCommand: "rf3" },
  },
  {
    key: "esmfold",
    label: "ESMFold",
    category: "structure-prediction",
    detect: { type: "python", pythonModule: "esm" },
    install: {
      method: "pip",
      command: "pip install fair-esm",
      docs: "https://github.com/facebookresearch/esm",
    },
    execute: {
      type: "python-function",
      pythonModule: "esmfold",
      pythonFunction: "predict",
    },
  },
  {
    key: "colabfold",
    label: "ColabFold",
    category: "structure-prediction",
    detect: { type: "python", pythonModule: "colabfold" },
    install: {
      method: "pip",
      command: "pip install colabfold[alphafold]",
      docs: "https://github.com/sokrypton/ColabFold",
    },
    execute: {
      type: "python-function",
      pythonModule: "colabfold",
      pythonFunction: "predict",
    },
  },
];

/** Lookup a registry entry by tool key. */
export function getToolRegistryEntry(
  key: string,
): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.key === key);
}

/** All registry keys (useful for scans + UI). */
export function listToolRegistryKeys(): string[] {
  return TOOL_REGISTRY.map((t) => t.key);
}
