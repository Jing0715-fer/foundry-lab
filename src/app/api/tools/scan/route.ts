// GET /api/tools/scan
//   Full environment scan across the three tool tiers:
//     - runtime:  python3, numpy, scipy, biopython, git (with versions)
//     - engines:  built-in real algorithm engines (self-test status)
//     - tools:    external comp tools — native installed? engine fallback?
//   Plus a summary block for the header counters.
//
// Detection shells out to `which` / `python3 -c "import <module>"` and runs
// each engine's fast self-test (sub-100ms each after the first compile).

import { NextResponse } from "next/server";
import { execSync } from "child_process";
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
} from "@/lib/real-executor";
import { listInstallJobs } from "@/lib/install-jobs";

export async function GET() {
  const py = resolveEnginePython();

  const runtime = RUNTIME_ENTRIES.map((entry) => {
    const installed = isEntryInstalled(entry.detect);
    let version: string | null = null;
    if (installed) {
      try {
        if (entry.detect.type === "binary" && entry.detect.versionFlag) {
          version =
            execSync(`${entry.detect.binary} ${entry.detect.versionFlag} 2>/dev/null`, {
              stdio: "pipe",
              timeout: 8000,
            })
              .toString()
              .trim()
              .split("\n")[0] ?? null;
        } else if (entry.detect.type === "python" && entry.detect.pythonModule) {
          const mod =
            entry.detect.pythonModule === "Bio" ? "Bio" : entry.detect.pythonModule;
          version =
            execSync(
              `${py} -c "import ${mod}; print(getattr(${mod}, '__version__', 'ok'))" 2>/dev/null`,
              { stdio: "pipe", timeout: 8000 },
            )
              .toString()
              .trim() || null;
        }
      } catch {
        version = null;
      }
    }
    return {
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
    };
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

  const tools = scanAllTools();

  const runtimeOk = runtime.every((r) => r.installed || r.key === "scipy" || r.key === "biopython");
  const coreRuntimeOk = runtime
    .filter((r) => r.key === "python3" || r.key === "numpy")
    .every((r) => r.installed);
  const enginesOk = engines.filter((e) => e.ok).length;

  return NextResponse.json({
    scannedAt: new Date().toISOString(),
    runtime,
    engines,
    tools,
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
