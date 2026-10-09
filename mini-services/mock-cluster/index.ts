/**
 * Foundry Lab — mock-cluster (Task 23-b)
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ LOCAL TEST CLUSTER — a TEST HARNESS, not part of the product.       │
 * │ Commands that arrive over SSH are EXECUTED FOR REAL by /bin/bash    │
 * │ on this machine; only the SCHEDULER (sbatch/squeue/sacct/scancel/   │
 * │ sinfo) is a small in-memory state machine. No science is simulated. │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Emulates an HPC cluster login node so the cluster-execution lane
 * (Task 23-a) can be E2E-tested without a real HPC — the same trick
 * cryoflow uses for remote-RELION:
 *
 *   - ssh2 SSH server on 0.0.0.0:3022 (RSA host key auto-generated)
 *   - password auth only: user "foundry" / password "demo"
 *   - `exec` channels backed by a real /bin/bash (cwd = fs/)
 *   - scheduler commands intercepted in JS and served by a mini-SLURM
 *     state machine (PENDING → RUNNING → COMPLETED/FAILED/CANCELLED)
 *     that spawns the submitted script FOR REAL, honoring
 *     `#SBATCH --output=` / `--error=` directives
 *   - `salloc` is intercepted too (the tutorial's allocation step):
 *     `salloc -N 1 --gres=gpu:1 -p brain2 ssh gpu05 bash …` prints
 *     `salloc: Granted job allocation <id>` to stderr, exports the
 *     SLURM_* env, then executes the trailing command FOR REAL and
 *     forwards its exit code. fs/opt/bin/salloc is a file-shim twin for
 *     salloc nested inside scripts (the app's .fl-run.sh wrappers).
 *   - `module load alphafold2` (bash function in ~/.bash_profile AND
 *     ~/.bashrc) prepends the ABSOLUTE /opt/alphafold2/bin to PATH so
 *     run_alphafold.py survives any later `cd`
 *   - fs/opt/alphafold2/bin/run_alphafold.py — faithful mock of the
 *     cluster's AF2 CLI (Task 25-c): full input validation, 5 REAL
 *     fold-engine runs (seeds 0–4) and the complete tutorial output tree
 *     (ranked_*.pdb, ranking_debug.json, features.pkl, result_model_*.pkl,
 *     relaxed/unrelaxed models, timings.json, msas/)
 *   - fs/opt/bin/ssh routes `ssh gpuNN <cmd>` to the "node" (bash -c at
 *     $HOME); any other host → "No route to host", exit 255
 *   - fs/opt/bin/nvidia-smi + the JS emulation below both report the same
 *     8× A100-SXM4-40GB inventory (cards 0–5 busy, 6–7 nearly free —
 *     the tutorial pins CUDA_VISIBLE_DEVICES to 6/7)
 *   - sftp is intentionally NOT supported (ssh2 refuses the subsystem
 *     request automatically when no 'sftp' listener exists)
 *
 * Run:  bun run start   (or: bun run dev  for hot reload)
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

// Ambient Bun global (P1-2, QA 34-a): this service always RUNS under Bun, but
// the repo-wide `tsc --noEmit` gate also reads this file; without the
// declaration the Bun.serve call below trips TS2867 (repo errors 4→5).
declare const Bun: {
  serve: (options: {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }) => { stop: (force?: boolean) => void };
};

const { Server } = ssh2;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fake cluster filesystem root (a real directory tree on this machine). */
const FS_ROOT = join(__dirname, "fs");
const KEYS_DIR = join(__dirname, "keys");
const HOST_KEY_PATH = join(KEYS_DIR, "host_key_rsa");

const PORT = 3022;
const BIND_HOST = "0.0.0.0";

const AUTH_USER = "foundry";
const AUTH_PASSWORD = "demo";

const HOME = join(FS_ROOT, "home", "foundry");

/** PATH for everything spawned "on the cluster": the tool shims come first. */
const MOCK_PATH = [
  join(FS_ROOT, "opt", "bin"),
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
].join(":");

/** The REAL built-in algorithm engines (ground truth — never simulated). */
const ENGINE_DIR = "/home/z/my-project/scripts/algorithms";

/** Grace period after process exit before the channel closes anyway
 * (drain-aware: a pipe still MOVING re-arms it; hard cap bounds hangs). */
