// Cluster execution layer — types & DTO contracts.
//
// Design mirrors cryoflow's remote-RELION lane:
//   - ssh2 exec-only transport (no SFTP), per-connection client pool with a
//     serialized command queue (clusters dislike concurrent exec storms)
//   - filesystem-as-protocol liveness: `.cf-pid` (pid + /proc starttime),
//     `.cf-exit` (exit code), `run.out` / `run.err` logs in the remote workdir
//   - two submission doors: DIRECT (setsid nohup wrapper) and SLURM (generated
//     #SBATCH script submitted via sbatch)
//   - one batched SSH round trip per connection per poll tick carries state +
//     log tails for ALL running jobs of that connection
//   - run records in a JSON state file (data/cluster-runs.json); the ToolJob
//     DB row is the user-facing projection
//
// Connections live in data/cluster-connections.json (0600) — secrets never
// leave the server: DTOs expose hasPassword / hasPassphrase booleans only.

export type ClusterAuthMethod = "password" | "key" | "agent";
export type ClusterSubmitMode = "direct" | "slurm";

// ── Connection ──────────────────────────────────────────────────────────────

export interface ClusterConnection {
  id: string;
  name: string;
  host: string;
  port: number; // default 22
  username: string;
  authMethod: ClusterAuthMethod;
  /** Path to a private key file ON THE APP HOST (authMethod "key"). */
  privateKeyPath: string | null;
  /** Passphrase for the private key (secret). */
  passphrase: string | null;
  /** Password (secret; authMethod "password"). */
  password: string | null;
  /** Cluster-side root for Foundry Lab job dirs. Default "~/foundry-lab". */
  remoteRoot: string;
  /** Cluster-side directory where external tool repos live (ProteinMPNN …).
   *  Local script paths "external-tools/<X>" are rewritten to
   *  "<remoteToolsDir>/<X>". Default "~/foundry-lab/tools". */
  remoteToolsDir: string;
  /** Extra shell lines sourced before every run (module load / conda activate). */
  envLines: string[];
  /** Default submission mode for runs. */
  useSlurm: boolean;
  slurmPartition: string | null;
  /** Explicit walltime minutes; null = cluster default. */
  slurmTimeMin: number | null;
  createdAt: string;
  updatedAt: string;
  lastProbe: ClusterProbe | null;
}

export interface ClusterConnectionDTO {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: ClusterAuthMethod;
  privateKeyPath: string | null;
  hasPassphrase: boolean;
  hasPassword: boolean;
  remoteRoot: string;
  remoteToolsDir: string;
  envLines: string[];
  useSlurm: boolean;
  slurmPartition: string | null;
  slurmTimeMin: number | null;
  createdAt: string;
  updatedAt: string;
  lastProbe: ClusterProbeDTO | null;
}

// ── Probe ───────────────────────────────────────────────────────────────────

export interface ClusterToolProbe {
  key: string;
  label: string;
  installed: boolean;
  /** How it was detected: "path" | "module" | "command" | "dir". */
  via: string;
  detail: string;
}

export interface ClusterProbe {
  ok: boolean;
  error?: string;
  testedAt: string;
  durationMs: number;
  uname: string;
  hostname: string;
  user: string;
  homeDir: string;
  dateEpoch: number;
  python3: { ok: boolean; version: string; numpy: boolean } | null;
  conda: { ok: boolean; root: string } | null;
  moduleSystem: "lmod" | "envmodules" | "none";
  tools: ClusterToolProbe[];
  slurm: {
    available: boolean;
    partitions: ClusterPartition[];
  };
  gpus: { model: string; count: number }[];
}

export interface ClusterPartition {
  name: string;
  nodes: number;
  gpusPerNode: number;
  state: string;
  maxTime: string;
}

// Intentionally empty extension (DTO ≡ domain shape; kept as an interface so
// future DTO-only projections stay non-breaking).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClusterProbeDTO extends ClusterProbe {}

// ── Run target & run state ──────────────────────────────────────────────────

/** Where + how a tool run should execute. Sent by the UI with POST
 *  /api/tools/run body.cluster, or threaded through the workflow engine. */
export interface ClusterRunTarget {
  connectionId: string;
  mode: ClusterSubmitMode;
  partition?: string | null;
  /** SLURM GPUs per node (--gres=gpu:N). Default 1. */
  gpus?: number;
  /** SLURM tasks (--ntasks). Default 1. */
  ntasks?: number;
  /** SLURM cpus per task. Default 4. */
  cpusPerTask?: number;
  /** Walltime minutes. Connection default when omitted. */
  timeLimitMin?: number | null;
}

export type ClusterRunPhase =
  | "staging"
  | "running"
  | "syncing"
  | "done"
  | "failed"
  | "cancelled";

/** Full orchestration record for one cluster-dispatched tool run
 *  (data/cluster-runs.json, keyed by ToolJob id). */
export interface ClusterRunState {
  jobId: string;
  toolKey: string;
  connectionId: string;
  connectionName: string;
  host: string;
  user: string;
  mode: ClusterSubmitMode;
  remoteRoot: string;
  remoteWorkdir: string;
  /** Local absolute dir (outputs/<toolKey>/<jobId>) inputs are staged from
   *  and outputs sync back into. Optional for older records — absent falls
   *  back to resolve(cwd, "outputs", toolKey, jobId). */
  localWorkDir?: string;
  /** pid of the setsid'd process group leader (direct mode). */
  pid: number | null;
  /** /proc/<pid>/stat starttime — recycled-pid protection (direct mode). */
  pidStart: number | null;
  slurmId: string | null;
  slurmState: string | null;
  phase: ClusterRunPhase;
  /** Cluster clock at dispatch (fence against stale .cf-exit verdicts). */
  fenceEpoch: number;
  dispatchedAtEpoch: number;
  command: string;
  scriptPath: string;
  stagedFiles: string[];
  syncedFiles: string[];
  syncedBytes: number;
  logTailOut: string;
  logTailErr: string;
  logTotalLines: number;
  logTailAt: number;
  slurmElapsedMs: number | null;
  error: string | null;
  finishedAt: string | null;
  /** Consecutive VANISHED verdicts (wire-blink protection). */
  vanishedStreak: number;
}

/** User-facing projection merged into ToolJobDTO as `job.cluster`. */
export interface ClusterJobInfoDTO {
  connectionId: string;
  connectionName: string;
  host: string;
  user: string;
  mode: ClusterSubmitMode;
  phase: ClusterRunPhase;
  slurmId: string | null;
  slurmState: string | null;
  pid: number | null;
  remoteWorkdir: string;
  command: string;
  logTailOut: string;
  logTailErr: string;
  syncedFiles: string[];
  syncedBytes: number;
  error: string | null;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export function toClusterConnectionDTO(c: ClusterConnection): ClusterConnectionDTO {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authMethod: c.authMethod,
    privateKeyPath: c.privateKeyPath,
    hasPassphrase: !!c.passphrase,
    hasPassword: !!c.password,
    remoteRoot: c.remoteRoot,
    remoteToolsDir: c.remoteToolsDir,
    envLines: c.envLines,
    useSlurm: c.useSlurm,
    slurmPartition: c.slurmPartition,
    slurmTimeMin: c.slurmTimeMin,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastProbe: c.lastProbe ?? null,
  };
}
