// Install job manager — REAL installs via child_process with live logs.
//
// POST /api/tools/install { key } starts a job that runs the entry's real
// install command (pip install / git clone + pip install -e .). Output is
// streamed into an in-memory ring buffer that the UI polls via
// GET /api/tools/install/[id]. Jobs live for the lifetime of the dev server
// process (module-level Map).

import { spawn } from "child_process";
import { getAnyRegistryEntry } from "./tool-registry";
import { resolveEnginePython } from "./real-executor";
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
 * The install command is executed with bash -lc so pipes/chains work.
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
  // Run pip AND python3 through the resolved engine python so installs and
  // post-install patch steps land in the same environment the engines use
  // (avoids PEP-668 system-pip rejections AND patches targeting the wrong
  // interpreter's site-packages).
  const py = resolveEnginePython();
  let command = entry.install.command;
  if (py && py !== "python3") {
    // Rewrites at command/chain boundaries only — never inside URLs or paths.
    const boundary = /(^|&&\s*|\|\|\s*|;\s*)python3(?=\s)/g;
    if (/(^|\s)pip install/.test(command) || boundary.test(command)) {
      command = command.replace(boundary, `$1${py}`);
      command = command.replace(/(^|&&\s*)pip install/g, `$1${py} -m pip install`);
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