const DRAIN_GRACE_MS = 400;
const DRAIN_HARD_CAP_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[mock-cluster] ${msg}`);
}

function logExec(cmd: string) {
  const flat = String(cmd).replace(/\r?\n/g, "⏎");
  const shown = flat.length > 180 ? `${flat.slice(0, 180)} …[truncated]` : flat;
  log(`exec: ${shown}`);
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: MOCK_PATH,
    HOME,
    USER: AUTH_USER,
    LOGNAME: AUTH_USER,
    SHELL: "/bin/bash",
    TERM: "dumb",
    LANG: "C.UTF-8",
    // login shells (`bash -l`) re-export PATH from this via ~/.bash_profile
    FOUNDRY_MOCK_PATH: MOCK_PATH,
  };
}

/** Generate + persist the host key on first run, load it afterwards.
 * (PKCS#1 "RSA PRIVATE KEY" PEM — ssh2 does not parse PKCS#8.) */
function ensureHostKey(): string {
  if (existsSync(HOST_KEY_PATH)) return readFileSync(HOST_KEY_PATH, "utf8");
  mkdirSync(KEYS_DIR, { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  log(`generated new 2048-bit RSA host key at ${HOST_KEY_PATH}`);
  return privateKey;
}

function safeWrite(writable: any, data: string) {
  try {
    writable?.write?.(data);
  } catch {
    /* channel may already be gone */
  }
}

/** Expand ~, $HOME, ${HOME}, $USER in a path; resolve relatives vs base. */
function expandPath(p: string, baseDir: string = FS_ROOT): string {
  let out = String(p ?? "").trim();
  if (!out) return out;
  out = out
    .replace(/^\$\{HOME\}/, HOME)
    .replace(/^\$HOME/, HOME)
    .replace(/\$\{?HOME\}?/g, HOME)
    .replace(/\$\{?USER\}?/g, AUTH_USER);
  if (out === "~") out = HOME;
  else if (out.startsWith("~/")) out = join(HOME, out.slice(2));
  else if (out === "~foundry") out = HOME;
  else if (out.startsWith("~foundry/")) out = join(HOME, out.slice(9));
  return isAbsolute(out) ? out : resolve(baseDir, out);
}

/** Split a command into segments AND separators (quote-aware).
 * Separators: `;`, `&&`, `||`. Newlines stay INSIDE segments (multi-line
 * script bodies are never mistaken for command batches); `|` is not a
 * separator either (sinfo/squeue -o formats legitimately contain pipes). */
interface Piece { kind: "seg" | "sep"; text: string }

function splitPieces(cmd: string): Piece[] {
  const pieces: Piece[] = [];
  let cur = "";
  let quote: string | null = null;
  const pushSeg = () => {
    if (cur.trim().length) pieces.push({ kind: "seg", text: cur.trim() });
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      pushSeg();
      pieces.push({ kind: "sep", text: "; " });
      continue;
    }
    if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
      pushSeg();
      pieces.push({ kind: "sep", text: `${ch}${cmd[i + 1]} ` });
      i++;
      continue;
    }
    cur += ch;
  }
  pushSeg();
  return pieces;
}

/** Does the command contain an UNQUOTED heredoc operator (`<<`)? If so it is
 * a script upload/poll body — never split it, never intercept inside it. */
function hasHeredoc(cmd: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<") return true;
  }
  return false;
}

/** Quote-aware whitespace tokenizer (strips quotes from tokens). */
function tokenize(seg: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let hasTok = false;
  for (const ch of String(seg)) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      hasTok = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasTok = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasTok || cur) {
        toks.push(cur);
        cur = "";
        hasTok = false;
      }
      continue;
    }
    cur += ch;
    hasTok = true;
  }
  if (hasTok || cur) toks.push(cur);
  return toks;
}

/** Quote-aware tokenizer that also records each token's position in the
 * ORIGINAL string (quote chars excluded from .text but included in the
 * [start, end) span). Used by the salloc parser to slice the trailing
 * command VERBATIM — original quoting/operators preserved for `bash -c`. */
interface RawTok { text: string; start: number; end: number }

function tokenizeWithPos(s: string): RawTok[] {
  const toks: RawTok[] = [];
  let cur = "";
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (start < 0) start = i;
      continue;
    }
    if (/\s/.test(ch)) {
      if (start >= 0) {
        toks.push({ text: cur, start, end: i });
        cur = "";
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
    cur += ch;
  }
  if (start >= 0) toks.push({ text: cur, start, end: s.length });
  return toks;
}

// ---------------------------------------------------------------------------
// Mini-SLURM — an in-memory scheduler that EXECUTES the submitted scripts
// for real via /bin/bash (only the SCHEDULING is faked, never the science).
// ---------------------------------------------------------------------------

type MockJobState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface MockJob {
  id: number;
  name: string;
  state: MockJobState;
  scriptPath: string;
  proc: any | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  cancelled: boolean;
  stdoutPath: string;
  stderrPath: string;
}

const jobs = new Map<number, MockJob>();
let nextJobId = 900001;

/** States squeue reports (real Slurm purges terminal states from squeue). */
const SQUEUE_STATES = new Set<MockJobState>(["PENDING", "RUNNING", "COMPLETING"]);

function parseSbatchDirectives(text: string): {
  output?: string;
  error?: string;
  jobName?: string;
} {
  const dirs: { output?: string; error?: string; jobName?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^#SBATCH\s+--([\w-]+)(?:=|\s+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const val = m[2].trim().replace(/^['"]|['"]$/g, "");
    if (m[1] === "output") dirs.output = val;
    else if (m[1] === "error" || m[1] === "err") dirs.error = val;
    else if (m[1] === "job-name") dirs.jobName = val;
  }
  return dirs;
}

/** Submit: PENDING → (1.5s) → RUNNING → spawn the script FOR REAL with its
 * #SBATCH --output/--error files wired as the process stdio, so run.out /
 * run.err land in the remote workdir exactly where the liveness protocol
 * expects them. Command-line -o/-e/-J overrides win over script directives
 * (real sbatch precedence). */
function submitJob(
  scriptPath: string,
  baseDir: string,
  overrides: { name?: string; output?: string; error?: string } = {},
): number {
  let text = "";
  try {
    text = readFileSync(scriptPath, "utf8");
  } catch {
    /* handled by caller (existence pre-checked) */
  }
  const dirs = parseSbatchDirectives(text);
  const id = nextJobId++;
  const jobName = overrides.name || dirs.jobName || `job${id}`;

  // Resolve output/error (relative to the submit cwd; %j → job id, like Slurm).
  const expandSlurm = (p: string) => expandPath(p.replace(/%j/g, String(id)), baseDir);
  const outRaw = overrides.output ?? dirs.output ?? `slurm-${id}.out`;
  const errRaw = overrides.error ?? dirs.error ?? outRaw;
  const outPath = expandSlurm(outRaw);
  const errPath = expandSlurm(errRaw);
  // The output dirs must exist before the redirection (Slurm creates them).
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    if (errPath !== outPath) mkdirSync(dirname(errPath), { recursive: true });
  } catch {
    /* best effort — spawn will fail honestly if unwritable */
  }

  const job: MockJob = {
    id,
    name: jobName,
    state: "PENDING",
    scriptPath,
    proc: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    cancelled: false,
    stdoutPath: outPath,
    stderrPath: errPath,
  };
  jobs.set(id, job);
  log(`slurm: job ${id} PENDING (script: ${scriptPath})`);

  // PENDING → RUNNING after a short scheduling delay.
  setTimeout(() => {
    if (job.cancelled || job.state !== "PENDING") return;
    job.state = "RUNNING";
    job.startedAt = Date.now();
    log(`slurm: job ${id} PENDING → RUNNING (out: ${outPath})`);

    let proc: any;
    const fds: number[] = [];
    try {
      const outFd = openSync(outPath, "a");
      fds.push(outFd);
      const errFd = errPath === outPath ? outFd : openSync(errPath, "a");
      if (errFd !== outFd) fds.push(errFd);
      proc = spawn("/bin/bash", [scriptPath], {
        cwd: baseDir,
        env: commandEnv(),
        detached: true, // own process group → scancel can group-kill
        stdio: ["ignore", outFd, errFd],
      });
      // The child owns its copies now — close ours so nothing blocks.
      for (const fd of fds) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    } catch (err: any) {
      job.state = "FAILED";
      job.exitCode = 1;
      job.finishedAt = Date.now();
      log(`slurm: job ${id} FAILED to start: ${err?.message ?? err}`);
      return;
    }
    job.proc = proc;
    proc.unref?.();

    const settle = (code: number | null) => {
      if (job.finishedAt != null) return;
      job.finishedAt = Date.now();
      job.exitCode = code ?? (job.cancelled ? 143 : 1);
      job.state = job.cancelled
        ? "CANCELLED"
        : code === 0
          ? "COMPLETED"
          : "FAILED";
      log(
        `slurm: job ${id} → ${job.state} (exit ${job.exitCode}, ` +
          `elapsed ${fmtElapsed(job.finishedAt - (job.startedAt ?? job.finishedAt))})`,
      );
    };
    proc.on("exit", (code: number | null) => settle(code));
    proc.on("close", (code: number | null) => settle(code));
    proc.on("error", (err: any) => {
      log(`slurm: job ${id} process error: ${err?.message ?? err}`);
      settle(1);
    });
  }, 1500);

  return id;
}

/** Cancel: SIGTERM the process group (the script's TERM trap writes
 * .cf-exit 143); scancel owns the CANCELLED verdict. */
function cancelJob(id: number): { ok: boolean; err?: string } {
  const job = jobs.get(id);
  if (!job) return { ok: false, err: `scancel: error: Invalid job id specified` };
  if (job.state === "PENDING") {
    job.cancelled = true;
    job.state = "CANCELLED";
    job.finishedAt = Date.now();
    job.exitCode = 143;
    log(`slurm: job ${id} PENDING → CANCELLED (scancel)`);
    return { ok: true };
  }
  if (job.state === "RUNNING" || job.state === "COMPLETING") {
    job.cancelled = true;
    job.state = "CANCELLED";
    job.finishedAt = Date.now();
    if (job.exitCode == null) job.exitCode = 143;
    const pid = job.proc?.pid;
    try {
      if (pid) process.kill(-pid, "SIGTERM"); // the whole process group
    } catch {
      try {
        job.proc?.kill?.("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    log(`slurm: job ${id} RUNNING → CANCELLED (scancel, SIGTERM to pgid ${pid ?? "?"})`);
    return { ok: true };
  }
  return { ok: false, err: `scancel: error: Job ${id} has already finished` };
}

/** ms → sacct-style Elapsed ("HH:MM:SS"; days as "D-HH:MM:SS"). */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = String(d > 0 ? h : h).padStart(2, "0");
  const core = `${hh}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}-${core}` : core;
}

function jobElapsed(job: MockJob, now = Date.now()): string {
  if (job.startedAt == null) return "00:00:00";
  const end = job.finishedAt ?? now;
  return fmtElapsed(end - job.startedAt);
}

// ---------------------------------------------------------------------------
// Scheduler command emulation (intercepted in JS BEFORE bash)
// ---------------------------------------------------------------------------

interface EmuResult {
  out: string;
  err: string;
  code: number;
}

const GPU_MODEL = "NVIDIA A100-SXM4-40GB";
const NGPUS = 8;
const GPU_TOTAL_MIB = 40960;
/** Per-card inventory (the tutorial pins cards 6 and 7 — they are free).
 * Shared by the JS emulation below and mirrored by fs/opt/bin/nvidia-smi
 * (the file shim serves commands spawned by other commands, e.g.
 * `ssh gpu05 nvidia-smi …`). */
const GPU_MEM_USED = [35214, 38902, 30156, 33440, 28406, 36711, 428, 1105];
const GPU_UTIL = [91, 97, 78, 85, 62, 93, 0, 3];

/** sinfo partition inventory (mirrors a small shared GPU cluster + the
 * tutorial's brain2 partition with the AF2 stage-2 node gpu05). */
const SINFO_ROWS: Array<Record<string, string>> = [
  { P: "brain2", a: "up", D: "1", G: "gpu:8", T: "mixed", l: "08:00:00", L: "02:00:00", N: "gpu05", c: "64", m: "512000+" },
  { P: "gpu", a: "up", D: "2", G: "gpu:4", T: "mixed", l: "08:00:00", L: "02:00:00", N: "node[01-02]", c: "32", m: "256000+" },
  { P: "cpu", a: "up", D: "8", G: "0", T: "idle", l: "72:00:00", L: "48:00:00", N: "node[03-10]", c: "64", m: "512000+" },
];

function squeueField(field: string, job: MockJob): string {
  switch (field) {
    case "i": return String(job.id);
    case "P": return "gpu";
    case "j": return job.name;
    case "u": return AUTH_USER;
    case "T": return job.state;
    case "M": {
      // running time MM:SS (or HH:MM:SS past an hour), "0:00" when pending
      if (job.startedAt == null) return "0:00";
      const secs = Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${m}:${String(s).padStart(2, "0")}`;
    }
    case "D": return "1";
    case "N": return "node01";
    case "R": return job.state === "PENDING" ? "(Resources)" : "node01";
    case "%": return "%";
    default: return "";
  }
}

