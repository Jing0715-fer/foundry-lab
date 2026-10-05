// Install job manager — REAL installs via child_process with live logs.
//
// POST /api/tools/install { key } starts a job that runs the entry's real
// install command (pip install / git clone + pip install -e .). Output is
// streamed into an in-memory ring buffer that the UI polls via
// GET /api/tools/install/[id]. Jobs live for the lifetime of the dev server
// process (module-level Map).
//
// Cross-platform behavior:
//   - macOS / Linux (and Windows WITH bash): unchanged — the command runs
//     through `bash -c` so pipes/chains work, with python3/pip rewritten to
//     the resolved engine python.
//   - Windows WITHOUT bash: github-method installs are bash scripts → the
//     job is refused with WSL guidance. Simple `pip install …` commands are
//     rewritten to `<resolved-python> -m pip install …` and spawned with an
//     ARGS ARRAY (no shell).
//
// When a job settles (success OR failure) every detection cache is
// invalidated (real-executor python, foundry, screening when available) so
// /api/tools/scan sees the new state without a dev-server restart.

import { spawn } from "child_process";
import { getAnyRegistryEntry, type ToolRegistryEntry } from "./tool-registry";
import {
  resolveEnginePython,
  invalidateEnginePythonCache,
  pythonSpawnTokens,
} from "./real-executor";
import { invalidateFoundryCache } from "./foundry";
import { bashAvailable } from "./platform";
import { randomUUID } from "crypto";

export interface InstallJob {
  id: string;
  key: string;
  label: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logs: string[]; // timestamped log lines (capped)
}

const MAX_LOG_LINES = 2000;

// Module-level store (single dev-server process; adequate for the Tools page).
const globalStore = globalThis as unknown as { __foundryInstallJobs?: Map<string, InstallJob> };
const installJobs: Map<string, InstallJob> =
  globalStore.__foundryInstallJobs ?? new Map();
globalStore.__foundryInstallJobs = installJobs;

export function getInstallJob(id: string): InstallJob | undefined {
  return installJobs.get(id);
}

export function listInstallJobs(): InstallJob[] {
  return [...installJobs.values()].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt),
  );
}

/**
 * Start a REAL install for a registry entry key. Returns the job (running).
 * The install command is executed with bash -c so pipes/chains work — except
 * on Windows without bash, where simple pip installs run shell-less through
 * the resolved python (see file header).
 */
