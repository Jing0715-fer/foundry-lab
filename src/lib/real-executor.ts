// Real tool execution engine.
//
// The engine is the single entry point used by `/api/tools/run` (and the workflow
// engine) to invoke a comp tool. It:
//   1. Checks the host (via the TOOL_REGISTRY detect config) for the tool.
//   2. If installed: spawns the real binary / python script / python function via
//      child_process. Captures stdout/stderr/exit code + output files written to
//      the workDir.
//   3. If NOT installed (or the real run fails): falls back to `simulateCompRun`
//      and writes realistic PDB/FASTA files to disk so the UI file fetcher has
//      real artifacts to serve. The stdout is prefixed with a clear
//      `[SIMULATED — <tool> not installed. Run: <install cmd>]` banner so the
//      user is never misled about what ran.
//
// All file outputs land under `<workDir>/...` (typically
// `outputs/<toolKey>/<jobId>/`). The list of absolute file paths is returned to
// the caller and persisted on the ToolJob row.

import { spawn, execSync } from "child_process";
import { promises as fs, existsSync } from "fs";
import { join } from "path";
import {
  getToolRegistryEntry,
  TOOL_REGISTRY,
  type ToolRegistryEntry,
} from "./tool-registry";
import { getCompTool, simulateCompRun, buildCommand } from "./tools";

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: string[];
  command: string;
  /** true if fell back to simulation. */
  simulated: boolean;
  /** true if a real tool actually ran. */
  realToolUsed: boolean;
}

/** Path to the system python that has biopython + py3Dmol installed. */
const SYSTEM_PYTHON = "/usr/bin/python3";

/**
 * Check if a tool is installed on the host. Uses the registry's detect config:
 *   - binary: `which <binary>` succeeds
 *   - python: `/usr/bin/python3 -c "import <module>"` succeeds
 *   - conda: reserved — not yet implemented (returns false)
 */
export function isToolInstalled(key: string): boolean {
  const entry = getToolRegistryEntry(key);
  if (!entry) return false;
  try {
    if (entry.detect.type === "binary" && entry.detect.binary) {
      execSync(`which ${entry.detect.binary} 2>/dev/null`, {
        stdio: "pipe",
      });
      return true;
    }
    if (entry.detect.type === "python" && entry.detect.pythonModule) {
      execSync(
        `${SYSTEM_PYTHON} -c "import ${entry.detect.pythonModule}" 2>/dev/null`,
        { stdio: "pipe" },
      );
      return true;
    }
    if (entry.detect.type === "conda" && entry.detect.condaEnv) {
      // `conda` itself is not installed in this env (verified by 20-foundation),
      // so any conda-tracked tool is reported as not-installed.
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Execute a comp tool — real if installed, simulated otherwise.
 *
 * @param toolKey  One of the COMP_TOOLS keys.
 * @param params   User-supplied params (from the inspector / preset / agent).
 * @param workDir  Absolute path where the tool should run + write outputs. Will
 *                 be created if missing.
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
      simulated: false,
      realToolUsed: false,
    };
  }

  const entry = getToolRegistryEntry(toolKey);
  const installed = isToolInstalled(toolKey);

  // Ensure workDir exists. (mkdir -p semantics; ignore EEXIST.)
  await fs.mkdir(workDir, { recursive: true }).catch(() => {});

  if (installed && entry) {
    // Run the REAL tool.
    try {
      return await runRealTool(toolKey, params, workDir, entry);
    } catch (e) {
      // Real tool failed to spawn or threw — fall back to simulation with a
      // clear error banner so the user sees what went wrong.
      const sim = simulateCompRun(def, params);
      const errFiles = await writeSimulatedOutputs(toolKey, sim, workDir);
      const errMsg = (e as Error).message ?? String(e);
      return {
        stdout:
          `[REAL TOOL FAILED — falling back to simulation]\n` +
          `Error: ${errMsg}\n\n${sim.stdout}`,
        stderr: errMsg,
        exitCode: 1,
        outputFiles: errFiles,
        command: `[FAILED] ${buildCommand(def, params)}`,
        simulated: true,
        realToolUsed: false,
      };
    }
  }

  // Tool not installed — simulate with clear status banner.
  const sim = simulateCompRun(def, params);
  const outputFiles = await writeSimulatedOutputs(toolKey, sim, workDir);
  const installCmd = entry?.install.command ?? "(no install command available)";
  return {
    stdout:
      `[SIMULATED — ${def.label} not installed. Run: ${installCmd}]\n` +
      `\n${sim.stdout}`,
    stderr: "",
    exitCode: 0,
    outputFiles,
    command: `[SIMULATED] ${buildCommand(def, params)}`,
    simulated: true,
    realToolUsed: false,
  };
}

/**
 * Run a real tool via child_process.
 *
 * Three execution modes (from the registry's `execute` config):
 *   - binary         : spawn the binary directly with the flags from buildCommand.
 *   - python-script  : run a script in scripts/ with /usr/bin/python3.
 *   - python-function: write a tiny runner.py that imports the module + calls
 *                      the named function with the params as kwargs, then runs.
 */
