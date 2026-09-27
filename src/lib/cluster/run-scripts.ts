// Cluster run script generators — DIRECT (setsid wrapper) + SLURM (sbatch).
//
// Both scripts implement the cryoflow filesystem-as-protocol contract inside
// the remote workdir W:
//   .cf-pid   — "<pid> <starttime>" of the detached process-group leader
//               (starttime = field 22 of /proc/<pid>/stat → recycled-pid guard)
//   .cf-exit  — the command's exit code, written exactly once at the end
//   run.out / run.err — captured logs (tailed by the reconcile sweep)
//
// Scripts are uploaded as text and submitted via `bash <script>` /
// `sbatch <script>`, so no chmod is needed. All embedded paths are shell
// quoted: single quotes at the script level (shQuote), double quotes inside
// the `bash -c '…'` inner command and the sbatch TERM trap (dq — a fresh
// bash interprets those, so `\"` `\$` escapes are correct there).

import type { ClusterConnection } from "./types";
import { shQuote } from "./ssh";

/** Escape for embedding a value inside double quotes (bash-interpreted). */
function dq(s: string): string {
  return s.replace(/(["\\`$])/g, "\\$1");
}

/** Escape single quotes for embedding text inside `bash -c '…'`. */
function bashCEscape(s: string): string {
  return s.replace(/'/g, `'"'"'`);
}

/** Login-shell environment block: system + user profiles, then the
 *  connection's user-provided envLines verbatim (module load / conda env). */
function envBlock(conn: ClusterConnection): string[] {
  return [
    "source /etc/profile >/dev/null 2>&1 || true",
    `[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" >/dev/null 2>&1 || true`,
    `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true`,
    ...(conn.envLines.length
      ? ["# --- connection environment (user-provided) ---", ...conn.envLines]
      : []),
  ];
}

/** minutes → "HH:MM:SS" (hours may exceed 24 for multi-day walltimes). */
function minutesToHms(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

// ── DIRECT mode ─────────────────────────────────────────────────────────────

export function buildWrapperScript(args: {
  conn: ClusterConnection;
  command: string;
  remoteWorkdir: string;
  jobName: string;
}): string {
  const W = args.remoteWorkdir;
  // Inner command for `bash -c`: run, capture rc, publish .cf-exit. The path
  // is double-quoted (dq-escaped) — the inner bash interprets those quotes.
  const inner = `${args.command}; __rc=$?; echo $__rc > "${dq(`${W}/.cf-exit`)}"`;
  return [
    "#!/usr/bin/env bash",
    "# Foundry Lab cluster run — generated locally, executed on the cluster",
    `# job ${args.jobName} · DIRECT (setsid) mode`,
    "set -u",
    ...envBlock(args.conn),
    `mkdir -p ${shQuote(W)}`,
    `cd ${shQuote(W)} || exit 111`,
    `rm -f ${shQuote(`${W}/.cf-exit`)}`,
    // Detach the real work into its own session + process group so it
    // survives the login shell exiting (and can be group-killed on stop).
    `setsid bash -c '${bashCEscape(inner)}' > ${shQuote(`${W}/run.out`)} 2> ${shQuote(`${W}/run.err`)} < /dev/null &`,
    "__p=$!",
    // pid + /proc starttime — the starttime guards against pid recycling.
    `echo "$__p $(awk '{print $22}' /proc/$__p/stat 2>/dev/null)" > ${shQuote(`${W}/.cf-pid`)}`,
    `echo "FOUNDRY_PID:$__p"`,
    "",
  ].join("\n");
}

// ── SLURM mode ──────────────────────────────────────────────────────────────

export function buildSbatchScript(args: {
  conn: ClusterConnection;
  command: string;
  remoteWorkdir: string;
  jobName: string;
  partition?: string | null;
  gpus?: number;
  ntasks?: number;
  cpusPerTask?: number;
  timeLimitMin?: number | null;
}): string {
  const W = args.remoteWorkdir;
  const jobName = args.jobName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "fl_job";
  const ntasks = Math.max(1, Math.floor(args.ntasks ?? 1));
  const cpusPerTask = Math.max(1, Math.floor(args.cpusPerTask ?? 4));
  const gpus = Math.max(0, Math.floor(args.gpus ?? 1));
  const partition = (args.partition ?? "").trim();

  const lines: string[] = [
    "#!/bin/bash",
    `#SBATCH --job-name=${jobName}`,
  ];
  if (partition) {
    lines.push(`#SBATCH --partition=${partition.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
  }
  lines.push(
    "#SBATCH --nodes=1",
    `#SBATCH --ntasks=${ntasks}`,
    `#SBATCH --cpus-per-task=${cpusPerTask}`,
  );
  if (gpus > 0) lines.push(`#SBATCH --gres=gpu:${gpus}`);
  const timeLimitMin = args.timeLimitMin ?? null;
  if (timeLimitMin && timeLimitMin > 0) {
    lines.push(`#SBATCH --time=${minutesToHms(timeLimitMin)}`);
  }
  lines.push(
    `#SBATCH --output=${W}/run.out`,
    `#SBATCH --error=${W}/run.err`,
    "# Foundry Lab cluster run — generated locally, executed on the cluster",
    `# job ${jobName} · SLURM mode`,
    ...envBlock(args.conn),
    `mkdir -p ${shQuote(W)}`,
    `cd ${shQuote(W)} || exit 111`,
    `rm -f ${shQuote(`${W}/.cf-exit`)}`,
    // scancel arrives as SIGTERM → publish 143 so the sweep sees a clean stop.
    `trap 'echo 143 > "${dq(`${W}/.cf-exit`)}" 2>/dev/null; exit 143' TERM INT`,
    args.command,
    "__rc=$?",
    `echo "$__rc" > ${shQuote(`${W}/.cf-exit`)}`,
    "exit $__rc",
    "",
  );
  return lines.join("\n");
}
