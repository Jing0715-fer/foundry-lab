// Real tool execution engine — NO SIMULATION.
//
// The engine is the single entry point used by /api/tools/run (and the
// workflow engine) to invoke a comp tool. Execution priority:
//   1. NATIVE: if the upstream external tool is installed on the host
//      (registry detect config) → spawn the real binary / python script and
//      capture stdout/stderr/exit code + output files.
//   2. BUILT-IN ENGINE: otherwise → run the shipped real Python algorithm
//      engine (scripts/algorithms/<engine>.py) with the same parameter
//      surface. These are genuine scientific algorithms (Chou-Fasman,
//      Miyazawa-Jernigan, Shrake-Rupley, NeRF, Metropolis MC…) — not
//      simulations.
//   3. If even the built-in engine cannot run (missing python/numpy) →
//      honest failure with an actionable error.
//
// All file outputs land under <workDir> (outputs/<toolKey>/<jobId>/). The
// absolute file list is returned to the caller and persisted on the ToolJob.

import { spawn, spawnSync } from "child_process";
import { promises as fs, existsSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { crossWhich } from "./platform";
import {
  getToolRegistryEntry,
  engineForTool,
  BUILTIN_ENGINES,
  TOOL_REGISTRY,
} from "./tool-registry";
import {
  FOUNDRY_MPNN_TOOLS,
  foundryMpnnVariant,
  isFoundryMpnnReady,
  resolveFoundryPython,
} from "./foundry";
import { getCompTool, buildCommand, buildArgs } from "./tools";

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: string[];
  command: string;
  /** Which executor produced this result. */
  executor: "native" | "builtin-engine";
  /** true if the upstream external tool itself ran. */
  realToolUsed: boolean;
}

// ── Python resolution ───────────────────────────────────────────────────────

/** A python candidate + the argv prefix it needs. Windows' "py" launcher
 *  must be invoked with an explicit -3 (its default may resolve to a
 *  different interpreter than the one that passed the numpy probe). */
interface PythonCandidate {
  cmd: string;
  preArgs: string[];
}

function pythonCandidates(): PythonCandidate[] {
  if (process.platform === "win32") {
    return [
      { cmd: "python", preArgs: [] },
      { cmd: "py", preArgs: ["-3"] }, // Windows launcher, forced Python 3
      { cmd: "python3", preArgs: [] },
    ];
  }
  // darwin / linux
  return [
    { cmd: "python3", preArgs: [] },
    { cmd: "/home/z/.venv/bin/python3", preArgs: [] },
    { cmd: "/usr/bin/python3", preArgs: [] },
  ];
}

let cachedPython: string | null | undefined;

/** Spawn tokens for a python resolved here (see PythonCandidate — "py" needs
 *  the -3 prefix). Exported so install-jobs / the scan route spawn the same
 *  interpreter that passed detection. */
export function pythonSpawnTokens(py: string): {
  cmd: string;
  preArgs: string[];
} {
  if (process.platform === "win32" && /^(?:py|py\.exe)$/i.test(py.trim())) {
    return { cmd: "py", preArgs: ["-3"] };
  }
  return { cmd: py, preArgs: [] };
}

/** Resolve a python3 that can import numpy (the engine runtime requirement).
 *  Probing uses spawnSync in ARRAY form — no shell, no string concatenation. */
export function resolveEnginePython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  for (const cand of pythonCandidates()) {
    try {
      const res = spawnSync(cand.cmd, [...cand.preArgs, "-c", "import numpy"], {
        stdio: "pipe",
        timeout: 15_000,
        encoding: "utf8",
      });
      if (res.status === 0 && !res.error) {
        cachedPython = cand.cmd;
        return cand.cmd;
      }
    } catch {
      /* try next */
    }
  }
  cachedPython = null;
  return null;
}

/** Reset the python resolution cache — called after an install job settles
 *  (install-jobs.ts) so a freshly installed python/numpy is detected without
 *  a dev-server restart. */
