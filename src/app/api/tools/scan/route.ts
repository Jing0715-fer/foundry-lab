// GET /api/tools/scan
//   Scans the host for installed comp tools and returns one row per tool with:
//     - installed: boolean (was the tool detected?)
//     - installCommand: the recommended install command (for one-click install)
//     - installMethod: pip | conda | github | binary
//     - docs: URL to the project's docs/repo
//     - category: design | inverse-folding | structure-prediction | scoring | bio
//
// Detection is performed synchronously by `isToolInstalled` (which shells out
// to `which` / `python -c "import <module>"`). On a typical dev box this is
// sub-100ms for all 10 tools combined.

import { NextResponse } from "next/server";
import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { isToolInstalled } from "@/lib/real-executor";

export async function GET() {
  const results = TOOL_REGISTRY.map((entry) => ({
    key: entry.key,
    label: entry.label,
    installed: isToolInstalled(entry.key),
    installCommand: entry.install.command,
    installMethod: entry.install.method,
    docs: entry.install.docs,
    category: entry.category,
  }));

  const installedCount = results.filter((r) => r.installed).length;
  const totalCount = results.length;

  return NextResponse.json({
    tools: results,
    summary: {
      installed: installedCount,
      total: totalCount,
      missing: totalCount - installedCount,
    },
  });
}