function renderFormat(fmt: string, getField: (token: string) => string): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      out += getField(fmt[i + 1]);
      i++;
    } else {
      out += fmt[i];
    }
  }
  return out;
}

function emulateSqueue(tokens: string[]): EmuResult {
  let wantIds: string[] = [];
  let header = true;
  let fmt = "%i %P %j %u %T %M %D %R";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-j" || t === "--jobs") wantIds = (tokens[++i] ?? "").split(",").filter(Boolean);
    else if (t.startsWith("--jobs=")) wantIds = t.slice(7).split(",").filter(Boolean);
    else if (t === "-h" || t === "--noheader") header = false;
    else if (t === "-o" || t === "--format") fmt = tokens[++i] ?? fmt;
    else if (t.startsWith("--format=")) fmt = t.slice(9);
    else if (t === "-P" || t === "--parsable") header = false;
    // -p/--states/-u/… accepted and ignored
  }
  const live = [...jobs.values()].filter((j) => SQUEUE_STATES.has(j.state));
  const selected = wantIds.length
    ? wantIds.map((id) => jobs.get(Number(id))).filter((j): j is MockJob => !!j && SQUEUE_STATES.has(j.state))
    : live;
  let out = "";
  if (header && !wantIds.length) {
    out += "  JOBID PARTITION     NAME     USER ST    TIME  NODES NODELIST(REASON)\n";
  }
  for (const job of selected) {
    out += `${renderFormat(fmt, (tok) => squeueField(tok, job))}\n`;
  }
  return { out, err: "", code: 0 };
}

function sacctField(name: string, job: MockJob): string {
  switch (name.trim()) {
    case "JobID": case "jobid": return String(job.id);
    case "JobName": return job.name;
    case "State": case "STATE": return job.state;
    case "ExitCode": case "Exit": return job.exitCode == null ? "" : `${job.exitCode}:0`;
    case "Elapsed": return job.startedAt == null ? "" : jobElapsed(job);
    case "MaxRSS": return "0";
    case "Partition": return "gpu";
    case "User": return AUTH_USER;
    case "Start": case "End": return "";
    default: return "";
  }
}

function emulateSacct(tokens: string[]): EmuResult {
  let wantIds: string[] = [];
  let header = true;
  let cols: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-j" || t === "--jobs") wantIds = (tokens[++i] ?? "").split(",").filter(Boolean);
    else if (t.startsWith("--jobs=")) wantIds = t.slice(7).split(",").filter(Boolean);
    else if (t === "-n" || t === "--noheader" || t === "-P" || t === "--parsable") header = false;
    else if (t === "-o" || t === "--format" || t === "-f" || t === "--fields") cols = tokens[++i] ?? null;
    else if (t.startsWith("--format=")) cols = t.slice(9);
    else if (t === "-S" || t === "-E" || t === "-s" || t === "-u" || t === "-X" || t === "--allocations" || t === "--brief" || t === "--json" || t === "--yaml") {
      // -S/-E/-s/-u take a value; swallow it
      if (["-S", "-E", "-s", "-u"].includes(t) && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
    }
    // --units=G etc: swallowed
  }
  if (!wantIds.length) {
    // bare sacct: every job, default columns
    wantIds = [...jobs.keys()].map(String);
  }
  const outLines: string[] = [];
  const colList = cols ? cols.split(",").map((c) => c.trim()).filter(Boolean) : null;
  for (const idStr of wantIds) {
    const job = jobs.get(Number(idStr));
    if (!job) {
      // silent for unknown ids (no accounting row == no testimony), exit 0
      continue;
    }
    if (colList) {
      outLines.push(colList.map((c) => sacctField(c, job)).join("|"));
    } else {
      // the task-23 contract line: <id>|<STATE>|<exitCode>|<elapsed>|MaxRSS>
      outLines.push(
        `${job.id}|${job.state}|${job.exitCode ?? ""}|${jobElapsed(job)}|0`,
      );
    }
  }
  let out = "";
  if (header && outLines.length) {
    out += colList
      ? `${colList.join("|")}\n`
      : "JobID|State|ExitCode|Elapsed|MaxRSS\n";
  }
  out += outLines.join("\n") + (outLines.length ? "\n" : "");
  return { out, err: "", code: 0 };
}