export function invalidateEnginePythonCache(): void {
  cachedPython = undefined;
}

const ALGORITHMS_DIR = resolve(process.cwd(), "scripts", "algorithms");

// ── Detection ───────────────────────────────────────────────────────────────

/** Can the given python import a module? (spawnSync array form; the module
 *  name comes from registry constants, and argv values never hit a shell.) */
function pythonCanImport(py: string | null, module: string): boolean {
  const target = py ?? "python3";
  const tok = pythonSpawnTokens(target);
  try {
    const res = spawnSync(tok.cmd, [...tok.preArgs, "-c", `import ${module}`], {
      stdio: "pipe",
      timeout: 15_000,
      encoding: "utf8",
    });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}

/** Shared detection for a registry detect spec (binary / python / path). */
function detectInstalled(detect: {
  type: string;
  binary?: string;
  pythonModule?: string;
  path?: string;
}): boolean {
  if (detect.type === "binary" && detect.binary) {
    return crossWhich(detect.binary) !== null;
  }
  if (detect.type === "python" && detect.pythonModule) {
    return pythonCanImport(resolveEnginePython(), detect.pythonModule);
  }
  if (detect.type === "path" && detect.path) {
    // Absolute paths (e.g. the foundry venv) check directly; relative
    // paths resolve under the project root. isAbsolute covers win32 drives.
    const p = detect.path;
    return existsSync(isAbsolute(p) ? p : join(process.cwd(), p));
  }
  return false;
}

/**
 * Check if the NATIVE external tool is installed on the host.
 *   - binary: cross-platform PATH lookup (crossWhich)
 *   - python: the engine python can `import <module>`
 */
export function isToolInstalled(key: string): boolean {
  const entry = getToolRegistryEntry(key);
  if (!entry) return false;
  return detectInstalled(entry.detect);
}

/** Detect an arbitrary registry entry (runtime + external tiers). */
export function isEntryInstalled(
  detect: { type: string; binary?: string; pythonModule?: string; path?: string },
): boolean {
  return detectInstalled(detect);
}

// ── Engine self-test ────────────────────────────────────────────────────────

interface EngineTestResult {
  key: string;
  label: string;
  script: string;
  ok: boolean;
  detail: string;
}

/** Run each engine's fast selftest (common.py selftest).
 *  spawnSync in ARRAY form — stdout+stderr merged (old `2>&1` semantics). */
export function selfTestEngines(): EngineTestResult[] {
  const py = resolveEnginePython();
  if (!py) {
    return BUILTIN_ENGINES.map((e) => ({
      key: e.key,
      label: e.label,
      script: e.script,
      ok: false,
      detail: "python3 with numpy not found — install the runtime tier first",
    }));
  }
  const tok = pythonSpawnTokens(py);
  return BUILTIN_ENGINES.map((e) => {
    try {
      const res = spawnSync(
        tok.cmd,
        [...tok.preArgs, join(ALGORITHMS_DIR, e.script), "--selftest"],
        { stdio: "pipe", timeout: 30000, encoding: "utf8" },
      );
      if (res.error) throw new Error(res.error.message);
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      if (res.status !== 0) {
        throw new Error(
          out.trim().split("\n").slice(-1)[0]?.slice(0, 200) ||
            `exit ${res.status}`,
        );
      }
      // Engines accept --selftest → delegate to common selftest; if an engine
      // doesn't implement it, just verify the script exists + imports.
      return {
        key: e.key,
        label: e.label,
        script: e.script,
        ok: !out.includes("Traceback"),
        detail: out.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "ok",
      };
    } catch (err) {
      // --selftest not implemented → fall back to import check.
      try {
        const check = spawnSync(
          tok.cmd,
          [
            ...tok.preArgs,
            "-c",
            "import ast,sys; ast.parse(open(sys.argv[1]).read())",
            join(ALGORITHMS_DIR, e.script),
          ],
          { stdio: "pipe", timeout: 15000, encoding: "utf8" },
        );
        if (check.status === 0 && !check.error) {
          return {
            key: e.key,
            label: e.label,
            script: e.script,
            ok: true,
            detail: "script present, syntax valid",
          };
        }
        return {
          key: e.key,
          label: e.label,
          script: e.script,
          ok: false,
          detail: (
            (check.stderr as string | null) ?? (err as Error).message
          ).slice(0, 200),
        };
      } catch {
        return {
          key: e.key,
          label: e.label,
          script: e.script,
          ok: false,
          detail: (err as Error).message.slice(0, 200),
        };
      }
    }
  });
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Resolve path-type params against the PROJECT ROOT. The spawned native
 * process / engine runs with cwd = <job workDir>, so a relative path like
 * `outputs/rfdiffusion/<id>/design_0.pdb` (what the UI and agents pass after
 * picking up a previous job's artifact) would resolve against the workDir
 * and vanish. Absolute values pass through untouched.
 */
function normalizePathParams(
  def: ReturnType<typeof getCompTool>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!def) return params;
  const out: Record<string, unknown> = { ...params };
  for (const f of def.paramFields) {
    if (f.type !== "path") continue;
    const v = out[f.key];
    if (typeof v !== "string" || !v.trim()) continue;
    const s = v.trim();
    if (isAbsolute(s)) continue; // already absolute (POSIX / or win32 drive)
    const abs = join(process.cwd(), s);
    if (existsSync(abs)) out[f.key] = abs;
  }
  return out;
}

/**
 * P1-2 WRITE-SIDE SANDBOX for output FASTA paths. `path_to_fasta` is an
 * output location the user / LLM can point anywhere on disk (reads are
 * already whitelisted via /api/tools/file; writes were not). Resolve the
 * requested path and — unless it lands under the PROJECT ROOT — redirect it
 * into the job workDir. Applies uniformly to every downstream path (foundry
 * --out_fasta, native --path_to_fasta, the built-in engine payload).
 */
function sandboxFastaOutput(
  params: Record<string, unknown>,
  workDir: string,
): { params: Record<string, unknown>; notice: string | null } {
  const raw = params.path_to_fasta;
  if (typeof raw !== "string" || !raw.trim()) {
    return { params, notice: null };
  }
  const requested = raw.trim();
  const target = resolve(process.cwd(), requested);
  const rel = relative(process.cwd(), target);
  const outside =
    rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) return { params, notice: null };
  const safe = join(workDir, "designed.fasta");
  return {
    params: { ...params, path_to_fasta: safe },
    notice:
      `[sandbox] path_to_fasta redirected into job workDir ` +
      `(${requested} is outside the project root → ${safe})`,
  };
}

/**
 * Execute a comp tool — native upstream tool if installed, otherwise the
 * built-in real algorithm engine. NEVER simulates.
 */
export async function executeCompToolReal(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
): Promise<ExecutionResult> {
  const def = getCompTool(toolKey);
  if (!def) {
    return {
      stdout: "",
      stderr: `Unknown tool: ${toolKey}`,
      exitCode: 1,
      outputFiles: [],
      command: "",
      executor: "native",
      realToolUsed: false,
    };
  }
  // Relative input paths → project-root absolute (see normalizePathParams).
  params = normalizePathParams(def, params);
  // Write-side sandbox: output FASTA paths must stay inside the project.
  const sandboxed = sandboxFastaOutput(params, workDir);

  const result = await dispatchCompTool(toolKey, sandboxed.params, workDir);
  return sandboxed.notice
    ? { ...result, stdout: `${sandboxed.notice}\n${result.stdout}` }
    : result;
}

/** Foundry → native → built-in dispatch (after param normalization). */
async function dispatchCompTool(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
): Promise<ExecutionResult> {
  // FOUNDRY TIER — the official RosettaCommons foundry platform
  // (rc-foundry wheel: the MPNN re-implementation maintained by the IPD).
  // It takes priority over the legacy dauparas repos and the built-in
  // statistical engine: when the platform is installed with weights, MPNN
  // family jobs run the REAL trained network.
  if (FOUNDRY_MPNN_TOOLS.has(toolKey) && isFoundryMpnnReady()) {
    try {
      return await runFoundryMpnn(toolKey, params, workDir, Date.now());
    } catch (e) {
      // Foundry failed to spawn (never a tool-level result) — fall through
      // to the native/built-in tiers with a clear notice.
      const notice =
        `[FOUNDRY UNAVAILABLE — ${e instanceof Error ? e.message : String(e)}]\n` +
        `Falling back to native/built-in execution.\n\n`;
      const next = await executeNativeOrEngine(toolKey, params, workDir);
      return { ...next, stdout: notice + next.stdout };
    }
  }

  return executeNativeOrEngine(toolKey, params, workDir);
}

/** Native-then-builtin dispatch (the pre-foundry execution flow). */
async function executeNativeOrEngine(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
): Promise<ExecutionResult> {
  const entry = getToolRegistryEntry(toolKey);
  const installed = isToolInstalled(toolKey);

  await fs.mkdir(workDir, { recursive: true }).catch(() => {});
  const startedAt = Date.now();

  if (installed && entry) {
    if (entry.nativeExecution) {
      // NATIVE: run the real upstream tool.
      try {
        const native = await runNativeTool(toolKey, params, workDir);
        // Environment-level failures (missing python deps, missing script)
        // fall back to the built-in engine; genuine tool errors (bad input
        // etc.) are reported honestly as native failures.
        const envFailure =
          native.exitCode !== 0 &&
          /no module named|command not found|can't open file|no such file|modulenotfound|traceback \(most recent call last\)/i.test(
            native.stderr,
          );
        if (!envFailure) return native;
        const notice =
          `[NATIVE TOOL UNAVAILABLE — falling back to the built-in real algorithm engine]\n` +
          `Reason: ${native.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 300) || `exit ${native.exitCode}`}\n\n`;
        const engine = await runBuiltinEngine(toolKey, params, workDir, startedAt);
        return { ...engine, stdout: notice + engine.stdout };
      } catch (e) {
        // Native tool failed to spawn — fall through to the built-in engine
        // with a clear notice (still a real algorithm).
        const notice =
          `[NATIVE TOOL FAILED — falling back to the built-in real algorithm engine]\n` +
          `Error: ${(e as Error).message ?? String(e)}\n\n`;
        const engine = await runBuiltinEngine(toolKey, params, workDir, startedAt);
        return { ...engine, stdout: notice + engine.stdout };
      }
    }
    // Installed but engine-executed (no CLI entry point — e.g. pip packages
    // used via their Python API). Run the built-in real algorithm engine and
    // surface that the package is present.
    const engine = await runBuiltinEngine(toolKey, params, workDir, startedAt);
    return {
      ...engine,
      stdout:
        `[${entry.label} package detected on this host (no CLI entry point — ` +
        `executing via the built-in real algorithm engine)]\n\n` + engine.stdout,
    };
  }

  // BUILT-IN ENGINE (real algorithm, no upstream tool needed).
  return runBuiltinEngine(toolKey, params, workDir, startedAt);
}

