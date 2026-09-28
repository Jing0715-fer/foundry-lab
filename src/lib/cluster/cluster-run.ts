// Cluster orchestration core — dispatch, async reconcile sweep, output
// sync-back, and cancellation for cluster-dispatched tool runs.
//
// Run records live in data/cluster-runs.json (Record<jobId, ClusterRunState>,
// mtime-cached reads + full-file writes — fine at our scale). The ToolJob DB
// row is the user-facing projection; the run record is the operational truth.
//
// Lifecycle (mirrors cryoflow's remote-RELION lane):
//   startClusterToolRun:  stage inputs → build remote command → read cluster
//     clock (fenceEpoch against stale .cf-exit ghosts) → upload generated
//     script → submit (bash wrapper w/ setsid, or sbatch) → phase "running".
//     Called FIRE-AND-FORGET from the run route — every failure updates the
//     ToolJob row to failed.
//   reconcileClusterJobs: the sweep. ONE batched exec per connection carries
//     liveness verdicts + log tails for ALL active jobs of that connection.
//     Verdicts: ALIVE (keep running) / EXIT:n / SACCT state / VANISHED
//     (wire-blink protected: 3 consecutive + age > 120s before failing).
//     Success → phase "syncing" → outputs downloaded to the local outputs/
//     dir → ToolJob completed (the existing Output Viewer works unchanged).
//   stopClusterJob: scancel (slurm) or process-group kill (direct).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { db } from "@/lib/db";
import { getCompTool, buildCommand, buildArgs, type CompToolDef } from "@/lib/tools";
import { getToolRegistryEntry, type ToolRegistryEntry } from "@/lib/tool-registry";
import { getConnection } from "./connections";
import {
  exec,
  execRaw,
  shQuote,
  expandTilde,
  remoteMkdir,
  remoteUpload,
  remoteDownload,
} from "./ssh";
import { buildWrapperScript, buildSbatchScript, buildNodeScript, buildSallocCommand } from "./run-scripts";
import type {
  ClusterConnection,
  ClusterJobInfoDTO,
  ClusterRunState,
  ClusterRunTarget,
} from "./types";

// ── Run-record persistence ──────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const RUNS_FILE = join(DATA_DIR, "cluster-runs.json");

/** Maximum input-file size we will stage (memory + stdin transfer bound). */
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
/** Per-file cap for output sync-back. */
const MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024;

let runCache: { mtimeMs: number; runs: Record<string, ClusterRunState> } | null = null;

function loadRuns(): Record<string, ClusterRunState> {
  try {
    const st = statSync(RUNS_FILE);
    if (runCache && runCache.mtimeMs === st.mtimeMs) return runCache.runs;
    const parsed = JSON.parse(readFileSync(RUNS_FILE, "utf-8"));
    const runs =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, ClusterRunState>)
        : {};
    runCache = { mtimeMs: st.mtimeMs, runs };
    return runs;
  } catch {
    if (!runCache) runCache = { mtimeMs: 0, runs: {} };
    return runCache.runs;
  }
}

function saveRuns(runs: Record<string, ClusterRunState>): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
    runCache = { mtimeMs: statSync(RUNS_FILE).mtimeMs, runs };
  } catch {
    /* persistence is best-effort — the run still progresses in memory */
  }
}

export function getRun(jobId: string): ClusterRunState | undefined {
  return loadRuns()[jobId];
}

export function listRuns(): ClusterRunState[] {
  return Object.values(loadRuns());
}

export function updateRun(jobId: string, patch: Partial<ClusterRunState>): ClusterRunState | undefined {
  const runs = loadRuns();
  const cur = runs[jobId];
  if (!cur) return undefined;
  const next: ClusterRunState = { ...cur, ...patch };
  runs[jobId] = next;
  saveRuns(runs);
  return next;
}

/** Prisma-visible subset of ToolJob columns the cluster lane writes. */
interface JobRowPatch {
  status?: string;
  stdout?: string;
  stderr?: string;
  outputFiles?: string;
  exitCode?: number | null;
  command?: string | null;
  pid?: number | null;
  finishedAt?: Date;
}

async function updateJobRow(jobId: string, data: JobRowPatch): Promise<void> {
  try {
    await db.toolJob.update({ where: { id: jobId }, data });
  } catch {
    /* row may be absent (record-only runs / db reset) — nothing to do */
  }
}

// ── Remote command construction ─────────────────────────────────────────────

/**
 * Build the remote shell command for a tool run. Mirrors real-executor's
 * runNativeTool arg construction (script → `python3 <script> …`, python-module
 * → `python3 -m <module> …`, binary/executable → cliCommand …) using the SAME
 * structured buildArgs (hydra list grammar, engineOnly skips) with three
 * per-token rewrites:
 *   (a) staged local input paths → <remoteWorkdir>/input/<basename>
 *   (b) `external-tools/<X>/…` tokens → <remoteToolsDir>/<X>/…
 *   (c) local workDir prefix → remoteWorkdir prefix
 * Registry fixedArgs + output routing (prefix vs folder semantics, hydra
 * dotted single-token) are appended exactly like the local executor.
 * The LOCAL (unrewritten) buildCommand output is kept for display.
 */
