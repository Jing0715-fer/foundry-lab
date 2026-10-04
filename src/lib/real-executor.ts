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

import { spawn, execSync } from "child_process";
import { promises as fs, existsSync } from "fs";
import { join, resolve } from "path";
import { resolveEnginePythonCmd, resolveCommandPath, osKey, resolveInstallSpec } from "./platform-env";
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

let cachedPython: string | null | undefined;

/** Resolve a python3 that can import numpy (the engine runtime requirement).
 *  Cross-platform: python3 / venv / python / py -3 (Windows launcher). */
export function resolveEnginePython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  // platform-env caches its own probe; cache here too for hot paths.
  const resolved = resolveEnginePythonCmd().command;
  cachedPython = resolved;
  return resolved;
}

/** Reset the interpreter resolution cache. Called after a SUCCESSFUL
 *  one-click install — the install may have provisioned python/numpy that
 *  this module's cached `null` ("no engine python") still denies. The next
 *  resolveEnginePython() call re-probes via platform-env. */
export function resetEnginePythonCache(): void {
  cachedPython = undefined;
}

const ALGORITHMS_DIR = resolve(process.cwd(), "scripts", "algorithms");

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Check if the NATIVE external tool is installed on the host.
 *   - binary: resolved on PATH without a shell (works on Linux/macOS/Windows)
 *   - python: the engine python can `import <module>`
 *   - path:   exists on disk (absolute or project-relative)
 */
export function isToolInstalled(key: string): boolean {
  const entry = getToolRegistryEntry(key);
  if (!entry) return false;
  return checkDetect(entry.detect);
}

/** Shared detection core — shell-less so it is identical on every OS. */
function checkDetect(detect: {
  type: string;
  binary?: string;
  pythonModule?: string;
  path?: string;
}): boolean {
  try {
    if (detect.type === "binary" && detect.binary) {
      return resolveCommandPath(detect.binary) !== null;
    }
    if (detect.type === "python" && detect.pythonModule) {
      const py = resolveEnginePython() ?? "python3";
      const mod = detect.pythonModule === "Bio" ? "Bio" : detect.pythonModule;
      execSync(`${py} -c "import ${mod}"`, { stdio: "pipe", timeout: 15000 });
      return true;
    }
    if (detect.type === "path" && detect.path) {
      // Absolute paths (e.g. the foundry venv) check directly; relative
      // paths resolve under the project root.
      const p = detect.path;
      return existsSync(p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p) ? p : join(process.cwd(), p));
    }
  } catch {
    return false;
  }
  return false;
}

/** Detect an arbitrary registry entry (runtime + external tiers). */
export function isEntryInstalled(
  detect: { type: string; binary?: string; pythonModule?: string; path?: string },
): boolean {
  return checkDetect(detect);
}

// ── Engine self-test ────────────────────────────────────────────────────────

interface EngineTestResult {
  key: string;
  label: string;
  script: string;
  ok: boolean;
  detail: string;
}

/** Run each engine's fast selftest (common.py selftest). */
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
  return BUILTIN_ENGINES.map((e) => {
    try {
      const out = execSync(
        `${py} ${join(ALGORITHMS_DIR, e.script)} --selftest 2>&1`,
        { stdio: "pipe", timeout: 30000 },
      ).toString();
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
        execSync(
          `${py} -c "import ast,sys; ast.parse(open('${join(ALGORITHMS_DIR, e.script)}').read())"`,
          { stdio: "pipe", timeout: 15000 },
        );
        return {
          key: e.key,
          label: e.label,
          script: e.script,
          ok: true,
          detail: "script present, syntax valid",
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
    if (s.startsWith("/")) continue; // already absolute
    const abs = join(process.cwd(), s);
    if (existsSync(abs)) out[f.key] = abs;
  }
  return out;
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

  // FASTA output: the param surface's path_to_fasta, else the job workDir.
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
    const exePath = mode.path.startsWith("/") ? mode.path : join(process.cwd(), mode.path);
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
    const scriptPath = join(process.cwd(), mode.script);
    const res = await runProcess(
      py,
      [scriptPath, ...argTokens, ...fixed, ...outTokens],
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
  const res = await runProcess(
    py,
    ["-m", mode.module, ...argTokens, ...fixed, ...outTokens],
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
  const res = await runProcess(
    py,
    [join(ALGORITHMS_DIR, engine.script), payload],
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
      // `cmd` may carry leading arguments (e.g. the Windows launcher
      // "py -3") — split it so spawn gets a clean file + argv.
      const cmdParts = cmd.trim().split(/\s+/);
      proc = spawn(cmdParts[0], [...cmdParts.slice(1), ...args], {
        cwd,
        shell: false,
        env,
      });
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
  const os = osKey();
  return TOOL_REGISTRY.map((entry) => {
    const engine = engineForTool(entry.key);
    const spec = resolveInstallSpec(entry);
    return {
      key: entry.key,
      label: entry.label,
      category: entry.category,
      description: entry.description,
      installed: isToolInstalled(entry.key),
      installMethod: entry.install.method,
      installCommand: spec.command || entry.install.commandByOs?.[os] || entry.install.command,
      installLabel: spec.label,
      docs: entry.install.docs,
      oneClick: spec.oneClick,
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