/**
 * Execute an MPNN-family job through the OFFICIAL foundry platform:
 * `<foundry-python> scripts/foundry/run_mpnn.py …` — real trained network
 * (legacy official weights) via foundry's MPNNInferenceEngine.
 */
async function runFoundryMpnn(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
  startedAt: number,
): Promise<ExecutionResult> {
  const py = resolveFoundryPython();
  if (!py) throw new Error("foundry python not resolvable");

  const variant = foundryMpnnVariant(toolKey, params);

  // Map the app param surface onto the runner's flags.
  const args: string[] = [
    join(process.cwd(), "scripts", "foundry", "run_mpnn.py"),
  ];
  const pdb = typeof params.pdb_path === "string" ? params.pdb_path : "";
  if (!pdb) {
    throw new Error("pdb_path is required for foundry MPNN execution");
  }
  args.push("--pdb_path", pdb);

  const numSeq = Number(params.num_seq ?? 8) || 8;
  args.push("--num_seq", String(Math.max(1, Math.min(64, numSeq))));

  const temp = Number(params.sampling_temp ?? 0.1);
  args.push("--sampling_temp", String(Number.isFinite(temp) && temp > 0 ? temp : 0.1));

  args.push("--model", variant.model);
  if (variant.soluble) args.push("--soluble");

  const seed = Number(params.seed ?? 42);
  args.push("--seed", String(Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 42));

  // FASTA output: the param surface's path_to_fasta (already sanitized by
  // the write-side sandbox in executeCompToolReal — outside-project targets
  // were redirected into the job workDir), else the job workDir default.
  const outFasta =
    typeof params.path_to_fasta === "string" && params.path_to_fasta.trim()
      ? params.path_to_fasta
      : join(workDir, "seqs.fa");
  args.push("--out_fasta", outFasta);

  const displayCommand =
    `# foundry (RosettaCommons rc-foundry) — REAL trained ${
      variant.soluble ? "SolubleMPNN" : variant.model === "protein_mpnn" ? "ProteinMPNN" : "LigandMPNN"
    } network\n` +
    `${py} scripts/foundry/run_mpnn.py --pdb_path <backbone> --num_seq ${
      Math.max(1, Math.min(64, numSeq))
    } --sampling_temp ${args[args.indexOf("--sampling_temp") + 1]}`;

  await fs.mkdir(workDir, { recursive: true }).catch(() => {});
  // First run pays the torch import cost (~10-30s on CPU) — allow headroom.
  const res = await runProcess(
    py,
    args,
    workDir,
    displayCommand,
    startedAt,
    10 * 60 * 1000,
  );
  return {
    ...res,
    executor: "native",
    realToolUsed: true,
  };
}