function buildRemoteCommand(
  def: CompToolDef,
  entry: ToolRegistryEntry | undefined,
  params: Record<string, unknown>,
  localWorkDir: string,
  remoteWorkdir: string,
  remoteToolsDirAbs: string,
  staged: Map<string, string>,
): { remote: string; local: string } {
  const rewrite = (raw: string): string => {
    const direct = staged.get(raw);
    if (direct) return direct;
    const viaResolved = staged.get(resolve(raw));
    if (viaResolved) return viaResolved;
    if (raw.startsWith("external-tools/")) {
      return `${remoteToolsDirAbs}/${raw.slice("external-tools/".length)}`;
    }
    if (raw.length > 0 && raw.startsWith(localWorkDir)) {
      return remoteWorkdir + raw.slice(localWorkDir.length);
    }
    return raw;
  };

  const mode = entry?.nativeExecution;
  const tokens: string[] = [];
  if (mode?.mode === "script") {
    tokens.push("python3", rewrite(mode.script));
  } else if (mode?.mode === "python-module") {
    tokens.push("python3", "-m", mode.module);
  } else {
    // binary / executable / engine-only tools: the CLI command, which may
    // itself be multi-word ("rf3 fold", "python -m pyrosetta.score").
    tokens.push(...def.cliCommand.split(/\s+/).filter(Boolean));
  }

  // Structured param tokens (hydra list grammar + engineOnly skips), each
  // value token path-rewritten for the remote host.
  for (const t of buildArgs(def, params).slice(1)) {
    if (t.includes("=")) {
      const eq = t.indexOf("=");
      tokens.push(`${t.slice(0, eq)}=${rewrite(t.slice(eq + 1))}`);
    } else if (t.startsWith("-")) {
      tokens.push(t);
    } else {
      tokens.push(rewrite(t));
    }
  }

  // Registry-pinned flags + output routing — same semantics as the local
  // executor (prefix flags → <W>/design so suffixed files land inside W;
  // folder flags → W itself; hydra dotted → single key=value token).
  if (mode) {
    tokens.push(...(mode.fixedArgs ?? []));
    const prefixBase = `${remoteWorkdir}/design`;
    if (mode.outputPrefixFlag) {
      if (mode.outputPrefixFlag.includes(".")) {
        tokens.push(`${mode.outputPrefixFlag}=${prefixBase}`);
      } else {
        tokens.push(mode.outputPrefixFlag, prefixBase);
      }
    } else if (mode.outFolderFlag) {
      const target = mode.outFolderIsPrefix ? prefixBase : remoteWorkdir;
      tokens.push(mode.outFolderFlag, target);
    }
  }

  return {
    remote: tokens.map((t) => shQuote(t)).join(" "),
    local: buildCommand(def, params),
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export interface StartClusterRunArgs {
  jobId: string;
  toolKey: string;
  params: Record<string, unknown>;
  /** Local dir under outputs/ — inputs are staged FROM here, outputs sync TO here. */
  workDir: string;
  target: ClusterRunTarget;
}

/**
 * Dispatch a tool run to the cluster. Fire-and-forget safe: never throws —
 * every failure marks the ToolJob row failed and returns { ok: false }.
 */
export async function startClusterToolRun(
  args: StartClusterRunArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { jobId, toolKey, params, workDir, target: rawTarget } = args;

  const fail = async (error: string): Promise<{ ok: false; error: string }> => {
    updateRun(jobId, {
      phase: "failed",
      error,
      finishedAt: new Date().toISOString(),
    });
    await updateJobRow(jobId, {
      status: "failed",
      stderr: `Cluster dispatch failed: ${error}`,
      exitCode: 1,
      finishedAt: new Date(),
    });
    return { ok: false, error };
  };

  // 1. Connection + tool defs.
  const def = getCompTool(toolKey);
  if (!def) return fail(`unknown tool: ${toolKey}`);
  const entry = getToolRegistryEntry(toolKey);

  // 1b. CUDA-pin fallback. The tutorial grammar models the GPU card as an
  //     envPrefix PARAM (alphafold's `gpu` → CUDA_VISIBLE_DEVICES). The
  //     cluster lane pins the card via `target.cudaDevice` instead — when the
  //     target carries no explicit device (programmatic POST /api/tools/run
  //     with only params.gpu, or an inspector that never re-synced _cluster),
  //     fall back to the param value so the remote node script still exports
  //     CUDA_VISIBLE_DEVICES instead of silently running unpinned.
  const target: ClusterRunTarget =
    !(rawTarget.cudaDevice ?? "").trim()
      ? (() => {
          const envField = def.paramFields.find(
            (f) => f.envPrefix === "CUDA_VISIBLE_DEVICES",
          );
          const gpuVal = envField
            ? String(params[envField.key] ?? envField.default ?? "").trim()
            : "";
          const normalized = gpuVal.replace(/[^0-9,]/g, "");
          return normalized ? { ...rawTarget, cudaDevice: normalized } : rawTarget;
        })()
      : rawTarget;

  const conn = getConnection(target.connectionId);
  if (!conn) return fail(`cluster connection not found: ${target.connectionId}`);

  // 2. Cluster clock + home. $HOME expands any `~` in remoteRoot BEFORE we
  //    quote paths (quoting would defeat remote tilde expansion).
  const clock = await exec(conn, `echo "$(date +%s)"; echo "$HOME"`, { timeoutMs: 20_000 });
  if (clock.error) return fail(`SSH exec failed: ${clock.error}`);
  const clockLines = clock.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const fenceEpoch = parseInt(clockLines[0] ?? "", 10) || Math.floor(Date.now() / 1000);
  const clusterHome = clockLines[1] ?? "";
  if (conn.remoteRoot.trim().startsWith("~") && !clusterHome) {
    return fail("could not resolve the cluster $HOME (required to expand the ~ remoteRoot)");
  }
  const remoteRootAbs = expandTilde(conn.remoteRoot.trim(), clusterHome);
  const remoteToolsDirAbs = expandTilde(conn.remoteToolsDir.trim(), clusterHome);
  const remoteWorkdir = `${remoteRootAbs.replace(/\/+$/, "")}/jobs/${toolKey}/${jobId}`;

  // 3. Workdir + input staging. Only paramFields of type "path" whose value
  //    references an EXISTING local file are staged (resolve relative to cwd).
  const mkdirRes = await remoteMkdir(conn, `${remoteWorkdir}/input`);
  if (mkdirRes.error) return fail(`remote mkdir failed: ${mkdirRes.error}`);

  const stagedFiles: string[] = [];
  const staged = new Map<string, string>(); // raw value OR resolved abs → remote path
  for (const f of def.paramFields) {
    if (f.type !== "path") continue;
    const v = params[f.key];
    if (typeof v !== "string" || !v.trim()) continue;
    const localAbs = resolve(v.trim());
    let size = 0;
    let isFile = false;
    try {
      const st = statSync(localAbs);
      size = st.size;
      isFile = st.isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    if (size > MAX_INPUT_BYTES) {
      return fail(`input ${basename(localAbs)} is ${size} bytes (cap ${MAX_INPUT_BYTES})`);
    }
    const remotePath = `${remoteWorkdir}/input/${basename(localAbs)}`;
    const up = await remoteUpload(conn, readFileSync(localAbs), remotePath);
    if (!up.ok) {
      return fail(`failed to stage input ${basename(localAbs)}: ${up.error ?? "unknown error"}`);
    }
    staged.set(v.trim(), remotePath);
    staged.set(localAbs, remotePath);
    stagedFiles.push(remotePath);
  }

  // 4. Remote command (rewritten) + local display command.
  const { remote: toolCommand, local: localCommand } = buildRemoteCommand(
    def,
    entry,
    params,
    workDir,
    remoteWorkdir,
    remoteToolsDirAbs,
    staged,
  );

  // 4b. Tutorial-flow wrapping (salloc → ssh node → module load → CUDA pin).
  //  When a compute node / module / CUDA device is requested, the tool
  //  command runs from a generated node script uploaded to <W>/.fl-node.sh:
  //    - salloc mode: salloc -N 1 --gres=gpu:N -p <partition> ssh <node> bash <W>/.fl-node.sh
  //    - direct + node: ssh <node> bash <W>/.fl-node.sh
  //    - direct (module only): bash <W>/.fl-node.sh
  //  slurm mode keeps the command inline (module/CUDA lines are generated
  //  into the sbatch script itself).
  const af2Node = (target.node ?? "").trim();
  const af2Module = (target.module ?? "").trim();
  const af2Cuda = (target.cudaDevice ?? "").trim();
  let remoteCommand = toolCommand;
  if (target.mode !== "slurm" && (af2Node || af2Module || af2Cuda)) {
    const nodeScriptPath = `${remoteWorkdir}/.fl-node.sh`;
    const nodeScript = buildNodeScript({
      conn,
      command: toolCommand,
      remoteWorkdir,
      jobName: `fl_${toolKey}_${jobId.slice(-8)}`,
      module: af2Module || null,
      cudaDevice: af2Cuda || null,
    });
    const nodeUp = await remoteUpload(conn, nodeScript, nodeScriptPath);
    if (!nodeUp.ok) {
      return fail(`failed to upload the node script: ${nodeUp.error ?? "unknown error"}`);
    }
    if (target.mode === "salloc") {
      const sallocPartition = (target.partition ?? conn.slurmPartition ?? conn.af2?.partition ?? "").trim();
      if (!af2Node) {
        return fail("salloc mode requires a compute node to ssh into (e.g. gpu05)");
      }
      remoteCommand = buildSallocCommand({
        nodeScriptPath,
        node: af2Node,
        partition: sallocPartition,
        gpus: target.gpus ?? 1,
      });
    } else if (af2Node) {
      remoteCommand = `ssh ${shQuote(af2Node)} bash ${shQuote(nodeScriptPath)}`;
    } else {
      remoteCommand = `bash ${shQuote(nodeScriptPath)}`;
    }
  } else if (target.mode === "salloc") {
    return fail("salloc mode requires a compute node (the tutorial's gpu05) — pass cluster.node");
  }

  const scriptPath =
    target.mode === "slurm"
      ? `${remoteWorkdir}/.fl-sbatch.sh`
      : `${remoteWorkdir}/.fl-run.sh`;

  // 5. Run record — phase "staging" (fenceEpoch fences off ghost .cf-exit
  //    files left by any previous run in a reused workdir).
  const state: ClusterRunState = {
    jobId,
    toolKey,
    connectionId: conn.id,
    connectionName: conn.name,
    host: conn.host,
    user: conn.username,
    mode: target.mode,
    remoteRoot: remoteRootAbs,
    remoteWorkdir,
    localWorkDir: workDir,
    pid: null,
    pidStart: null,
    slurmId: null,
    slurmState: null,
    phase: "staging",
    fenceEpoch,
    dispatchedAtEpoch: Math.floor(Date.now() / 1000),
    command: localCommand,
    scriptPath,
    stagedFiles,
    syncedFiles: [],
    syncedBytes: 0,
    logTailOut: "",
    logTailErr: "",
    logTotalLines: 0,
    logTailAt: Date.now(),
    slurmElapsedMs: null,
    error: null,
    finishedAt: null,
    vanishedStreak: 0,
  };
  const runs = loadRuns();
  runs[jobId] = state;
  saveRuns(runs);

  // 6. Generate + upload the run script.
  const jobName = `fl_${toolKey}_${jobId.slice(-8)}`;
  const script =
    target.mode === "slurm"
      ? buildSbatchScript({
          conn,
          command: remoteCommand,
          remoteWorkdir,
          jobName,
          partition: target.partition ?? conn.slurmPartition,
          gpus: target.gpus ?? 1,
          ntasks: target.ntasks ?? 1,
          cpusPerTask: target.cpusPerTask ?? 4,
          timeLimitMin: target.timeLimitMin ?? conn.slurmTimeMin,
          node: target.node ?? null,
          module: target.module ?? null,
          cudaDevice: target.cudaDevice ?? null,
        })
      : buildWrapperScript({ conn, command: remoteCommand, remoteWorkdir, jobName });

  const scriptUp = await remoteUpload(conn, script, scriptPath);
  if (!scriptUp.ok) {
    return fail(`failed to upload the run script: ${scriptUp.error ?? "unknown error"}`);
  }

  // 7. Submit.
  if (target.mode === "slurm") {
    const res = await exec(conn, `sbatch ${shQuote(scriptPath)}`, { timeoutMs: 30_000 });
    const m = res.error ? null : /Submitted batch job (\d+)/.exec(res.stdout);
    if (!m) {
      return fail(`sbatch submission failed: ${honestSbatchError(res)}`);
    }
    updateRun(jobId, { phase: "running", slurmId: m[1] });
    await updateJobRow(jobId, { command: localCommand });
    return { ok: true };
  }

  const res = await exec(conn, `bash ${shQuote(scriptPath)}`, { timeoutMs: 30_000 });
  const m = res.error ? null : /FOUNDRY_PID:(\d+)/.exec(res.stdout);
  if (!m) {
    const detail = [res.error, res.stderr.trim(), res.stdout.trim()]
      .filter(Boolean)
      .join(" | ");
    return fail(`direct submission failed (no FOUNDRY_PID): ${detail.slice(0, 500)}`);
  }
  const pid = parseInt(m[1], 10);
  updateRun(jobId, { phase: "running", pid });
  await updateJobRow(jobId, { command: localCommand, pid });
  return { ok: true };
}

/** Separate real sbatch diagnostics from bashrc/banner noise. */
function honestSbatchError(res: { stdout: string; stderr: string; error?: string }): string {
  if (res.error) return res.error;
  const lines = [...res.stdout.split("\n"), ...res.stderr.split("\n")]
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const meaningful = lines.filter((l) =>
    /sbatch|batch job|error|invalid|partition|gres|qos|time limit|account|node/i.test(l),
  );
  const chosen = meaningful.length > 0 ? meaningful : lines;
  return chosen.slice(0, 5).join("\n") || "(sbatch produced no output)";
}

// ── Reconcile sweep ─────────────────────────────────────────────────────────

let sweepInFlight = false;

/**
 * Sweep all active cluster runs: one batched exec per connection gathers
 * liveness + log tails; verdicts drive state transitions + ToolJob updates.
 * Re-entrant-safe: if a sweep is already running, returns immediately (the
 * next poll tick picks up).
 */
export async function reconcileClusterJobs(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await doSweep();
  } finally {
    sweepInFlight = false;
  }
}

async function doSweep(): Promise<void> {
  const active = listRuns().filter(
    (r) => r.phase === "staging" || r.phase === "running" || r.phase === "syncing",
  );
  if (active.length === 0) return;

  const groups = new Map<string, ClusterRunState[]>();
  for (const run of active) {
    const list = groups.get(run.connectionId) ?? [];
    list.push(run);
    groups.set(run.connectionId, list);
  }

  // Connections are independent — sweep the groups in parallel (each group
  // is still ONE serialized exec on its own connection's queue).
  await Promise.all(
    [...groups.entries()].map(async ([connectionId, runs]) => {
      const conn = getConnection(connectionId);
      if (!conn) return; // connection deleted mid-flight — nothing to do
      try {
        await sweepConnection(conn, runs);
      } catch {
        /* sweep is best-effort — next tick retries */
      }
    }),
  );
}

/** Liveness ladder for one run (cryoflow contract):
 *   - valid .cf-exit (mtime ≥ fenceEpoch-2) → EXIT:<code> (+ SACCT line for slurm)
 *   - stale .cf-exit → STALE marker, then fall through to the ladder below
 *   - slurm → squeue state; empty → sacct (terminal states) → else VANISHED
 *   - direct → .cf-pid pid+starttime match + kill -0 → ALIVE else VANISHED */
function aliveCheckLines(run: ClusterRunState): string[] {
  const W = run.remoteWorkdir;
  const exitFile = shQuote(`${W}/.cf-exit`);
  const fence = run.fenceEpoch - 2;

  const ladder = (): string[] => {
    if (run.mode === "slurm" && run.slurmId) {
      return [
        `__s=$(squeue -j ${run.slurmId} -h -o %T 2>/dev/null | head -1)`,
        `if [ -n "$__s" ]; then echo "ALIVE:$__s"; ` +
          `else __a=$(sacct -j ${run.slurmId} -n -P -o State,ExitCode,Elapsed 2>/dev/null | head -1); ` +
          `if [ -n "$__a" ]; then echo "SACCT:$__a"; else echo "VANISHED:1"; fi; fi`,
      ];
    }
    if (run.mode === "direct" || run.mode === "salloc") {
      const pidFile = shQuote(`${W}/.cf-pid`);
      return [
        `__pline=$(cat ${pidFile} 2>/dev/null)`,
        `echo "CFPID:$__pline"`,
        `__p=$(echo "$__pline" | awk '{print $1}')`,
        `__st=$(echo "$__pline" | awk '{print $2}')`,
        `__cur=$(awk '{print $22}' /proc/$__p/stat 2>/dev/null)`,
        `if [ -n "$__p" ] && kill -0 "$__p" 2>/dev/null && [ "$__cur" = "$__st" ]; then ` +
          `echo "ALIVE:$__p"; else echo "VANISHED:1"; fi`,
      ];
    }
    // Staging without a pid/slurmId yet — nothing to check; the vanished
    // streak + age gate below prevents false failures during dispatch.
    return [`echo "VANISHED:1"`];
  };

  const lines: string[] = [];
  lines.push(`if [ -f ${exitFile} ]; then`);
  lines.push(`  __m=$(stat -c '%Y' ${exitFile} 2>/dev/null || echo 0)`);
  lines.push(`  if [ "$__m" -ge ${fence} ]; then`);
  lines.push(`    echo "EXIT:$(cat ${exitFile} 2>/dev/null)"`);
  if (run.mode === "slurm" && run.slurmId) {
    lines.push(
      `    echo "SACCT:$(sacct -j ${run.slurmId} -n -P -o State,ExitCode,Elapsed 2>/dev/null | head -1)"`,
    );
  }
  lines.push(`  else`);
  lines.push(`    echo "STALE:1"`);
  for (const l of ladder()) lines.push(`    ${l}`);
  lines.push(`  fi`);
  lines.push(`else`);
  for (const l of ladder()) lines.push(`  ${l}`);
  lines.push(`fi`);
  return lines;
}

async function sweepConnection(
  conn: ClusterConnection,
  runs: ClusterRunState[],
): Promise<void> {
  const blocks: string[] = [];
  for (const run of runs) {
    blocks.push(`echo "===FL:${run.jobId}"`);
    blocks.push(...aliveCheckLines(run));
    // The bare `echo` before each marker guarantees the marker starts on a
    // fresh line even when the previous command's output had no newline.
    blocks.push(
      `echo; echo "---LINES---"; wc -l < ${shQuote(`${run.remoteWorkdir}/run.out`)} 2>/dev/null || echo 0`,
    );
    blocks.push(`echo; echo "---LOG---"; tail -c 4096 ${shQuote(`${run.remoteWorkdir}/run.out`)} 2>/dev/null`);
    blocks.push(`echo; echo "---ERR---"; tail -c 2048 ${shQuote(`${run.remoteWorkdir}/run.err`)} 2>/dev/null`);
    blocks.push(`echo; echo "===END:${run.jobId}"`);
  }
  const res = await execRaw(conn, blocks.join("\n"), { timeoutMs: 25_000 });
  if (res.error) return; // wire blink — keep the previous state
  const parsed = parseSweepOutput(res.stdout.toString("utf8"));

  for (const run of runs) {
    const block = parsed.get(run.jobId);
    if (!block) continue;
    try {
      await applySweepBlock(conn, run, block);
    } catch {
      /* per-job failures never abort the sweep */
    }
  }
}

interface SweepBlock {
  verdicts: { kind: string; detail: string }[];
  logLines: number | null;
  logTailLines: string[];
  errTailLines: string[];
}

function parseSweepOutput(stdout: string): Map<string, SweepBlock> {
  const blocks = new Map<string, SweepBlock>();
  let current: SweepBlock | null = null;
  let section: "head" | "lines" | "log" | "err" = "head";
  let gotLines = false;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const fl = /^===FL:(.+)$/.exec(line);
    if (fl) {
      current = { verdicts: [], logLines: null, logTailLines: [], errTailLines: [] };
      blocks.set(fl[1], current);
      section = "head";
      gotLines = false;
      continue;
    }
    if (/^===END:/.test(line)) {
      current = null;
      section = "head";
      continue;
    }
    if (!current) continue;
    if (line === "---LINES---") {
      section = "lines";
      continue;
    }
    if (line === "---LOG---") {
      section = "log";
      continue;
    }
    if (line === "---ERR---") {
      section = "err";
      continue;
    }
    if (section === "head") {
      const m = /^(ALIVE|EXIT|SACCT|VANISHED|STALE|CFPID):(.*)$/.exec(line);
      if (m) current.verdicts.push({ kind: m[1], detail: m[2] });
    } else if (section === "lines") {
      if (!gotLines) {
        const n = parseInt(line.trim(), 10);
        if (Number.isFinite(n)) {
          current.logLines = n;
          gotLines = true;
        }
      }
    } else if (section === "log") {
      current.logTailLines.push(line);
    } else if (section === "err") {
      current.errTailLines.push(line);
    }
  }
  return blocks;
}

type Verdict =
  | { kind: "alive"; detail: string }
  | { kind: "exit"; code: number }
  | { kind: "vanished" }
  | { kind: "none" };

async function applySweepBlock(
  conn: ClusterConnection,
  run: ClusterRunState,
  block: SweepBlock,
): Promise<void> {
  const logTailOut = block.logTailLines.join("\n").replace(/\n+$/, "");
  const logTailErr = block.errTailLines.join("\n").replace(/\n+$/, "");
  const logTotalLines = block.logLines ?? run.logTotalLines;

  // .cf-pid bookkeeping (direct mode): pid + /proc starttime.
  let pid = run.pid;
  let pidStart = run.pidStart;
  const cfp = block.verdicts.find((v) => v.kind === "CFPID")?.detail.trim() ?? "";
  if (cfp) {
    const [p, s] = cfp.split(/\s+/);
    const pn = parseInt(p, 10);
    if (Number.isFinite(pn)) pid = pn;
    const sn = parseInt(s, 10);
    if (Number.isFinite(sn)) pidStart = sn;
  }

  // sacct bookkeeping (slurm): state + elapsed.
  let slurmState = run.slurmState;
  let slurmElapsedMs = run.slurmElapsedMs;
  const sacctV = block.verdicts.find((v) => v.kind === "SACCT" && v.detail.trim() !== "");
  if (sacctV) {
    const [state, , elapsed] = sacctV.detail.split(",");
    if (state && state.trim()) slurmState = state.trim();
    const ms = parseSlurmElapsedMs(elapsed ?? "");
    if (ms != null) slurmElapsedMs = ms;
  }

  const exitV = block.verdicts.find((v) => v.kind === "EXIT" && v.detail.trim() !== "");
  const aliveV = block.verdicts.find((v) => v.kind === "ALIVE");

  // Verdict resolution ladder.
  let verdict: Verdict = { kind: "none" };
  if (exitV) {
    const rc = parseInt(exitV.detail.trim(), 10);
    if (Number.isFinite(rc)) verdict = { kind: "exit", code: rc };
  } else if (run.mode === "slurm" && run.slurmId && sacctV) {
    const state = (sacctV.detail.split(",")[0] ?? "").trim().toUpperCase();
    if (["PENDING", "RUNNING", "COMPLETING", "REQUEUED", "RESIZING", "CONFIGURING", "SUSPENDED"].includes(state)) {
      verdict = { kind: "alive", detail: state };
    } else if (state === "COMPLETED") {
      verdict = { kind: "exit", code: 0 };
    } else if (state === "CANCELLED") {
      verdict = { kind: "exit", code: 143 };
    } else if (state === "TIMEOUT") {
      verdict = { kind: "exit", code: 124 };
    } else if (["FAILED", "NODE_FAIL", "OUT_OF_MEMORY", "BOOT_FAIL", "PREEMPTED"].includes(state)) {
      const codeField = (sacctV.detail.split(",")[1] ?? "").trim(); // "N:signal"
      const parsedCode = parseInt(codeField.split(":")[0], 10);
      verdict = { kind: "exit", code: Number.isFinite(parsedCode) ? parsedCode : 1 };
    } else if (state) {
      verdict = { kind: "vanished" }; // unknown terminal state
    }
  } else if (aliveV) {
    verdict = { kind: "alive", detail: aliveV.detail.trim() };
  } else if (block.verdicts.some((v) => v.kind === "VANISHED")) {
    verdict = { kind: "vanished" };
  }

  if (verdict.kind === "alive" && run.mode === "slurm" && verdict.detail) {
    slurmState = verdict.detail.toUpperCase();
  }

  const common: Partial<ClusterRunState> = {
    logTailOut,
    logTailErr,
    logTotalLines,
    logTailAt: Date.now(),
    pid,
    pidStart,
    slurmState,
    slurmElapsedMs,
  };

  // ── EXIT 0 → sync outputs back, then finalize. ────────────────────────────
  if (verdict.kind === "exit" && verdict.code === 0) {
    if (run.phase === "syncing") return; // a sync is already in flight
    updateRun(run.jobId, { ...common, phase: "syncing", vanishedStreak: 0 });
    const current = getRun(run.jobId);
    if (current) await syncBackOutputs(conn, current);
    return;
  }

  // ── EXIT n≠0 → honest failure. ────────────────────────────────────────────
  if (verdict.kind === "exit") {
    updateRun(run.jobId, {
      ...common,
      phase: "failed",
      error: `exit code ${verdict.code}`,
      finishedAt: new Date().toISOString(),
    });
    await updateJobRow(run.jobId, {
      status: "failed",
      exitCode: verdict.code,
      stderr:
        logTailErr.slice(-2000) ||
        `cluster process exited with code ${verdict.code}`,
      stdout: clusterBanner(run) + logTailOut,
      finishedAt: new Date(),
    });
    return;
  }

  // ── VANISHED → wire-blink protection (3 consecutive + age > 120s). ────────
  if (verdict.kind === "vanished") {
    const streak = run.vanishedStreak + 1;
    const ageSec = Math.floor(Date.now() / 1000) - run.dispatchedAtEpoch;
    if (streak >= 3 && ageSec > 120) {
      updateRun(run.jobId, {
        ...common,
        phase: "failed",
        error: "process vanished (no exit file, pid not alive)",
        vanishedStreak: streak,
        finishedAt: new Date().toISOString(),
      });
      await updateJobRow(run.jobId, {
        status: "failed",
        stderr:
          "Cluster process vanished — no exit file and the pid is no longer alive " +
          "after 3 consecutive checks. (Connection dropped mid-run or the job was " +
          "killed outside Foundry Lab.)",
        exitCode: 1,
        finishedAt: new Date(),
      });
      return;
    }
    updateRun(run.jobId, { ...common, vanishedStreak: streak });
    return;
  }

  // ── ALIVE (or no verdict) → update tails + throttle-update the DB row. ────
  updateRun(run.jobId, { ...common, vanishedStreak: 0 });
  if (
    logTailOut !== run.logTailOut ||
    logTailErr !== run.logTailErr ||
    logTotalLines !== run.logTotalLines
  ) {
    await updateJobRow(run.jobId, {
      status: "running",
      stdout:
        clusterBanner(run) +
        logTailOut +
        (logTailErr ? `\n\n[stderr]\n${logTailErr}` : ""),
      stderr: logTailErr.slice(-2000),
    });
  }
}

/** "HH:MM:SS" or "DD-HH:MM:SS" → ms. */
function parseSlurmElapsedMs(s: string): number | null {
  const t = s.trim();
  if (!/^\d+-\d+:\d+:\d+$|^\d+:\d+:\d+$/.test(t)) return null;
  const days = t.includes("-") ? parseInt(t.split("-")[0], 10) : 0;
  const hms = t.includes("-") ? t.split("-")[1] : t;
  const [h, m, sec] = hms.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  return ((days * 24 + h) * 60 + m) * 60_000 + sec * 1000;
}

/** User-facing banner prepended to cluster job stdout. */
function clusterBanner(run: ClusterRunState): string {
  const slurmPart = run.slurmId ? ` · Slurm ${run.slurmId}` : "";
  return `[cluster ${run.user}@${run.host} · ${run.mode}${slurmPart}]\n`;
}

// ── Output sync-back ────────────────────────────────────────────────────────

/** List + download the run's output files into the local outputs/ dir, then
 *  finalize the ToolJob row (status completed, outputFiles, stdout banner). */
async function syncBackOutputs(conn: ClusterConnection, run: ClusterRunState): Promise<void> {
  const localDir = run.localWorkDir ?? resolve(process.cwd(), "outputs", run.toolKey, run.jobId);
  const warnings: string[] = [];
  const syncedFiles: string[] = [];
  let syncedBytes = 0;

  const list = await exec(
    conn,
    `find ${shQuote(run.remoteWorkdir)} -type f -not -name '.cf-*' -not -name '.fl-*' ` +
      `-not -name 'run.out' -not -name 'run.err' -printf '%P\\t%s\\n' 2>/dev/null | head -200`,
    { timeoutMs: 20_000 },
  );
  if (list.error) {
    warnings.push(`[warning] output listing failed: ${list.error}`);
  } else {
    for (const line of list.stdout.split("\n")) {
      const t = line.trim();
      if (!t.includes("\t")) continue;
      const rel = t.slice(0, t.indexOf("\t"));
      const size = parseInt(t.slice(t.indexOf("\t") + 1), 10);
      if (!rel || rel.startsWith("..") || rel.includes("/../") || !Number.isFinite(size)) continue;
      if (size > MAX_SYNC_FILE_BYTES) {
        warnings.push(`[warning] skipped ${rel} (${size} bytes > 64 MB cap)`);
        continue;
      }
      const localPath = join(localDir, rel);
      const bytes = await remoteDownload(
        conn,
        `${run.remoteWorkdir}/${rel}`,
        localPath,
        MAX_SYNC_FILE_BYTES,
      );
      if (bytes == null) {
        warnings.push(`[warning] could not download ${rel}`);
        continue;
      }
      syncedFiles.push(localPath);
      syncedBytes += bytes;
    }
  }

  const stdout =
    clusterBanner(run) +
    (run.logTailOut || "(no captured output)") +
    (warnings.length ? `\n\n${warnings.join("\n")}` : "");

  updateRun(run.jobId, {
    phase: "done",
    syncedFiles,
    syncedBytes,
    finishedAt: new Date().toISOString(),
  });
  await updateJobRow(run.jobId, {
    status: "completed",
    outputFiles: JSON.stringify(syncedFiles),
    stdout,
    exitCode: 0,
    finishedAt: new Date(),
  });
}

// ── Stop ────────────────────────────────────────────────────────────────────

/** Cancel a cluster run: scancel (slurm) or process-group kill (direct). */
export async function stopClusterJob(
  jobId: string,
): Promise<{ ok: boolean; error?: string }> {
  const run = getRun(jobId);
  if (!run) return { ok: false, error: "no cluster run record for this job" };
  if (run.phase === "done" || run.phase === "failed" || run.phase === "cancelled") {
    return { ok: false, error: `run already ${run.phase}` };
  }
  const conn = getConnection(run.connectionId);
  if (!conn) return { ok: false, error: "cluster connection no longer exists" };

  if (run.mode === "slurm" && run.slurmId) {
    await exec(conn, `scancel ${shQuote(run.slurmId)}`, { timeoutMs: 15_000 });
  } else {
    // Direct + salloc modes: process-group kill. Read .cf-pid's first field
    // (the session leader), then TERM the group + pid, escalate to KILL after
    // a second. Killing the salloc/ssh chain on the login node also tears
    // down the remote node-side process.
    const pidRes = await exec(
      conn,
      `cat ${shQuote(`${run.remoteWorkdir}/.cf-pid`)} 2>/dev/null`,
      { timeoutMs: 15_000 },
    );
    const pid = parseInt(pidRes.stdout.trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isFinite(pid) && pid > 0) {
      await exec(
        conn,
        `kill -- -${pid} 2>/dev/null; kill ${pid} 2>/dev/null; ` +
          `sleep 1; kill -9 -- -${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null; true`,
        { timeoutMs: 20_000 },
      );
    }
  }

  updateRun(run.jobId, {
    phase: "cancelled",
    finishedAt: new Date().toISOString(),
  });
  await updateJobRow(jobId, { status: "cancelled", finishedAt: new Date() });
  return { ok: true };
}

// ── Projections ─────────────────────────────────────────────────────────────

/** User-facing projection merged into ToolJobDTO as `job.cluster`. */
export function clusterInfoForJob(jobId: string): ClusterJobInfoDTO | null {
  const run = getRun(jobId);
  if (!run) return null;
  return {
    connectionId: run.connectionId,
    connectionName: run.connectionName,
    host: run.host,
    user: run.user,
    mode: run.mode,
    phase: run.phase,
    slurmId: run.slurmId,
    slurmState: run.slurmState,
    pid: run.pid,
    remoteWorkdir: run.remoteWorkdir,
    command: run.command,
    logTailOut: run.logTailOut,
    logTailErr: run.logTailErr,
    syncedFiles: run.syncedFiles,
    syncedBytes: run.syncedBytes,
    error: run.error,
  };
}

/** Immediate projection for a just-dispatched job (the run record may not
 *  exist yet — the dispatch is fire-and-forget). */
export function pendingClusterInfo(
  conn: ClusterConnection,
  target: ClusterRunTarget,
): ClusterJobInfoDTO {
  return {
    connectionId: conn.id,
    connectionName: conn.name,
    host: conn.host,
    user: conn.username,
    mode: target.mode,
    phase: "staging",
    slurmId: null,
    slurmState: null,
    pid: null,
    remoteWorkdir: "",
    command: "",
    logTailOut: "",
    logTailErr: "",
    syncedFiles: [],
    syncedBytes: 0,
    error: null,
  };
}
