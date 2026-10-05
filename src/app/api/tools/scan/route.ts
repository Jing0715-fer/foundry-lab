// GET /api/tools/scan
//   Full environment scan across the three tool tiers:
//     - runtime:  python3, numpy, scipy, biopython, git (with versions)
//     - engines:  built-in real algorithm engines (self-test status)
//     - tools:    external comp tools — native installed? engine fallback?
//   Plus a summary block for the header counters and a `platform` snapshot
//   (os / label) for the Environment panel's platform badge.
//
// Detection is cross-platform: PATH lookups go through crossWhich, version
// probes run via runCapture (spawnSync ARRAY form — no shell strings), and
// python module versions use the resolved engine python. On win32, github-
// method one-click installs are reported as NOT one-click with a WSL note
// (their install commands are bash scripts); pip entries stay one-click.

import { NextResponse } from "next/server";
import {
  TOOL_REGISTRY,
  RUNTIME_ENTRIES,
  BUILTIN_ENGINES,
} from "@/lib/tool-registry";
import {
  isEntryInstalled,
  scanAllTools,
  selfTestEngines,
  resolveEnginePython,
  pythonSpawnTokens,
} from "@/lib/real-executor";
import { getFoundryStatus } from "@/lib/foundry";
import { listInstallJobs } from "@/lib/install-jobs";
import { getPlatformInfo, runCapture } from "@/lib/platform";

/** win32: github-method one-click installs are bash scripts — mark them
 *  not-one-click with a WSL platformNote. Pip/runtime entries are untouched. */
function applyWindowsInstallNotes<T extends { installMethod: string; oneClick: boolean }>(
  row: T,
): T & { platformNote?: string } {
  if (
    process.platform === "win32" &&
    row.installMethod === "github" &&
    row.oneClick
  ) {
    return {
      ...row,
      oneClick: false,
      platformNote: "Windows 需通过 WSL 安装（此命令为 bash 脚本）",
    };
  }
  return row;
}

export async function GET() {
  const py = resolveEnginePython();
  const platform = getPlatformInfo();
  const pyTok = py ? pythonSpawnTokens(py) : null;

  const runtime = RUNTIME_ENTRIES.map((entry) => {
    const installed = isEntryInstalled(entry.detect);
    let version: string | null = null;
    if (installed) {
      if (
        entry.detect.type === "binary" &&
        entry.detect.binary &&
        entry.detect.versionFlag
      ) {
        // e.g. `git --version` / `python3 --version` — array form, no shell.
        const out = runCapture(
          entry.detect.binary,
          [entry.detect.versionFlag],
          8000,
        );
        version = out?.trim().split("\n")[0] ?? null;
      } else if (
        entry.detect.type === "python" &&
        entry.detect.pythonModule &&
        pyTok
      ) {
        const mod =
          entry.detect.pythonModule === "Bio" ? "Bio" : entry.detect.pythonModule;
        const out = runCapture(
          pyTok.cmd,
          [
            ...pyTok.preArgs,
            "-c",
            `import ${mod}; print(getattr(${mod}, '__version__', 'ok'))`,
          ],
          8000,
        );
        version = out?.trim().split("\n")[0] || null;
      }
    }
    return applyWindowsInstallNotes({
      key: entry.key,
      label: entry.label,
      description: entry.description,
      installed,
      version,
      installMethod: entry.install.method,
      installCommand: entry.install.command,
      installLabel: entry.install.label,
      docs: entry.install.docs,
      oneClick: entry.install.oneClick,
      sizeHint: entry.install.sizeHint ?? null,
      category: entry.category,
    });
  });

  const engines = selfTestEngines().map((t) => {
    const engine = BUILTIN_ENGINES.find((e) => e.key === t.key)!;
    return {
      key: t.key,
      label: t.label,
      script: t.script,
      description: engine.description,
      algorithms: engine.algorithms,
      serves: engine.serves,
      provenance: engine.provenance ?? null,
      ok: t.ok,
      detail: t.detail,
    };
  });

  const tools = scanAllTools().map(applyWindowsInstallNotes);

  // Foundry platform status (official RosettaCommons rc-foundry stack:
  // version, torch/device, installed checkpoints, real capabilities).
  const foundry = getFoundryStatus();

  const runtimeOk = runtime.every((r) => r.installed || r.key === "scipy" || r.key === "biopython");
  const coreRuntimeOk = runtime
    .filter((r) => r.key === "python3" || r.key === "numpy")
    .every((r) => r.installed);
  const enginesOk = engines.filter((e) => e.ok).length;

  return NextResponse.json({
    scannedAt: new Date().toISOString(),
    platform,
    runtime,
    engines,
    tools,
    foundry,
    summary: {
      runtime: {
        installed: runtime.filter((r) => r.installed).length,
        total: runtime.length,
        coreReady: coreRuntimeOk,
        allReady: runtimeOk,
      },
      engines: { ok: enginesOk, total: engines.length },
      tools: {
        nativeInstalled: tools.filter((t) => t.installed).length,
        total: tools.length,
        withEngineFallback: tools.filter((t) => t.executorReady).length,
      },
    },
    activeInstall: listInstallJobs().find((j) => j.status === "running") ?? null,
    recentInstalls: listInstallJobs().slice(0, 5),
  });
}

// Keep the tools-registry import referenced for tree-shaking clarity.
void TOOL_REGISTRY;
