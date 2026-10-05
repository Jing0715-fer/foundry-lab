// GET /api/workflow/nodes/[id]/sweep-group — sweep comparison data.
//
// Given ANY variant node of a parameter sweep, resolves the whole group
// (every node sharing its sweepGroup in the same workflow) and returns a
// compare table payload:
//   - axisKeys: param keys that actually differ across the variants
//     (the table's parameter columns),
//   - per-variant: status, params, ##OUTPUTS## trailer files, and AGGREGATED
//     run metrics (means over the variant's output dirs — same extraction
//     rules the screening harvester applies, via collectRunMetricsForDirs),
//   - metric columns with label/direction/domain (same registry).
//
// Read-only: no DB rows are written — the screening campaign is a separate
// explicit action (POST /api/screening {source:{kind:"sweep"}}).

import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { db } from "@/lib/db";
import { nodeSpec } from "@/lib/workflow-catalog";
import {
  collectRunMetricsForDirs,
  computeMetricDefsForValues,
} from "@/lib/screening";
import type { NodeStatus, NodeType, SweepGroupDTO } from "@/lib/types";

/** ##OUTPUTS## trailer parser — MUST match workflow-engine.ts parseOutputsTrailer. */
function parseOutputsTrailer(logs: string): string[] {
  const m = logs.match(/##OUTPUTS## (\[[\s\S]*?\])/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const node = await db.node.findUnique({ where: { id } });
    if (!node) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }
    if (!node.sweepGroup) {
      return NextResponse.json(
        { error: "This node is not part of a parameter sweep" },
        { status: 400 },
      );
    }

    const variants = await db.node.findMany({
      where: { workflowId: node.workflowId, sweepGroup: node.sweepGroup },
      orderBy: { createdAt: "asc" },
    });
    if (variants.length === 0) {
      return NextResponse.json(
        { error: "Sweep group is empty" },
        { status: 404 },
      );
    }

    const spec = nodeSpec(node.type);

    // Per-variant rows + aggregated metrics.
    const rows = await Promise.all(
      variants.map(async (v) => {
        const files = parseOutputsTrailer(v.logs ?? "").filter((f) => existsSync(f));
        const dirs = [...new Set(files.map((f) => dirname(resolve(f))))];
        const metrics = await collectRunMetricsForDirs(dirs);
        return {
          nodeId: v.id,
          name: v.name,
          status: v.status as NodeStatus,
          params: (() => {
            try {
              const p = JSON.parse(v.params || "{}");
              return p && typeof p === "object" && !Array.isArray(p)
                ? (p as Record<string, string | number | boolean>)
                : {};
            } catch {
              return {};
            }
          })(),
          files,
          metrics,
          completedAt:
            v.completedAt instanceof Date
              ? v.completedAt.toISOString()
              : v.completedAt
                ? new Date(v.completedAt).toISOString()
                : null,
        };
      }),
    );

    // Axis keys = params that actually vary across the group (stable order:
    // first-seen while scanning variants in creation order).
    const axisKeys: string[] = [];
    const first = rows[0]?.params ?? {};
    for (const key of Object.keys(first)) {
      const varies = rows.some(
        (r) => String(r.params[key]) !== String(first[key]),
      );
      if (varies) axisKeys.push(key);
    }

    // Stable row order: sort by axis param values (numeric-aware, then name)
    // — a redo re-creates variants in parallel and createdAt order scrambles.
    if (axisKeys.length > 0) {
      rows.sort((a, b) => {
        for (const k of axisKeys) {
          const av = a.params[k];
          const bv = b.params[k];
          const an = typeof av === "number" ? av : Number(av);
          const bn = typeof bv === "number" ? bv : Number(bv);
          if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
            return an - bn;
          }
          const c = String(av ?? "").localeCompare(String(bv ?? ""));
          if (c !== 0) return c;
        }
        return a.name.localeCompare(b.name);
      });
    }

    // Metric columns from the observed metric maps (registry order + auto).
    const metricValues = rows.map((r) => r.metrics);
    const metricDefs = computeMetricDefsForValues(metricValues);

    const dto: SweepGroupDTO = {
      groupId: node.sweepGroup,
      workflowId: node.workflowId,
      nodeType: node.type as NodeType,
      toolLabel: spec?.label ?? node.type,
      axisKeys,
      variants: rows,
      metrics: metricDefs,
      completedCount: rows.filter((r) => r.status === "completed").length,
      totalOutputFiles: rows.reduce((acc, r) => acc + r.files.length, 0),
    };
    return NextResponse.json(dto);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
