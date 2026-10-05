// Foundry platform integration (RosettaCommons/foundry — the `rc-foundry` wheel).
//
// Foundry is the official RosettaCommons platform for biomolecular foundation
// models: RFD3 (design), ProteinMPNN/LigandMPNN/SolubleMPNN (inverse folding)
// and RF3 (structure prediction), unified through atomworks.
//
// This module is DETECTION + STATUS ONLY (no spawning) so real-executor.ts
// can import it without cycles. Detection honors:
//   1. $FOUNDRY_PYTHON  — explicit path to a python in a foundry environment
//   2. /home/z/.venv-foundry/bin/python — the local one-click install target
//   3. <project>/external-tools/foundry/.venv/bin/python — repo-local install
//
// Checkpoints live in ~/.foundry/checkpoints (+ $FOUNDRY_CHECKPOINT_DIRS),
// managed by the `foundry install` CLI. See scripts/foundry/run_mpnn.py for
// the real MPNN inference bridge.

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { runCapture } from "./platform";

export interface FoundryCheckpoint {
  /** File name, e.g. ligandmpnn_v_32_010_25.pt */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Human size, e.g. "0.01 GB". */
  size: string;
}

export interface FoundryStatus {
  /** Platform installed (a python that imports mpnn + foundry CLI exists). */
  installed: boolean;
  /** Absolute python interpreter of the foundry venv (null if not installed). */
  python: string | null;
  /** `foundry` CLI entry point (null if not installed). */
  cli: string | null;
  /** rc-foundry wheel version (null when unknown). */
  version: string | null;
  /** Torch build string, e.g. 2.14.0+cpu. */
  torch: string | null;
  /** CUDA available to that torch. */
  cuda: boolean;
  /** Checkpoints found by `foundry list-installed`. */
  checkpoints: FoundryCheckpoint[];
  /** Real capabilities derived from imports + checkpoints. */
  capabilities: {
    /** MPNN family runnable (import mpnn + at least one mpnn checkpoint). */
    mpnn: boolean;
    /** RFD3 weights present (execution additionally needs a GPU in practice). */
    rfd3: boolean;
    /** RF3 weights present (needs cuEquivariance + GPU in practice). */
    rf3: boolean;
  };
  /** Import-level self-test of the MPNN engine (fast, cached). */
  selftestOk: boolean;
  selftestDetail: string;
}

// ── Python resolution ───────────────────────────────────────────────────────

const FOUNDRY_PY_CANDIDATES = (): string[] => {
  // venv layout differs by platform: bin/python vs Scripts\python.exe
  const venvLayout =
    process.platform === "win32"
      ? join("external-tools", "foundry", ".venv", "Scripts", "python.exe")
      : join("external-tools", "foundry", ".venv", "bin", "python");
  const list = [
    process.env.FOUNDRY_PYTHON,
    "/home/z/.venv-foundry/bin/python",
    join(process.cwd(), venvLayout),
  ].filter((p): p is string => !!p);
  return list;
};

let cachedPython: string | null | undefined;

/**
 * Resolve a python interpreter that can import the foundry MPNN stack.
 * `null` when foundry is not installed on this host. spawnSync ARRAY form —
 * no shell, so venv paths with spaces survive.
 */
export function resolveFoundryPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  for (const cand of FOUNDRY_PY_CANDIDATES()) {
    if (!existsSync(cand)) continue;
    try {
      const res = spawnSync(cand, ["-c", "import foundry, mpnn"], {
        stdio: "pipe",
        timeout: 30000,
      });
      if (res.status === 0 && !res.error) {
        cachedPython = cand;
        return cand;
      }
    } catch {
      /* candidate lacks the package — try next */
    }
  }
  cachedPython = null;
  return null;
}

/** Reset the resolution cache (after installs). */
export function invalidateFoundryCache(): void {
  cachedPython = undefined;
  statusCache = undefined;
}

// ── Status ──────────────────────────────────────────────────────────────────

const STATUS_TTL_MS = 60_000;
let statusCache: { at: number; status: FoundryStatus } | undefined;

// The old string-shelling `sh()` was replaced by platform.runCapture —
// spawnSync ARRAY form (no shell), stdout only, null on failure/timeout.