export function startInstall(key: string): InstallJob | { error: string } {
  const entry = getAnyRegistryEntry(key);
  if (!entry) return { error: `Unknown tool key: ${key}` };
  if (!entry.install.oneClick || !entry.install.command) {
    return {
      error:
        `"${entry.label}" cannot be installed from here — see ${entry.install.docs} ` +
        `(${entry.install.label}).`,
    };
  }
  // One install job per key at a time.
  for (const job of installJobs.values()) {
    if (job.key === key && job.status === "running") {
      return { error: `An install for ${entry.label} is already running.` };
    }
  }

  const id = randomUUID();

  // ── Windows without bash ────────────────────────────────────────────────
  if (process.platform === "win32" && !bashAvailable()) {
    const simplePip = /^pip\s+install(\s|$)/.test(entry.install.command);
    if (entry.install.method !== "pip" || !simplePip) {
      // github-method commands (clone + chains) and the foundry multi-step
      // chain are bash scripts — they cannot run shell-less.
      return {
        error:
          `"${entry.label}" 的一键安装是 bash 脚本；` +
          `Windows 请启用 WSL 后重试，或手动安装后由 Environment 面板检测。`,
      };
    }
    return startWinNoShellPip(entry, id);
  }

  // Run pip AND python3 through the resolved engine python so installs and
  // post-install patch steps land in the same environment the engines use
  // (avoids PEP-668 system-pip rejections AND patches targeting the wrong
  // interpreter's site-packages).
  const py = resolveEnginePython();
  // Command-string form of the resolved python ("py" needs its -3 prefix).
  const pyStr = py
    ? [pythonSpawnTokens(py).cmd, ...pythonSpawnTokens(py).preArgs].join(" ")
    : null;
  let command = entry.install.command;
  if (pyStr && pyStr !== "python3") {
    // Rewrites at command/chain boundaries only — never inside URLs or paths.
    const boundary = /(^|&&\s*|\|\|\s*|;\s*)python3(?=\s)/g;
    if (/(^|\s)pip install/.test(command) || boundary.test(command)) {
      command = command.replace(boundary, `$1${pyStr}`);
      command = command.replace(/(^|&&\s*)pip install/g, `$1${pyStr} -m pip install`);
    }
  } else if (py && /(^|\s)pip install/.test(command)) {
    command = command.replace(/(^|&&\s*)pip install/g, `$1${py} -m pip install`);
  }
  const job: InstallJob = {
    id,
    key,
    label: entry.label,
    command,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logs: [
      `[${ts()}] $ ${command}`,
      `[${ts()}] Installing ${entry.label} (${entry.install.label})…`,
    ],
  };
  installJobs.set(id, job);

  const proc = spawn("bash", ["-c", command], {
    cwd: process.cwd(),
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
  wireInstallJob(job, proc);

  return job;
}

/**
 * Windows-without-bash pip install: rewrite `pip install <pkgs…>` to the
 * resolved python and spawn with an ARGS ARRAY (shell: false). The engine
 * python needs numpy — when it isn't resolvable yet (installing numpy
 * itself on a fresh box) fall back to plain "python".
 */
function startWinNoShellPip(entry: ToolRegistryEntry, id: string): InstallJob {
  const py = resolveEnginePython() ?? "python";
  const tok = pythonSpawnTokens(py);
  const packages = entry.install.command
    .replace(/^pip\s+install\s*/i, "")
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, "")) // keep "colabfold[alphafold]" whole
    .filter(Boolean);
  const args = [...tok.preArgs, "-m", "pip", "install", ...packages];
  const command = [tok.cmd, ...args].join(" ");

  const job: InstallJob = {
    id,
    key: entry.key,
    label: entry.label,
    command,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logs: [
      `[${ts()}] $ ${command}`,
      `[${ts()}] Installing ${entry.label} (${entry.install.label})… [no-shell pip on Windows]`,
    ],
  };
  installJobs.set(id, job);

  const proc = spawn(tok.cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    shell: false,
  });
  wireInstallJob(job, proc);

  return job;
}

// ── Shared job wiring (log ring buffer + settle handling) ───────────────────

function wireInstallJob(
  job: InstallJob,
  proc: ReturnType<typeof spawn>,
): void {
  const push = (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (job.logs.length >= MAX_LOG_LINES) job.logs.shift();
      job.logs.push(`[${ts()}] ${line.trim()}`);
    }
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);

  proc.on("error", (err) => {
    job.logs.push(`[${ts()}] spawn error: ${err.message}`);
    job.status = "failed";
    job.exitCode = 1;
    job.finishedAt = new Date().toISOString();
    invalidateDetectionCaches();
  });

  proc.on("close", (code) => {
    job.exitCode = code ?? 1;
    job.status = code === 0 ? "completed" : "failed";
    job.finishedAt = new Date().toISOString();
    job.logs.push(
      `[${ts()}] ${job.status === "completed"
        ? `✔ ${job.label} install finished (exit 0). Re-scan to verify.`
        : `✘ ${job.label} install failed (exit ${code}). Check the log above.`}`,
    );
    invalidateDetectionCaches();
  });
}

/**
 * Invalidate every detection cache after an install job settles (success OR
 * failure — success MUST). Kills the "installed but scan still says missing
 * until the dev server restarts" gap for the engine python + foundry tiers.
 */
function invalidateDetectionCaches(): void {
  try {
    invalidateEnginePythonCache();
  } catch {
    /* never fatal */
  }
  try {
    invalidateFoundryCache();
  } catch {
    /* never fatal */
  }
  // screening.ts keeps its OWN python cache and is owned by a parallel
  // workstream (not editable from here). Call its invalidator via dynamic
  // import when it is exported; otherwise skip (see the worklog note).
  try {
    void import("./screening")
      .then((mod) => {
        const fn = (
          mod as unknown as { invalidateScreeningPython?: () => void }
        ).invalidateScreeningPython;
        if (typeof fn === "function") fn();
      })
      .catch(() => {
        /* module unavailable — non-fatal */
      });
  } catch {
    /* dynamic import failed — skip screening invalidation */
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