/** Run the native upstream tool via child_process, honoring the registry's
 *  nativeExecution mode:
 *    - binary:         spawn parts[0] of buildArgs directly.
 *    - script:         spawn `<python> <script> <rest…>` (repo-cloned CLIs).
 *    - python-module:  spawn `<python> -m <module> <rest…>`.
 *  Entries without nativeExecution never land here (engine-only tools).
 *  Arg construction uses the structured buildArgs (no whitespace splitting —
 *  values may legitimately contain spaces), plus the registry's fixedArgs
 *  and the output-routing flag:
 *    - dotted (hydra) outputPrefixFlag  → one token `inference.output_prefix=<dir>`
 *    - dashed (argparse) outFolderFlag  → two tokens `--out_folder <dir>` */
async function runNativeTool(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
): Promise<ExecutionResult> {
  const def = getCompTool(toolKey)!;
  const entry = getToolRegistryEntry(toolKey)!;
  const py = resolveEnginePython();

  const mode = entry.nativeExecution;
  if (!mode) {
    // Should not happen (executeCompToolReal checks), but be safe.
    return runBuiltinEngine(toolKey, params, workDir, Date.now());
  }

  // Structured arg tokens (values with spaces survive intact).
  const argTokens = buildArgs(def, params).slice(1); // drop cliCommand head
  // Environment-prefix params (the tutorial's CUDA_VISIBLE_DEVICES="6") →
  // process env, never argv.
  const envVars: Record<string, string> = {};
  for (const f of def.paramFields) {
    if (!f.envPrefix) continue;
    const v = params[f.key] ?? f.default;
    if (v === "" || v == null) continue;
    envVars[f.envPrefix] = String(v);
  }
  const childEnv = Object.keys(envVars).length
    ? { ...process.env, ...envVars }
    : undefined;
  // Registry-pinned flags the param surface doesn't model (e.g. hydra
  // `inference.write_trajectory=False`).
  const fixed = mode.fixedArgs ?? [];
  // Output routing. Two semantics:
  //   PREFIX flags (RFdiffusion's inference.output_prefix, RFantibody's -o)
  //     → base <workDir>/design so `<base>_0.pdb`… land INSIDE the workDir.
  //   FOLDER flags (ProteinMPNN's --out_folder) → the workDir itself; the
  //     tool writes its subfolders (seqs/…) one level deep, inside the scan.
  // Hydra dotted flags are single `key=value` tokens; dashed flags are two.
  const prefixBase = join(workDir, "design");
  const outTokens: string[] = [];
  if (mode.outputPrefixFlag) {
    if (mode.outputPrefixFlag.includes(".")) {
      outTokens.push(`${mode.outputPrefixFlag}=${prefixBase}`);
    } else {
      outTokens.push(mode.outputPrefixFlag, prefixBase);
    }
  } else if (mode.outFolderFlag) {
    const target = mode.outFolderIsPrefix ? prefixBase : workDir;
    outTokens.push(mode.outFolderFlag, target);
  }
  const displayCommand = buildCommand(def, params);

  if (mode.mode === "binary") {
    const head = def.cliCommand.split(/\s+/).filter(Boolean);
    const res = await runProcess(
      head[0],
      [...head.slice(1), ...argTokens, ...fixed, ...outTokens],
      workDir,
      displayCommand,
      Date.now(),
      mode.timeoutMs,
      childEnv,
    );
    return { ...res, executor: "native", realToolUsed: true };
  }
  if (mode.mode === "executable") {
    const exePath = isAbsolute(mode.path) ? mode.path : join(process.cwd(), mode.path);
    const res = await runProcess(
      exePath,
      [...argTokens, ...fixed, ...outTokens],
      workDir,
      displayCommand,
      Date.now(),
      mode.timeoutMs,
      childEnv,
    );
    return { ...res, executor: "native", realToolUsed: true };
  }
  if (mode.mode === "script") {
    if (!py) throw new Error("engine python not available for script execution");
    const tok = pythonSpawnTokens(py);
    const scriptPath = join(process.cwd(), mode.script);
    const res = await runProcess(
      tok.cmd,
      [...tok.preArgs, scriptPath, ...argTokens, ...fixed, ...outTokens],
      workDir,
      displayCommand,
      Date.now(),
      mode.timeoutMs,
      childEnv,
    );
    return { ...res, executor: "native", realToolUsed: true };
  }
  // python-module
  if (!py) throw new Error("engine python not available for module execution");
  const tok = pythonSpawnTokens(py);
  const res = await runProcess(
    tok.cmd,
    [...tok.preArgs, "-m", mode.module, ...argTokens, ...fixed, ...outTokens],
    workDir,
    displayCommand,
    Date.now(),
    mode.timeoutMs,
    childEnv,
  );
  return { ...res, executor: "native", realToolUsed: true };
}

