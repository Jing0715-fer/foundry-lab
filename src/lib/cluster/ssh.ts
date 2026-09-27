// Cluster SSH transport — ssh2 exec-only lane (NO SFTP).
//
// Mirrors cryoflow's remote execution contract:
//   - one pooled Client per connection id, kept alive with SSH keepalives
//   - a SERIALIZED command queue per connection (clusters dislike concurrent
//     exec storms) — every exec joins the queue tail, one channel at a time
//   - exec NEVER throws: failures come back as `{ error }` so callers (probe,
//     dispatch, sweep) can degrade honestly instead of unwinding
//   - file transfer rides on exec: uploads via `head -c N > path` + stdin,
//     downloads via `cat` with byte-count verification against a pre-stat
//
// The pool is keyed by connection id; dropConnection() evicts the client when
// a connection's config is edited (host/auth changes must not reuse a live
// socket). Sockets that die mid-flight (keepalive miss) self-evict so the next
// exec transparently reconnects.

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ClusterConnection } from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  error?: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Payload written to the channel's stdin (uploads). */
  stdin?: Buffer | null;
}

interface PooledClient {
  client: Client;
  /** Resolves once the connect attempt settles (ready OR failed). */
  ready: Promise<void>;
  /** Serialized command queue — one exec at a time per connection. */
  queueTail: Promise<unknown>;
  lastError: string | null;
}

// ── Pool ────────────────────────────────────────────────────────────────────

const pool = new Map<string, PooledClient>();

const CONNECT_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Transfer timeout floor: assume at least 500 KB/s of SSH throughput. */
const BYTES_PER_SEC_FLOOR = 500_000;

/** Build the auth fragment of the ssh2 connect config. */
function authConfig(c: ClusterConnection): {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: string;
  tryKeyboard?: boolean;
} {
  if (c.authMethod === "password") {
    // tryKeyboard: many clusters only enable keyboard-interactive; the
    // 'keyboard-interactive' handler (attached in ensureClient) answers every
    // prompt with the stored password.
    return { password: c.password ?? "", tryKeyboard: true };
  }
  if (c.authMethod === "key") {
    const frag: { privateKey?: string; passphrase?: string } = {};
    if (c.privateKeyPath) {
      try {
        frag.privateKey = readFileSync(c.privateKeyPath, "utf8");
      } catch {
        // Unreadable key — let ssh2 surface the honest auth error instead.
        frag.privateKey = "";
      }
    }
    if (c.passphrase) frag.passphrase = c.passphrase;
    return frag;
  }
  // agent auth — the OpenSSH agent socket from the environment.
  const sock = process.env.SSH_AUTH_SOCK;
  return sock ? { agent: sock } : {};
}

function ensureClient(c: ClusterConnection): PooledClient {
  const existing = pool.get(c.id);
  if (existing) return existing;

  const client = new Client();
  const pooled: PooledClient = {
    client,
    ready: Promise.resolve(),
    queueTail: Promise.resolve(),
    lastError: null,
  };

  if (c.authMethod === "password") {
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => c.password ?? ""));
    });
  }

  pooled.ready = new Promise<void>((resolve) => {
    client.once("ready", () => resolve());
    client.once("error", (err: Error) => {
      pooled.lastError = err.message;
      resolve();
    });
    client.once("close", () => {
      // Socket gone (network blip / server restart) — evict so the next exec
      // reconnects with fresh credentials.
      if (pool.get(c.id) === pooled) pool.delete(c.id);
      resolve();
    });
  });

  try {
    const config: ConnectConfig = {
      host: c.host,
      port: c.port || 22,
      username: c.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      ...authConfig(c),
    };
    client.connect(config);
  } catch (e) {
    pooled.lastError = `connect failed: ${(e as Error).message}`;
  }

  pool.set(c.id, pooled);
  return pooled;
}

// ── Exec (serialized queue) ─────────────────────────────────────────────────

/** Raw exec — Buffer payloads (binary-safe); internal workhorse used by
 *  remoteDownload and the reconcile sweep (log tails must survive binary
 *  content in run.out). */
export function execRaw(
  c: ClusterConnection,
  command: string,
  opts: ExecOptions = {},
): Promise<RawExecResult> {
  let pooled: PooledClient;
  try {
    pooled = ensureClient(c);
  } catch (e) {
    return Promise.resolve({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      error: `ssh setup failed: ${(e as Error).message}`,
    });
  }

  const run = () => runOne(pooled, command, opts);
  // Join the serialized queue; runOne never rejects, but keep the chain alive
  // regardless so one bad command can't poison the connection.
  const next = pooled.queueTail.then(run, run);
  pooled.queueTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function runOne(
  pooled: PooledClient,
  command: string,
  opts: ExecOptions,
): Promise<RawExecResult> {
  await pooled.ready;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  return new Promise<RawExecResult>((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let streamRef: ClientChannel | null = null;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        error,
      });
    };

    const timer = setTimeout(() => {
      try { streamRef?.close(); } catch { /* already gone */ }
      try { streamRef?.signal("KILL"); } catch { /* already gone */ }
      finish("timeout");
    }, timeoutMs);

    try {
      pooled.client.exec(command, (err, stream) => {
        if (err) {
          finish(pooled.lastError ? `${err.message} (last error: ${pooled.lastError})` : err.message);
          return;
        }
        streamRef = stream;

        if (opts.stdin && opts.stdin.length > 0) {
          // ssh2 + Bun EOF quirk: ending the stream in the same tick as the
          // write can truncate stdin — write, then end after drain.
          stream.write(opts.stdin, () => {
            setImmediate(() => {
              try { stream.end(); } catch { /* channel already closed */ }
            });
          });
        } else {
          stream.end();
        }

        stream.on("data", (d: Buffer) => { stdoutChunks.push(d); });
        stream.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });
        stream.on("exit", (code: number | null) => {
          exitCode = code;
          // Trailing-data grace: 'close' flushes the last chunks; fall back to
          // a short timer in case close never arrives.
          graceTimer = setTimeout(() => finish(), 400);
        });
        stream.on("close", () => finish());
        stream.on("error", (e: Error) => finish(e.message));
      });
    } catch (e) {
      finish(`exec failed: ${(e as Error).message}`);
    }
  });
}