function emulateScancel(tokens: string[]): EmuResult {
  const errs: string[] = [];
  let lastName: string | null = null;
  let exitCode = 0;
  for (const t of tokens) {
    if (t === "-n" || t === "--name") {
      lastName = "__next__";
      continue;
    }
    if (lastName === "__next__") {
      lastName = t;
      for (const job of [...jobs.values()]) {
        if (job.name === lastName) cancelJob(job.id);
      }
      lastName = null;
      continue;
    }
    if (t.startsWith("--name=")) {
      const want = t.slice(7);
      for (const job of [...jobs.values()]) {
        if (job.name === want) cancelJob(job.id);
      }
      continue;
    }
    if (/^\d+$/.test(t)) {
      const r = cancelJob(Number(t));
      if (!r.ok && r.err) errs.push(r.err);
      continue;
    }
    // other flags (-u user, -s SIG, -t …) swallowed
  }
  return { out: "", err: errs.join("\n") + (errs.length ? "\n" : ""), code: exitCode };
}

function emulateSinfo(tokens: string[]): EmuResult {
  let header = true;
  let fmt: string | null = null;
  let partition: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-h" || t === "--noheader") header = false;
    else if (t === "-o" || t === "--format") fmt = tokens[++i] ?? null;
    else if (t.startsWith("--format=")) fmt = t.slice(9);
    else if (t === "-p" || t === "--partition") partition = tokens[++i] ?? null;
    else if (t.startsWith("--partition=")) partition = t.slice(11);
    // -N/-n/-l/… accepted and ignored
  }
  const rows = partition ? SINFO_ROWS.filter((r) => r.P === partition) : SINFO_ROWS;
  const field = (tok: string, r: Record<string, string>) => {
    if (tok === "%") return "%";
    return r[tok] ?? "";
  };
  let out = "";
  if (fmt) {
    // any -o format (with or without %P) → the standard 5-field rows
    for (const r of rows) out += `${renderFormat(fmt, (tok) => field(tok, r))}\n`;
  } else {
    out += "PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST\n";
    for (const r of rows) {
      out += `${r.P}*`.padEnd(10) + `${r.a}`.padEnd(8) + `${r.l}`.padEnd(11) +
        `${r.D}`.padEnd(7) + `${r.T}`.padEnd(7) + `${r.N}\n`;
    }
  }
  return { out, err: "", code: 0 };
}

function emulateSbatch(tokens: string[], baseDir: string): EmuResult {
  // --version / --help answer immediately (the probe asks these).
  if (tokens.some((t) => t === "--version" || t === "-V" || t === "-4" || t === "--help")) {
    if (tokens.includes("--help")) {
      return { out: "Usage: sbatch [OPTIONS(0)...] [script(0) [args(0)...]]\nmock-cluster mini-SLURM (test harness)\n", err: "", code: 0 };
    }
    return { out: "slurm 24.05.2\n", err: "", code: 0 };
  }
  let script: string | null = null;
  let name: string | undefined;
  let cliOut: string | undefined;
  let cliErr: string | undefined;
  let parsable = false;
  let wrap: string | null = null;
  const flagWithValues = new Map<string, string>([
    ["-o", "output"], ["--output", "output"],
    ["-e", "error"], ["--error", "error"],
    ["-J", "name"], ["--job-name", "name"],
    ["-p", ""], ["--partition", ""], ["-N", ""], ["--nodes", ""],
    ["-n", ""], ["--ntasks", ""], ["-c", ""], ["--cpus-per-task", ""],
    ["-g", ""], ["--gres", ""], ["-t", ""], ["--time", ""], ["--mem", ""],
    ["-C", ""], ["--constraint", ""], ["-A", ""], ["--account", ""],
    ["-D", ""], ["--chdir", ""], ["--dependency", ""], ["--array", ""],
    ["-w", ""], ["--nodelist", ""], ["-M", ""], ["--clusters", ""],
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--parsable" || t === "-P") {
      parsable = true;
      continue;
    }
    if (t.startsWith("--wrap=")) {
      wrap = t.slice(7);
      continue;
    }
    if (t === "--wrap") {
      wrap = tokens[++i] ?? null;
      continue;
    }
    if (flagWithValues.has(t)) {
      const kind = flagWithValues.get(t)!;
      const val = tokens[i + 1] ?? "";
      if (kind === "output") cliOut = val;
      else if (kind === "error") cliErr = val;
      else if (kind === "name") name = val;
      i++; // consume the value
      continue;
    }
    if (/^--\w[\w-]*=/.test(t)) {
      const key = t.split("=")[0];
      const val = t.slice(key.length + 1);
      if (key === "--job-name") name = val;
      else if (key === "--output") cliOut = val;
      else if (key === "--error") cliErr = val;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) continue; // unknown flag: swallow
    if (script == null) script = t;
  }
  if (wrap != null) {
    // --wrap="cmds": synthesize the script like real sbatch does.
    try {
      mkdirSync(join(FS_ROOT, "projects"), { recursive: true });
      script = join(FS_ROOT, "projects", `.wrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
      writeFileSync(script, `#!/bin/bash\n${wrap}\n`, { mode: 0o755 });
    } catch (err: any) {
      return { out: "", err: `sbatch: error: --wrap failed: ${err?.message ?? err}\n`, code: 1 };
    }
  }
  if (!script) {
    return { out: "", err: 'sbatch: error: "This does not look like a batch script.  The first\n line must start with "#!" followed by the path to an interpreter."\n', code: 1 };
  }
  const scriptPath = expandPath(script, baseDir);
  if (!existsSync(scriptPath)) {
    return { out: "", err: `sbatch: error: Batch script not found or invalid: ${scriptPath}\n`, code: 1 };
  }
  const id = submitJob(scriptPath, baseDir, { name, output: cliOut, error: cliErr });
  return {
    out: parsable ? `${id}\n` : `Submitted batch job ${id}\n`,
    err: "",
    code: 0,
  };
}

function emulateNvidiaSmi(tokens: string[]): EmuResult {
  // find the --query-gpu field list (either --query-gpu=f1,f2 or --query-gpu f1,f2)
  let query: string[] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--query-gpu=")) {
      query = t.slice("--query-gpu=".length).split(",");
      break;
    }
    if (t === "--query-gpu") {
      query = (tokens[i + 1] ?? "").split(",");
      break;
    }
  }
  if (query) {
    const fields = query.map((f) => f.trim()).filter(Boolean);
    // `count` collapses the whole report to a single row (real nvidia-smi)
    if (fields.some((f) => f === "count" || f === "count.count")) {
      const line = fields
        .map((f) => (f === "count" || f === "count.count" ? String(NGPUS) : GPU_MODEL))
        .join(", ");
      return { out: `${line}\n`, err: "", code: 0 };
    }
    const field = (f: string, i: number): string => {
      switch (f) {
        case "index": case "index.count": return String(i);
        case "name": return GPU_MODEL;
        case "name.display_mode": return "Enabled";
        case "name.display_active": return "Disabled";
        case "memory.used": return String(GPU_MEM_USED[i]);
        case "memory.total": return String(GPU_TOTAL_MIB);
        case "memory.free": return String(GPU_TOTAL_MIB - GPU_MEM_USED[i]);
        case "utilization.gpu": case "utilization.memory": return String(GPU_UTIL[i]);
        case "uuid": return `GPU-00000000-mock-000${i}`;
        case "temperature.gpu": return String(38 + i);
        case "power.draw": return String(90 + i * 7);
        case "fan.speed": return String(23 + i);
        default: return "?";
      }
    };
    let out = "";
    for (let i = 0; i < NGPUS; i++) {
      out += fields.map((f) => field(f, i)).join(", ") + "\n";
    }
    return { out, err: "", code: 0 };
  }
  if (tokens.includes("-L")) {
    return {
      out: Array.from({ length: NGPUS }, (_, i) =>
        `GPU ${i}: ${GPU_MODEL} (UUID: GPU-00000000-mock-000${i})\n`).join(""),
      err: "",
      code: 0,
    };
  }
  // bare nvidia-smi: a small plausible summary table + the standard headers
  const tableRows = GPU_MEM_USED.map((mem, i) => {
    const bus = `00000000:${String(i).padStart(2, "0")}:00.0`;
    return (
      `|   ${String(i).padStart(2)}  ${GPU_MODEL}  Off | ${bus}  Off | ${String(GPU_UTIL[i]).padStart(3)} %                |\n` +
      `|   ${String(23 + i).padStart(2)}%   ${String(38 + i).padStart(2)}C    P0    ${String(90 + i * 7).padStart(3)}W / 400W |  ${String(mem).padStart(5)}MiB / ${GPU_TOTAL_MIB}MiB |    ${String(GPU_UTIL[i]).padStart(3)}%     Default |\n`
    );
  }).join("");
  return {
    out: `${new Date().toString()}\n` +
      `+-----------------------------------------------------------------------------+\n` +
      `| NVIDIA-SMI 535.129.03   Driver Version: 535.129.03   CUDA Version: 12.2    |\n` +
      `|-------------------------------+----------------------+----------------------+\n` +
      `| GPU  Name        Persistence-M| Bus-Id        Disp.A | Volatile Uncorr. ECC |\n` +
      `|   Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  Compute M. |\n` +
      `|===============================+======================+======================|\n` +
      tableRows +
      `|                               |                      |                      |\n` +
      `+-------------------------------+----------------------+----------------------+\n` +
      `[mock-cluster] ${NGPUS} emulated GPUs (local test cluster)\n`,
    err: "",
    code: 0,
  };
}