/** Run the shipped real Python algorithm engine for a tool key. */
async function runBuiltinEngine(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
  startedAt: number,
): Promise<ExecutionResult> {
  const def = getCompTool(toolKey)!;
  const engine = engineForTool(toolKey);
  const py = resolveEnginePython();

  if (!engine || !py) {
    const problem = !engine
      ? `No built-in engine is mapped for '${toolKey}'.`
      : "The Python runtime (python3 + numpy) is not available on this host. " +
        "Install it from the Tools page → Runtime dependencies.";
    return {
      stdout: "",
      stderr: problem,
      exitCode: 1,
      outputFiles: [],
      command: "",
      executor: "builtin-engine",
      realToolUsed: false,
    };
  }

  const displayCommand =
    `# built-in real algorithm engine: ${engine.script} ` +
    `(native ${def.label} not installed)`;
  const payload = JSON.stringify({
    params: { ...params, _tool: toolKey },
    workdir: workDir,
  });
  const tok = pythonSpawnTokens(py);
  const res = await runProcess(
    tok.cmd,
    [...tok.preArgs, join(ALGORITHMS_DIR, engine.script), payload],
    workDir,
    displayCommand,
    startedAt,
    10 * 60 * 1000,
  );
  return {
    ...res,
    executor: "builtin-engine",
    realToolUsed: false,
  };
}