async function runRealTool(
  toolKey: string,
  params: Record<string, unknown>,
  workDir: string,
  entry: ToolRegistryEntry,
): Promise<ExecutionResult> {
  const def = getCompTool(toolKey)!;
  const displayCommand = buildCommand(def, params);

  if (
    entry.execute.type === "python-function" &&
    entry.execute.pythonModule &&
    entry.execute.pythonFunction
  ) {
    const runnerScript = `
import sys, json
params = json.loads(sys.argv[1])
from ${entry.execute.pythonModule} import ${entry.execute.pythonFunction}
result = ${entry.execute.pythonFunction}(**params)
print(json.dumps(result))
`.trim();
    const scriptPath = join(workDir, "runner.py");
    await fs.writeFile(scriptPath, runnerScript);
    return await runProcess(
      SYSTEM_PYTHON,
      [scriptPath, JSON.stringify(params)],
      workDir,
      displayCommand,
    );
  }

  if (entry.execute.type === "python-script" && entry.execute.pythonScript) {
    const scriptPath = join(
      process.cwd(),
      "scripts",
      entry.execute.pythonScript,
    );
    return await runProcess(
      SYSTEM_PYTHON,
      [scriptPath, JSON.stringify(params)],
      workDir,
      displayCommand,
    );
  }

  // Binary type — split the built command into binary + args.
  // NOTE: simple whitespace split is intentional; the buildCommand output for
  // the supported cliStyles (hydra/click/argparse/rosetta) never contains
  // quoted args with embedded spaces for the params the inspector exposes.
  const parts = displayCommand.split(/\s+/).filter(Boolean);
  const binary = parts[0];
  const args = parts.slice(1);
  return await runProcess(binary, args, workDir, displayCommand);
}

/** Run a process and capture stdout/stderr/exit code + output files. */
async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  displayCommand: string,
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { cwd, shell: false });
    } catch (e) {
      resolve({
        stdout: "",
        stderr: `Failed to spawn ${cmd}: ${(e as Error).message}`,
        exitCode: 1,
        outputFiles: [],
        command: displayCommand,
        simulated: false,
        realToolUsed: false,
      });
      return;
    }

    proc.stdout?.on("data", (d) => stdoutChunks.push(d.toString()));
    proc.stderr?.on("data", (d) => stderrChunks.push(d.toString()));

    proc.on("error", (err) => {
      stderrChunks.push(`Failed to spawn process: ${err.message}`);
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: 1,
        outputFiles: [],
        command: displayCommand,
        simulated: false,
        realToolUsed: false,
      });
    });

    proc.on("close", async (code) => {
      // Collect output files from cwd (PDB / FASTA / TXT only — keeps the
      // list focused on artifacts the UI knows how to render).
      let outputFiles: string[] = [];
      try {
        const entries = await fs.readdir(cwd);
        outputFiles = entries
          .filter(
            (f) =>
              f.endsWith(".pdb") ||
              f.endsWith(".fasta") ||
              f.endsWith(".txt"),
          )
          .filter((f) => f !== "runner.py") // exclude our own python runner
          .map((f) => join(cwd, f));
      } catch {
        /* cwd may not exist — ignore */
      }
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 1,
        outputFiles,
        command: displayCommand,
        simulated: false,
        realToolUsed: true,
      });
    });
  });
}

/**
 * Write simulated output files to disk so they're "real" files the UI can
 * fetch via /api/tools/jobs/[id]/file. PDB → real PDB record, FASTA → real
 * FASTA record, anything else → the simulated stdout.
 */
async function writeSimulatedOutputs(
  toolKey: string,
  sim: { stdout: string; outputFiles: string[] },
  workDir: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const filePath of sim.outputFiles) {
    const fileName = filePath.split("/").pop() ?? "output.txt";
    const fullPath = join(workDir, fileName);
    const ext = fileName.split(".").pop()?.toLowerCase();
    let content = "";
    if (ext === "pdb") {
      content = generateRealPdb(toolKey);
    } else if (ext === "fasta") {
      content = generateRealFasta(toolKey);
    } else {
      content = sim.stdout;
    }
    try {
      await fs.writeFile(fullPath, content);
      written.push(fullPath);
    } catch {
      /* ignore — best effort */
    }
  }
  return written;
}

/** Generate a real PDB file (a CA-only helix) tagged as simulated. */
function generateRealPdb(toolKey: string): string {
  const lines: string[] = [
    `REMARK   1 GENERATED BY FOUNDRY-LAB (SIMULATED) tool=${toolKey}`,
  ];
  const numResidues = 24;
  for (let i = 1; i <= numResidues; i++) {
    const t = i * 0.6;
    const x = (15 * Math.cos(t)).toFixed(3);
    const y = (3 * t).toFixed(3);
    const z = (15 * Math.sin(t)).toFixed(3);
    lines.push(
      `ATOM  ${String(i).padStart(5)}  CA  ALA A${String(i).padStart(4)}     ${x.padStart(8)} ${y.padStart(8)} ${z.padStart(8)}  1.00 20.00           C`,
    );
  }
  lines.push("END");
  return lines.join("\n");
}

/** Generate a real FASTA record (60 residues) tagged as simulated. */
function generateRealFasta(toolKey: string): string {
  const aas = "ACDEFGHIKLMNPQRSTVWY";
  const seq = Array.from({ length: 60 }, (_, i) => aas[i % 20]).join("");
  return `>design_1|${toolKey}|simulated\n${seq}\n`;
}

/**
 * Convenience helper for callers that need a one-shot scan of all tools.
 * Returns a stable, JSON-serialisable array (no buffers / streams).
 */
export function scanAllTools(): Array<{
  key: string;
  label: string;
  category: string;
  installed: boolean;
  installMethod: string;
  installCommand: string;
  docs: string;
}> {
  return TOOL_REGISTRY.map((entry) => ({
    key: entry.key,
    label: entry.label,
    category: entry.category,
    installed: isToolInstalled(entry.key),
    installMethod: entry.install.method,
    installCommand: entry.install.command,
    docs: entry.install.docs,
  }));
}

/** Re-export for callers that want to introspect a workDir without running. */
export function workDirExists(workDir: string): boolean {
  return existsSync(workDir);
}