const SCHEDULER_TOOLS = new Set([
  "sbatch", "squeue", "sacct", "scancel", "sinfo", "nvidia-smi",
]);

/** One scheduler segment, emulated in JS. Returns null when not schedulery.
 * Also answers the identity one-liners (`whoami`, `id -un`) the app's probe
 * speaks — the emulated login node's user is "foundry" (the OS uid cannot
 * change without root; HOME/USER env already say foundry). */
function emulateSegment(seg: string, baseDir: string): EmuResult | null {
  const tokens = tokenize(seg);
  if (!tokens.length) return { out: "", err: "", code: 0 };
  const tool = tokens[0];
  if (tool === "whoami" && tokens.length === 1) {
    return { out: `${AUTH_USER}\n`, err: "", code: 0 };
  }
  if (tool === "id" && (tokens.length === 2 && tokens[1] === "-un")) {
    return { out: `${AUTH_USER}\n`, err: "", code: 0 };
  }
  if (tool === "id" && tokens.length === 3 && tokens[1] === "-u" && tokens[2] === "-n") {
    return { out: `${AUTH_USER}\n`, err: "", code: 0 };
  }
  if (!SCHEDULER_TOOLS.has(tool)) return null;
  const rest = tokens.slice(1);
  switch (tool) {
    case "sbatch": return emulateSbatch(rest, baseDir);
    case "squeue": return emulateSqueue(rest);
    case "sacct": return emulateSacct(rest);
    case "scancel": return emulateScancel(rest);
    case "sinfo": return emulateSinfo(rest);
    case "nvidia-smi": return emulateNvidiaSmi(rest);
    default: return null;
  }
}

/** Quote a string for safe single-quoting in bash. */
function bashSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Inline an emulated scheduler result as a bash subshell so a MIXED
 * compound command keeps `;` / `&&` / `||` semantics with correct exit
 * codes (`echo x; sbatch --version` → `echo x; printf %s 'slurm …\n'`). */
function inlineEmu(emu: EmuResult): string {
  const parts: string[] = [];
  if (emu.out) parts.push(`printf %s ${bashSingleQuote(emu.out)}`);
  if (emu.err) parts.push(`printf %s ${bashSingleQuote(emu.err)} >&2`);
  if (!parts.length) parts.push("true");
  if (emu.code !== 0) parts.push(`exit ${emu.code}`);
  return parts.length === 1 ? parts[0] : `( ${parts.join("; ")} )`;
}

/** Scheduler plan for one exec:
 *   - { pure }      — EVERY segment is a scheduler/identity call → answered
 *                     entirely in JS (no bash at all; exact bytes + exit code).
 *   - { rewritten } — a MIXED compound (e.g. `echo x; sbatch --version`,
 *                     `cd W && sbatch run.sh`) → scheduler segments are
 *                     computed now and inlined as bash subshells; everything
 *                     else runs in real bash.
 *   - null          — nothing schedulery (or a heredoc body) → plain bash.
 * `cd <dir>` segments are tracked so relative sbatch script paths resolve
 * against the directory the app cd'd into. */
function planScheduler(raw: string):
  | { pure: EmuResult }
  | { rewritten: string; inlined: number }
  | null {
  let cmd = String(raw ?? "").trim();
  if (!cmd || hasHeredoc(cmd)) return null;
  // Existence probes for the emulated scheduler tools (`command -v sbatch`,
  // `which squeue` …) must SUCCEED like on a real login node — the tools are
  // JS-intercepted, not files on PATH, so rewrite them to an always-present
  // binary. With `>/dev/null` this is a pure exit-code check; bare use prints
  // bash's path (close enough for a test harness).
  cmd = cmd.replace(
    /(?:command\s+-v|which)\s+(sbatch|squeue|scancel|sacct|sinfo|nvidia-smi)\b/g,
    "command -v bash",
  );
  const pieces = splitPieces(cmd);
  if (!pieces.length) return null;
  let baseDir = FS_ROOT;
  let emuCount = 0;
  let segCount = 0;
  const emuByIndex: (EmuResult | null)[] = [];
  const outs: string[] = [];
  const errs: string[] = [];
  let lastCode = 0;
  for (const piece of pieces) {
    if (piece.kind === "sep") {
      emuByIndex.push(null);
      continue;
    }
    segCount++;
    const tokens = tokenize(piece.text);
    // `cd <dir>` segments steer relative-path resolution for later segments
    if (tokens[0] === "cd" && tokens.length === 2) {
      baseDir = expandPath(tokens[1], baseDir);
      emuByIndex.push(null);
      continue;
    }
    const emu = emulateSegment(piece.text, baseDir);
    if (emu) {
      emuCount++;
      lastCode = emu.code;
      outs.push(emu.out);
      errs.push(emu.err);
    }
    emuByIndex.push(emu);
  }
  if (emuCount === 0) return null;
  if (emuCount === segCount) {
    // `;` semantics: the exit code of the LAST segment wins.
    return { pure: { out: outs.join(""), err: errs.join(""), code: lastCode } };
  }
  // mixed: rebuild the command with emulated segments inlined
  const rebuilt: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const emu = emuByIndex[i];
    if (emu) rebuilt.push(inlineEmu(emu));
    else rebuilt.push(pieces[i].text);
  }
  return { rewritten: rebuilt.join(""), inlined: emuCount };
}