/** Public exec — string payloads; NEVER throws. */
export async function exec(
  c: ClusterConnection,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const r = await execRaw(c, command, opts);
    return {
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      exitCode: r.exitCode,
      error: r.error,
    };
  } catch (e) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      error: `ssh exec crashed: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

// ── Pool management ─────────────────────────────────────────────────────────

/** Evict + end the pooled client (called when a connection's config changes). */
export function dropConnection(connectionId: string): void {
  const pooled = pool.get(connectionId);
  if (!pooled) return;
  pool.delete(connectionId);
  try { pooled.client.end(); } catch { /* already dead */ }
}

/** Cheap liveness check — `echo FL_OK` through a real exec. */
export async function connectionWorks(c: ClusterConnection): Promise<boolean> {
  const res = await exec(c, "echo FL_OK", { timeoutMs: CONNECT_TIMEOUT_MS + 5_000 });
  return !res.error && res.stdout.includes("FL_OK");
}

// ── Shell helpers ───────────────────────────────────────────────────────────

/** Single-quote a shell argument ('…', with any ' escaped as '\''). */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Expand a leading `~` against a known cluster home dir. Connection paths
 *  may start with `~` — quoting would defeat remote tilde expansion, so we
 *  resolve to an absolute path BEFORE quoting (the home dir is read from the
 *  cluster itself at dispatch/probe time). */
export function expandTilde(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

// ── File transfer over exec ─────────────────────────────────────────────────

/** `mkdir -p` a remote directory. */
export async function remoteMkdir(c: ClusterConnection, dir: string): Promise<ExecResult> {
  return exec(c, `mkdir -p ${shQuote(dir)}`, { timeoutMs: 20_000 });
}

export interface TransferResult {
  ok: boolean;
  bytes: number;
  error?: string;
}

/** Upload bytes to a remote path: `mkdir -p` the parent, stream the payload
 *  into `head -c N > path`, then verify the on-disk size with a stat. */
export async function remoteUpload(
  c: ClusterConnection,
  data: Buffer | string,
  remotePath: string,
): Promise<TransferResult> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (buf.length === 0) return { ok: false, bytes: 0, error: "empty upload" };
  const slash = remotePath.lastIndexOf("/");
  const parent = slash > 0 ? remotePath.slice(0, slash) : ".";
  const mk = await remoteMkdir(c, parent);
  if (mk.error) return { ok: false, bytes: 0, error: `mkdir failed: ${mk.error}` };

  const timeoutMs = Math.max(30_000, Math.ceil(buf.length / BYTES_PER_SEC_FLOOR) * 1000);
  const res = await execRaw(c, `head -c ${buf.length} > ${shQuote(remotePath)}`, {
    timeoutMs,
    stdin: buf,
  });
  if (res.error) return { ok: false, bytes: 0, error: res.error };

  // Size verification (also covers servers that never deliver an exit code).
  const verify = await exec(c, `stat -c '%s' ${shQuote(remotePath)} 2>/dev/null`, { timeoutMs: 15_000 });
  const got = parseInt(verify.stdout.trim(), 10);
  if (!Number.isFinite(got) || got !== buf.length) {
    return {
      ok: false,
      bytes: 0,
      error: `upload size mismatch: expected ${buf.length} bytes, remote has ${Number.isFinite(got) ? got : "?"}`,
    };
  }
  return { ok: true, bytes: buf.length };
}

/** Download a remote file to a local path. Pre-stats the size (integrity
 *  check + maxBytes cap), cats it into memory, writes once, and verifies the
 *  byte count. Returns the byte count, or null on any failure. */
export async function remoteDownload(
  c: ClusterConnection,
  remotePath: string,
  localPath: string,
  maxBytes: number,
): Promise<number | null> {
  const st = await exec(c, `stat -c '%s' ${shQuote(remotePath)} 2>/dev/null`, { timeoutMs: 15_000 });
  if (st.error || st.exitCode !== 0) return null;
  const expected = parseInt(st.stdout.trim(), 10);
  if (!Number.isFinite(expected) || expected < 0) return null;
  if (expected > maxBytes) return null;

  const timeoutMs = Math.max(30_000, Math.ceil(expected / BYTES_PER_SEC_FLOOR) * 1000);
  const res = await execRaw(c, `cat ${shQuote(remotePath)}`, { timeoutMs });
  if (res.error) return null;
  if (res.stdout.length !== expected) return null; // byte-count verification
  try {
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, res.stdout);
  } catch {
    return null;
  }
  return res.stdout.length;
}
