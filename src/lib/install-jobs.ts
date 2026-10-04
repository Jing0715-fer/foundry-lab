// Install job manager — REAL installs via child_process with live logs.
//
// POST /api/tools/install { key } starts a job that runs the entry's real
// install command. Output is streamed into an in-memory ring buffer that the
// UI polls via GET /api/tools/install/[id]. Jobs live for the lifetime of the
// dev server process (module-level Map).
//
// Cross-platform execution (platform-env):
//   - Linux / macOS  → bash -c (sh fallback)
//   - Windows simple → cmd.exe /d /s /c (supports && / || chains)
//   - Windows POSIX-flavored (github clone flows, venv bin paths, .sh
//     patches…) → `wsl -e bash -c` when WSL is present, otherwise the job is
//     refused with an actionable hint.
// Python/pip tokens in the command are rewritten to the resolved interpreter
// for NATIVE lanes only — WSL commands keep python3/pip because they target
// the WSL-side environment, not the Windows one.

import { spawn } from "child_process";
import { getAnyRegistryEntry } from "./tool-registry";
import { resolveEnginePython } from "./real-executor";
import {
  resolveInstallLane,
  resolveInstallSpec,
  isPosixFlavored,
  osKey,
} from "./platform-env";
import { randomUUID } from "crypto";

export interface InstallJob {
  id: string;
  key: string;
  label: string;
  command: string;
  /** Which execution lane ran (bash / cmd / WSL bash) — surfaced in logs. */
  lane: string;
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
 * Resolve the effective install command for an entry on THIS machine.
 * Re-exported from platform-env (shared with the scan route) so the UI
 * shows exactly what the button would run.
 */
export { resolveInstallSpec } from "./platform-env";

/** Rewrite python3 / bare `pip install` tokens to the resolved interpreter.
 *  Rewrites at command/chain boundaries only — never inside URLs or paths. */
function rewriteForPython(command: string, py: string): string {
  let cmd = command;
  if (py && py !== "python3") {
    const boundary = /(^|&&\s*|\|\|\s*|;\s*)python3(?=\s)/g;
    if (/(^|\s)pip install/.test(cmd) || boundary.test(cmd)) {
      cmd = cmd.replace(boundary, `$1${py}`);
      cmd = cmd.replace(/(^|&&\s*)pip install/g, `$1${py} -m pip install`);
    }
  } else if (py && /(^|\s)pip install/.test(cmd)) {
    cmd = cmd.replace(/(^|&&\s*)pip install/g, `$1${py} -m pip install`);
  }
  return cmd;
}

/**
 * Start a REAL install for a registry entry key. Returns the job (running).
 */
export function startInstall(key: string): InstallJob | { error: string } {
  const entry = getAnyRegistryEntry(key);
  if (!entry) return { error: `Unknown tool key: ${key}` };

  // One install job per key at a time.
  for (const job of installJobs.values()) {
    if (job.key === key && job.status === "running") {
      return { error: `An install for ${entry.label} is already running.` };
    }
  }

  // 1. Effective command on this OS (per-OS variant / system pm / default).
  const spec = resolveInstallSpec(entry);
  if (spec.error && !spec.oneClick) {
    return { error: spec.error };
  }

  // 3. Point python/pip at the resolved interpreter for native lanes only
  //    (WSL commands keep python3/pip — they run inside the Linux distro).
  //    NOTE: the rewrite must happen BEFORE the lane is built — the lane's
  //    args embed the final command string, and `pip` alone would resolve
  //    to the SYSTEM pip (PEP-668 on externally-managed Pythons).
  let command = spec.command;
  const wsl = spec.command ? isPosixFlavored(spec.command) && osKey() === "windows" : false;
  if (!wsl) {
    const py = resolveEnginePython();
    if (py) command = rewriteForPython(command, py);
  }

  // 2. Execution lane (bash / cmd / WSL bash) — built from the FINAL command.
  const lane = resolveInstallLane(command);
  if (!lane) {
    return {
      error:
        `"${entry.label}" needs a POSIX shell (its install script uses ` +
        `Linux/macOS syntax). On Windows, enable WSL first (run \`wsl --install\`) ` +
        `and re-scan, or use the built-in real engine fallback. See ${entry.install.docs}.`,
    };
  }

  const id = randomUUID();
  const job: InstallJob = {
    id,
    key,
    label: entry.label,
    command,
    lane: lane.label,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logs: [
      `[${ts()}] $ ${command}`,
      `[${ts()}] lane: ${lane.label}${lane.label === "WSL bash" ? " (POSIX install routed through WSL)" : ""}`,
      `[${ts()}] Installing ${entry.label} (${spec.label})…`,
    ],
  };
  installJobs.set(id, job);

  const proc = spawn(lane.file, lane.args, {
    cwd: process.cwd(),
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });

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
  });

  return job;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