// ---------------------------------------------------------------------------
// salloc — the tutorial's allocation step, intercepted as a TOP-LEVEL exec
// (Task 25-c). The whole chain arrives as ONE exec:
//     salloc -N 1 --gres=gpu:1 -p brain2 ssh gpu05 bash <W>/.fl-node.sh
// Parse the allocation flags, grant an id from the SAME 900001+ counter the
// sbatch state machine uses, print the real salloc banner to stderr, then
// execute the trailing command FOR REAL (same detached spawn + exit-code
// forwarding as ordinary commands) with the SLURM_* env exported. salloc
// nested INSIDE scripts (the app's .fl-run.sh wrappers run it under
// `setsid bash -c '…'`) is served by the fs/opt/bin/salloc file-shim twin.
// ---------------------------------------------------------------------------

/** GPU card count out of a --gres spec: "gpu", "gpu:2", "gpu:A100:2",
 * "gpu:2,shm:1", or a bare "2". */
function gpuCountFromGres(spec: string): number | null {
  for (const part of String(spec ?? "").split(",")) {
    const p = part.trim();
    if (p === "gpu") return 1;
    if (p.startsWith("gpu:")) {
      const sub = p.slice(4);
      if (/^\d+$/.test(sub)) return Number(sub) || null;
      const m = /:(\d+)$/.exec(sub);
      if (m) return Number(m[1]) || null;
      return 1; // "gpu:A100" (model only, count defaults to 1)
    }
    if (/^\d+$/.test(p)) return Number(p) || null;
  }
  return null;
}

interface SallocPlan {
  version: boolean;
  nodes: number | null;
  gpus: number | null;
  partition: string;
  /** The trailing command, sliced VERBATIM from the raw exec (""). */
  cmdRaw: string;
}

/** Parse `salloc [flags] <command…>` from the raw exec string. */
function parseSallocCommand(raw: string): SallocPlan {
  const base = String(raw ?? "").trim();
  const toks = tokenizeWithPos(base);
  let i = 1; // toks[0] === "salloc" (guaranteed by the caller)
  let version = false;
  let nodes: number | null = null;
  let gpus: number | null = null;
  let partition = "";
  let cmdStart = -1;
  const valueFlags = new Set([
    "-N", "--nodes", "-g", "--gres", "-p", "--partition", "-w", "--nodelist",
    "-n", "--ntasks", "-c", "--cpus-per-task", "-t", "--time", "-C",
    "--constraint", "-A", "--account", "-D", "--chdir", "-J", "--job-name",
    "-q", "--qos", "-M", "--clusters", "--mem", "--mem-per-cpu",
    "--mem-per-gpu", "--begin", "--deadline", "--signal", "-K",
    "--kill-command", "--mpi",
  ]);
  while (i < toks.length) {
    const t = toks[i];
    const text = t.text;
    if (text === "--") {
      if (i + 1 < toks.length) cmdStart = toks[i + 1].start;
      break;
    }
    if (text === "--version" || text === "-V" || text === "-4" || text === "--help") {
      version = true;
      i++;
      continue;
    }
    const eq = /^--[\w-]+=/.test(text) ? text.indexOf("=") : -1;
    if (eq > 0) {
      const key = text.slice(0, eq);
      const val = text.slice(eq + 1);
      if (key === "--nodes") nodes = Number(val) || null;
      else if (key === "--gres") gpus = gpuCountFromGres(val);
      else if (key === "--partition") partition = val;
      i++;
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      const m = /^-([Ngp])(.*)$/.exec(text);
      if (m) {
        if (m[2]) {
          if (m[1] === "N") nodes = Number(m[2]) || null;
          else if (m[1] === "g") gpus = gpuCountFromGres(m[2]);
          else partition = m[2];
          i++;
        } else {
          const val = toks[i + 1]?.text ?? "";
          if (m[1] === "N") nodes = Number(val) || null;
          else if (m[1] === "g") gpus = gpuCountFromGres(val);
          else partition = val;
          i += 2;
        }
        continue;
      }
      i += valueFlags.has(text) ? 2 : 1; // flag+value or bare flag
      continue;
    }
    // first non-flag word → the command runs from here to the end
    cmdStart = t.start;
    break;
  }
  const cmdRaw = cmdStart >= 0 ? base.slice(cmdStart).trim() : "";
  return { version, nodes, gpus, partition, cmdRaw };
}

/** Is this exec a salloc chain the JS layer should own? Only SINGLE-segment
 * commands starting with `salloc` (the app dispatches exactly that shape);
 * compound/nested salloc is left to real bash + the fs/opt/bin/salloc twin. */
function isSallocExec(raw: string): boolean {
  const cmd = String(raw ?? "").trim();
  if (!cmd || hasHeredoc(cmd)) return false;
  const pieces = splitPieces(cmd);
  if (pieces.length !== 1 || pieces[0].kind !== "seg") return false;
  const toks = tokenize(pieces[0].text);
  return toks[0] === "salloc";
}

/** Handle a top-level salloc exec. Returns the spawned process (for signal
 * forwarding) — or null for the answered-in-JS paths (version / error). */
function handleSallocExec(stream: any, raw: string): any | null {
  const plan = parseSallocCommand(raw);
  if (plan.version) {
    safeWrite(stream, "slurm 24.05.2\n");
    try { stream.exit(0); } catch { /* ignore */ }
    try { stream.close(); } catch { /* ignore */ }
    return null;
  }
  if (!plan.cmdRaw) {
    safeWrite(
      stream.stderr,
      "salloc: error: interactive mode unsupported on this channel — append a command\n",
    );
    try { stream.exit(1); } catch { /* ignore */ }
    try { stream.close(); } catch { /* ignore */ }
    return null;
  }
  const id = nextJobId++;
  log(`salloc: granted allocation ${id} (nodes=${plan.nodes ?? "?"} gpus=${plan.gpus ?? "?"} partition=${plan.partition || "?"})`);
  safeWrite(stream.stderr, `salloc: Granted job allocation ${id}\n`);
  const env: NodeJS.ProcessEnv = { ...commandEnv() };
  env.SLURM_JOB_ID = String(id);
  if (plan.nodes != null) env.SLURM_JOB_NUM_NODES = String(plan.nodes);
  if (plan.partition) env.SLURM_JOB_PARTITION = plan.partition;
  if (plan.gpus != null) env.SLURM_GPUS_ON_NODE = String(plan.gpus);
  // The trailing command executes FOR REAL; runCommand forwards its exit
  // code to the channel (salloc semantics: allocation ends with the command).
  return runCommand(stream, ["-c", plan.cmdRaw], env);
}