/**
 * Full platform status (cached 60s). Cheap after the first call.
 */
export function getFoundryStatus(): FoundryStatus {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.status;
  }
  const py = resolveFoundryPython();

  const status: FoundryStatus = {
    installed: !!py,
    python: py,
    // venv CLI entry: bin/foundry (POSIX) / Scripts\foundry.exe (win32)
    cli: py
      ? resolve(py, "..", process.platform === "win32" ? "foundry.exe" : "foundry")
      : null,
    version: null,
    torch: null,
    cuda: false,
    checkpoints: [],
    capabilities: { mpnn: false, rfd3: false, rf3: false },
    selftestOk: false,
    selftestDetail: "not installed",
  };
  if (!py) {
    statusCache = { at: Date.now(), status };
    return status;
  }

  // Wheel version + torch build + cuda in one process (imports are heavy).
  const meta = runCapture(
    py,
    [
      "-c",
      "import importlib.metadata as im, torch; " +
        "print(im.version('rc-foundry')); " +
        "print(torch.__version__); " +
        "print(torch.cuda.is_available())",
    ],
    45000,
  );
  if (meta) {
    const [ver, torchV, cuda] = meta.trim().split(/\r?\n/);
    status.version = ver || null;
    status.torch = torchV || null;
    status.cuda = cuda === "True";
  }

  // Checkpoints via the official CLI (honors FOUNDRY_CHECKPOINT_DIRS).
  const listing = status.cli
    ? runCapture(status.cli, ["list-installed"], 60000)
    : null;
  if (listing) {
    for (const line of listing.split(/\r?\n/)) {
      // Paths may be POSIX (/x/y.pt) or win32 (C:\x\y.pt)
      const m = line.match(/\s*((?:[A-Za-z]:)?[\/\\]\S+\.pt)\s+([\d.]+\s*GB)/);
      if (m) {
        const p = m[1];
        status.checkpoints.push({
          path: p,
          name: p.split(/[\/\\]/).pop() ?? p,
          size: m[2].replace(/\s+/, " "),
        });
      }
    }
  }

  // Capability: mpnn import + any mpnn-family checkpoint on disk.
  const hasCkpt = (needle: RegExp) =>
    status.checkpoints.some((c) => needle.test(c.name));
  status.capabilities.mpnn =
    hasCkpt(/(proteinmpnn|ligandmpnn|solublempnn)/i);
  status.capabilities.rfd3 = hasCkpt(/rfd3/i);
  status.capabilities.rf3 = hasCkpt(/rf3/i);

  // Fast import selftest of the runner bridge (no weights touched).
  const raw = runCapture(
    py,
    [join(process.cwd(), "scripts", "foundry", "run_mpnn.py"), "--selftest"],
    90000,
  );
  const st = raw ? raw.trim().split(/\r?\n/).slice(-3).join("\n") : null; // old `| tail -3`
  status.selftestOk = !!st && st.includes("SELFTEST OK");
  status.selftestDetail = st ? st.split("\n").slice(-1)[0] : "selftest did not run";
  // Full capability requires the engine to actually import.
  status.capabilities.mpnn = status.capabilities.mpnn && status.selftestOk;

  statusCache = { at: Date.now(), status };
  return status;
}

/** MPNN family executable through foundry right now (cached status). */
export function isFoundryMpnnReady(): boolean {
  return getFoundryStatus().capabilities.mpnn;
}

/**
 * Which MPNN model variant a tool job maps to.
 * Mirrors the app's param surface (proteinmpnn's ligand/soluble booleans).
 */
export function foundryMpnnVariant(
  toolKey: string,
  params: Record<string, unknown>,
): { model: "protein_mpnn" | "ligand_mpnn"; soluble: boolean } {
  const soluble = params.soluble === true || toolKey === "solublempnn";
  // SolubleMPNN = protein_mpnn architecture with soluble weights. Everything
  // else runs ligand_mpnn — the ligand-aware superset that also handles
  // protein-only backbones perfectly.
  return { model: soluble ? "protein_mpnn" : "ligand_mpnn", soluble };
}

/** Tools that foundry can execute natively (official re-implementation). */
export const FOUNDRY_MPNN_TOOLS = new Set([
  "proteinmpnn",
  "ligandmpnn",
  "solublempnn",
]);