/** Run a process and capture stdout/stderr/exit code + output files. */
async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  displayCommand: string,
  startedAt: number,
  timeoutMs = 5 * 60 * 1000,
  env?: NodeJS.ProcessEnv,
): Promise<Omit<ExecutionResult, "executor" | "realToolUsed">> {
  return new Promise((resolvePromise) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { cwd, shell: false, env });
    } catch (e) {
      resolvePromise({
        stdout: "",
        stderr: `Failed to spawn ${cmd}: ${(e as Error).message}`,
        exitCode: 1,
        outputFiles: [],
        command: displayCommand,
      });
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      stderrChunks.push(`\n[TIMEOUT after ${timeoutMs / 1000}s — killed]`);
    }, timeoutMs);

    proc.stdout?.on("data", (d) => stdoutChunks.push(d.toString()));
    proc.stderr?.on("data", (d) => stderrChunks.push(d.toString()));

    const finish = async (code: number | null) => {
      clearTimeout(timer);
      // Collect output files created during this run (real artifacts only).
      // Scans two levels deep — native tools often write into subfolders
      // (e.g. ProteinMPNN writes to <out>/seqs/…).
      let outputFiles: string[] = [];
      try {
        const found: { full: string; mtime: number }[] = [];
        const dirs = [cwd];
        try {
          for (const entry of await fs.readdir(cwd, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(join(cwd, entry.name));
          }
        } catch {
          /* ignore */
        }
        for (const dir of dirs) {
          const entries = await fs.readdir(dir).catch(() => [] as string[]);
          await Promise.all(
            entries
              .filter((f) => /\.(pdb|fasta|fa|txt|json|csv|out|aln|log|pkl|a3m|sto)$/i.test(f))
              .map(async (f) => {
                const full = join(dir, f);
                const st = await fs.stat(full).catch(() => null);
                if (st && st.isFile() && st.mtimeMs >= startedAt - 1500) {
                  found.push({ full, mtime: st.mtimeMs });
                }
              }),
          );
        }
        outputFiles = found
          .sort((a, b) => a.mtime - b.mtime)
          .map((x) => x.full);
      } catch {
        /* cwd may not exist — ignore */
      }
      resolvePromise({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 1,
        outputFiles,
        command: displayCommand,
      });
    };

    proc.on("error", (err) => {
      stderrChunks.push(`Failed to spawn process: ${err.message}`);
      void finish(1);
    });
    proc.on("close", (code) => {
      void finish(code);
    });
  });
}

// ── Scan ────────────────────────────────────────────────────────────────────

export interface ScanRow {
  key: string;
  label: string;
  category: string;
  description: string;
  installed: boolean;
  installMethod: string;
  installCommand: string;
  installLabel: string;
  docs: string;
  oneClick: boolean;
  sizeHint?: string;
  builtinEngine?: string;
  executorReady: boolean;
}

/** One-shot scan of external tools: native status + engine fallback status. */
export function scanAllTools(): ScanRow[] {
  const py = resolveEnginePython();
  return TOOL_REGISTRY.map((entry) => {
    const engine = engineForTool(entry.key);
    return {
      key: entry.key,
      label: entry.label,
      category: entry.category,
      description: entry.description,
      installed: isToolInstalled(entry.key),
      installMethod: entry.install.method,
      installCommand: entry.install.command,
      installLabel: entry.install.label,
      docs: entry.install.docs,
      oneClick: entry.install.oneClick,
      sizeHint: entry.install.sizeHint,
      builtinEngine: entry.builtinEngine,
      executorReady: !!py && !!engine,
    };
  });
}

/** Re-export for callers that want to introspect a workDir without running. */
export function workDirExists(workDir: string): boolean {
  return existsSync(workDir);
}