// ---------------------------------------------------------------------------
// Command runner — REAL /bin/bash, wired to the SSH channel
// ---------------------------------------------------------------------------

function runCommand(
  stream: any,
  args: string[],
  env: NodeJS.ProcessEnv = commandEnv(),
): any | null {
  let proc: any;
  try {
    proc = spawn("/bin/bash", args, {
      cwd: FS_ROOT,
      env,
      detached: true, // own session → backgrounded children survive
    });
  } catch (err: any) {
    safeWrite(stream.stderr, `mock-cluster: failed to spawn bash: ${err?.message ?? err}\n`);
    try { stream.exit(127); } catch { /* ignore */ }
    try { stream.close(); } catch { /* ignore */ }
    return null;
  }

  let dead = false; // direct child exited/errored
  let finished = false; // channel already closed
  let exitCode = 0;
  let exitSignal: string | null = null;
  let outEnded = !proc.stdout;
  let errEnded = !proc.stderr;
  let graceTimer: any = null;
  let lastFlow = Date.now();
  let graceStart = 0;
  let pendingWrites = 0;

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
  const cleanupPipes = () => {
    try { proc.stdout?.destroy(); } catch { /* ignore */ }
    try { proc.stderr?.destroy(); } catch { /* ignore */ }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearGrace();
    try {
      if (exitSignal) stream.exit(exitSignal, false, `killed by ${exitSignal}`);
      else stream.exit(exitCode);
    } catch { /* ignore */ }
    try { stream.close(); } catch { /* ignore */ }
    cleanupPipes();
  };
  const maybeFinish = () => {
    if (finished || !dead) return;
    if (outEnded && errEnded) {
      if (pendingWrites > 0) {
        armGrace(); // handed to the channel but not yet flushed
        return;
      }
      finish();
      return;
    }
    armGrace(); // a pipe is still open (drain, or a grandchild holding it)
  };
  const armGrace = () => {
    if (graceTimer) return;
    graceStart = Date.now();
    graceTimer = setTimeout(function check() {
      const now = Date.now();
      if (now - graceStart > DRAIN_HARD_CAP_MS) return finish(); // no hang, ever
      if (now - lastFlow < DRAIN_GRACE_MS) {
        graceTimer = setTimeout(check, DRAIN_GRACE_MS);
        return;
      }
      finish();
    }, DRAIN_GRACE_MS);
  };

  const markDead = (code: number | null, signal: string | null) => {
    dead = true;
    exitSignal = signal ?? null;
    exitCode = code ?? (signal ? 1 : 0);
    maybeFinish();
  };
  proc.on("error", (err: any) => {
    safeWrite(stream.stderr, `mock-cluster: ${err?.message ?? err}\n`);
    markDead(127, null);
  });
  // exit resolves on BOTH 'exit' and 'close' (close = stdio settled) —
  // whichever fires first wins; the drain-aware grace bounds the rest.
  proc.on("exit", (code: number | null, signal: string | null) => markDead(code, signal));
  proc.on("close", (code: number | null, signal: string | null) => markDead(code, signal));

  try {
    const pump = (src: any, dest: any, onEnd: () => void) => {
      src.on("data", (chunk: Buffer) => {
        lastFlow = Date.now();
        pendingWrites++;
        try {
          const flushed = dest.write(chunk, () => {
            pendingWrites--;
            lastFlow = Date.now();
            maybeFinish();
          });
          if (!flushed) {
            src.pause();
            dest.once("drain", () => src.resume());
          }
        } catch {
          pendingWrites--;
          src.destroy();
        }
      });
      src.on("end", onEnd);
    };
    if (proc.stdout) pump(proc.stdout, stream, () => { outEnded = true; maybeFinish(); });
    if (proc.stderr) pump(proc.stderr, stream.stderr, () => { errEnded = true; maybeFinish(); });

    // stdin: exec requests can carry input (upload contract: `head -c N > file`
    // with the bytes on stdin). end:false guards write-after-exit; the
    // explicit end() covers the client's channel EOF.
    stream.pipe(proc.stdin, { end: false });
    proc.stdin.on("error", () => { /* bash may exit before consuming stdin */ });
    stream.on("end", () => {
      try { proc.stdin.end(); } catch { /* child already gone */ }
    });
  } catch (err: any) {
    log(`pipe setup failed: ${err?.message ?? err}`);
    dead = true;
    finish();
    return proc;
  }

  // Client disconnected (or we closed the channel) → sshd semantics:
  // SIGHUP the direct child only; setsid/nohup'd jobs survive.
  stream.on("close", () => {
    clearGrace();
    try { proc.stdin.end(); } catch { /* ignore */ }
    if (!dead) {
      log(`channel closed while command still running — SIGHUP to pid ${proc.pid}`);
      try { proc.kill("SIGHUP"); } catch { /* already gone */ }
    }
    finished = true;
    cleanupPipes();
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Session & connection handling
// ---------------------------------------------------------------------------

function handleSession(session: any) {
  let activeProc: any = null;
  const clearActive = () => { activeProc = null; };

  session.on("signal", (accept: any, _reject: any, info: any) => {
    try { accept?.(); } catch { /* ignore */ }
    if (!activeProc) return;
    const sig = String(info?.name ?? "SIGTERM").toUpperCase();
    log(`forwarding signal ${info?.name ?? "?"} as ${sig} to pid ${activeProc.pid ?? "?"}`);
    try { activeProc.kill(sig.startsWith("SIG") ? sig : `SIG${sig}`); } catch { /* already gone */ }
  });
  session.on("pty", (accept: any) => {
    try { accept?.(); } catch { /* ignore */ }
  });
  session.on("window-change", () => { /* cosmetic only */ });

  session.on("exec", (accept: any, reject: any, info: any) => {
    let stream: any;
    try {
      stream = accept();
    } catch (err: any) {
      log(`exec accept failed: ${err?.message ?? err}`);
      try { reject?.(); } catch { /* ignore */ }
      return;
    }
    try {
      const raw = String(info?.command ?? "");
      logExec(raw);
      // Top-level salloc chains own their whole exec (grant + real run).
      if (isSallocExec(raw)) {
        activeProc = handleSallocExec(stream, raw) ?? activeProc;
        if (activeProc) activeProc.on?.("exit", clearActive);
        return;
      }
      const plan = planScheduler(raw);
      if (plan && "pure" in plan) {
        const emu = plan.pure;
        let closed = false;
        const finishEmu = () => {
          if (closed) return;
          closed = true;
          clearTimeout(guard);
          try { stream.exit(emu.code); } catch { /* ignore */ }
          try { stream.close(); } catch { /* ignore */ }
        };
        // hard safety: an emulated command can never hang the channel
        const guard = setTimeout(finishEmu, 2000);
        guard.unref?.();
        try {
          if (emu.err) safeWrite(stream.stderr, emu.err);
          if (emu.out) stream.write(emu.out, finishEmu);
          else finishEmu();
        } catch {
          finishEmu();
        }
        return;
      }
      const cmdToRun = plan && "rewritten" in plan ? plan.rewritten : raw;
      if (plan && "rewritten" in plan) {
        log(`exec: ${plan.inlined} scheduler segment(s) answered in JS, inlined for bash`);
      }
      activeProc = runCommand(stream, ["-c", cmdToRun]) ?? activeProc;
      if (activeProc) activeProc.on?.("exit", clearActive);
    } catch (err: any) {
      log(`exec handler error: ${err?.stack ?? err}`);
      safeWrite(stream.stderr, `mock-cluster: internal error: ${err?.message ?? err}\n`);
      try { stream.exit(127); } catch { /* ignore */ }
      try { stream.close(); } catch { /* ignore */ }
      clearActive();
    }
  });

  session.on("shell", (accept: any, reject: any) => {
    let stream: any;
    try {
      stream = accept();
    } catch (err: any) {
      log(`shell accept failed: ${err?.message ?? err}`);
      try { reject?.(); } catch { /* ignore */ }
      return;
    }
    log("shell: interactive login shell");
    activeProc = runCommand(stream, ["-l"]) ?? activeProc;
  });

  // NOTE: 'sftp' deliberately NOT handled — ssh2 refuses the subsystem
  // request automatically when no listener exists.
}

function handleClient(client: any) {
  const remote = `${client._sock?.remoteAddress ?? "?"}:${client._sock?.remotePort ?? "?"}`;

  client.on("authentication", (ctx: any) => {
    const { method, username } = ctx;
    if (method === "password" && username === AUTH_USER && ctx.password === AUTH_PASSWORD) {
      log(`auth ok: password login for "${username}" from ${remote}`);
      ctx.accept();
      return;
    }
    if (method !== "password") {
      log(`auth rejected: ${method} attempt for "${username}" (password only)`);
    } else {
      log(`auth rejected: bad credentials for "${username}" from ${remote}`);
    }
    ctx.reject(["password"]); // hint: only password auth is supported
  });

  client.on("ready", () => log(`client ready: ${remote}`));

  client.on("session", (accept: any, reject: any) => {
    try {
      handleSession(accept());
    } catch (err: any) {
      log(`session error: ${err?.stack ?? err}`);
      try { reject?.(); } catch { /* ignore */ }
    }
  });

  client.on("error", (err: any) => log(`client error (${remote}): ${err?.message ?? err}`));
  client.on("end", () => log(`client disconnected: ${remote}`));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// `bun --hot` re-runs this module on file change — close the previous
// listener first so the new one can bind (running jobs keep running).
const HOT_KEY = Symbol.for("foundry.mock-cluster.server");
const prev: any = (globalThis as any)[HOT_KEY];
if (prev) {
  try { prev.close(); } catch { /* ignore */ }
  log("hot reload: replaced previous listener");
}

const server = new Server({ hostKeys: [ensureHostKey()] }, handleClient);
(globalThis as any)[HOT_KEY] = server;

server.on("error", (err: any) => {
  log(`server error: ${err?.message ?? err}`);
  if (err?.code === "EADDRINUSE") {
    log(`port ${PORT} is already in use — is another mock-cluster instance running?`);
  }
});

server.listen(PORT, BIND_HOST, () => {
  log(`LOCAL TEST CLUSTER listening on :${PORT} (bind ${BIND_HOST})`);
  log(`this is a TEST HARNESS: commands execute FOR REAL via /bin/bash;`);
  log(`only the scheduler (sbatch/squeue/sacct/scancel/sinfo/salloc) is a state machine`);
  log(`auth: user "${AUTH_USER}" / password "${AUTH_PASSWORD}" (password only)`);
  log(`fs root: ${FS_ROOT} · HOME: ${HOME}`);
  log(`PATH: ${MOCK_PATH}`);
  log(`real engine dir: ${ENGINE_DIR}`);
});

// ── Loopback scheduler endpoint (fs/opt/bin file-shim backing) ────────────
// The exec layer intercepts scheduler commands that arrive as TOP-LEVEL
// segments, but the app's reconcile sweep embeds `$(squeue …)` / `$(sacct …)`
// inside command substitutions — real bash resolves those against PATH, where
// the fs/opt/bin file shims live. Shims are separate PROCESSES and cannot see
// this process's in-memory jobs map, so they call this loopback and we answer
// from the SAME emulators the exec layer uses (one state machine, two doors).
// Loopback-only bind (127.0.0.1); fixed port 3023; test harness, not product.
const SCHED_LOOPBACK_PORT = 3023;
const SCHED_HOT_KEY = Symbol.for("foundry.mock-cluster.sched-loopback");
const prevSched: any = (globalThis as any)[SCHED_HOT_KEY];
if (prevSched) {
  try { prevSched.stop(true); } catch { /* ignore */ }
}
// P2-5 (QA 34-a): Bun.serve throws synchronously on EADDRINUSE and this code
// runs after the SSH listener — a :3023 squatter must degrade the shims, not
// crash the whole harness. Shims then fail with exit 126 (honest signal).
try {
  const schedServer = Bun.serve({
    port: SCHED_LOOPBACK_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 10,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/sched") {
        return new Response("not found", { status: 404 });
      }
      const tool = url.searchParams.get("tool") ?? "";
      let argv: string[] = [];
      try {
        const parsed = JSON.parse(url.searchParams.get("argv") ?? "[]");
        if (Array.isArray(parsed)) argv = parsed.map(String);
      } catch {
        return Response.json({ out: "", err: "bad argv json", code: 64 });
      }
      const cwd = url.searchParams.get("cwd") ?? FS_ROOT;
      const seg = [tool, ...argv.map((a) => bashSingleQuote(a))].join(" ");
      const emu = emulateSegment(seg, cwd);
      if (!emu) {
        return Response.json({ out: "", err: `unknown tool: ${tool}`, code: 127 });
      }
      return Response.json(emu);
    },
  });
  (globalThis as any)[SCHED_HOT_KEY] = schedServer;
  log(`sched loopback: http://127.0.0.1:${SCHED_LOOPBACK_PORT}/sched (fs/opt/bin file-shim backing)`);
} catch (err: any) {
  log(`sched loopback unavailable (port ${SCHED_LOOPBACK_PORT} in use: ${err?.message ?? err}) — scheduler file shims degraded`);
}

// One bad command must never take the server down.
const GLOBALS_KEY = Symbol.for("foundry.mock-cluster.globals");
if (!(globalThis as any)[GLOBALS_KEY]) {
  (globalThis as any)[GLOBALS_KEY] = true;
  process.on("uncaughtException", (err: any) => {
    log(`uncaught exception (server stays up): ${err?.stack ?? err}`);
  });
  process.on("unhandledRejection", (err: any) => {
    log(`unhandled rejection (server stays up): ${err?.stack ?? err}`);
  });
  const shutdown = (sig: string) => {
    log(`received ${sig} — shutting down (${jobs.size} tracked job(s))`);
    try { server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
