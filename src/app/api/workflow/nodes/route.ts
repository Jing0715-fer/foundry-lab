// POST /api/workflow/nodes — create a Node.
//
// Target workflow resolution:
//   - body.workflowId present (multi-workflow switcher) → the node is created
//     in THAT workflow; 404 when the id doesn't exist.
//   - absent → the legacy default: the FIRST workflow (oldest by createdAt
//     asc), so pre-switcher clients keep working unchanged.
//
// C3 undo-state semantics: the create body may carry an optional SNAPSHOT
// STATE (status / progress / result / logs / completedAt). Undo/redo replays
// a delete through this endpoint, and a restored node that was completed
// should come back as completed (with its result/logs), not as a blank idle
// row — the undo snapshot is the source of truth. "running" is NOT accepted:
// an in-flight execution cannot be re-attached to a fresh row id, so it maps
// to idle (the run's own conditional persist 404s / no-ops on the old row).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, resolveTargetWorkflow } from "@/lib/workflow-engine";

/** Statuses a restored node may take (running deliberately excluded — C3). */
const RESTORABLE_STATUSES = new Set(["idle", "pending", "completed", "failed"]);

/** Generous cap for restored bodies (logs/results can be large, but a
 * snapshot replay is bounded by what the row held in the first place). */
const RESTORE_TEXT_CAP = 256 * 1024;

function clampProgress(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

function parseRestoredDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      type,
      name,
      x,
      y,
      refId,
      params,
      workflowId,
      sweepGroup,
      status,
      progress,
      result,
      logs,
      startedAt,
      completedAt,
    } = body ?? {};

    if (typeof type !== "string" || typeof name !== "string") {
      return NextResponse.json(
        { error: "type and name are required" },
        { status: 400 },
      );
    }

    // Resolve the target workflow (explicit workflowId → that one, else the
    // first workflow by createdAt asc). 404 when an explicit id is missing.
    const target = await resolveTargetWorkflow(workflowId);
    if (!target.ok) {
      return NextResponse.json(
        { error: target.error },
        { status: target.status },
      );
    }

    const paramsJson =
      params && typeof params === "object"
        ? JSON.stringify(params)
        : "{}";

    // Optional sweep-group linkage — undo/redo replays a sweep batch through
    // this endpoint and the restored variants must land back in their group
    // (compare view + one-click campaign resolve by sweepGroup). Plain string
    // trim + length cap only: the id is opaque to this route.
    const sweepGroupId =
      typeof sweepGroup === "string" && sweepGroup.trim()
        ? sweepGroup.trim().slice(0, 64)
        : null;

    // ── C3 optional snapshot-state restoration ─────────────────────────────
    // Plain creates (palette / drop / sweep) send none of these fields and
    // get the legacy fresh-idle row. History replays send the pre-delete
    // snapshot so an undo of "delete a completed node" restores it completed.
    const restoreStatus =
      typeof status === "string" && RESTORABLE_STATUSES.has(status)
        ? status
        : null;
    // QA 23-a P2-⑥: only TERMINAL restores carry a meaningful progress — an
    // idle/pending row restored with a leftover progress (e.g. 40) would show
    // a phantom partial bar; terminal states are always 100 in this app.
    const restoreProgress =
      restoreStatus === "idle" || restoreStatus === "pending"
        ? 0
        : restoreStatus === "completed"
          ? 100
          : clampProgress(progress) ?? 100;
    const restoreResult =
      typeof result === "string" ? result.slice(0, RESTORE_TEXT_CAP) : null;
    const restoreLogs =
      typeof logs === "string" ? logs.slice(0, RESTORE_TEXT_CAP) : "";
    const restoreCompletedAt =
      restoreStatus === "completed" || restoreStatus === "failed"
        ? parseRestoredDate(completedAt) ?? new Date()
        : null;
    const restoreStartedAt =
      restoreStatus === "completed" || restoreStatus === "failed"
        ? parseRestoredDate(startedAt) ?? restoreCompletedAt
        : null;

    const node = await db.node.create({
      data: {
        workflowId: target.workflow.id,
        type,
        name,
        refId: typeof refId === "string" ? refId : null,
        x: typeof x === "number" ? x : 0,
        y: typeof y === "number" ? y : 0,
        status: restoreStatus ?? "idle",
        progress:
          restoreStatus === "completed"
            ? 100
            : (restoreProgress ?? 0),
        params: paramsJson,
        sweepGroup: sweepGroupId,
        ...(restoreStatus ? { result: restoreResult } : {}),
        ...(restoreStatus ? { logs: restoreLogs } : {}),
        ...(restoreCompletedAt ? { completedAt: restoreCompletedAt } : {}),
        ...(restoreStartedAt ? { startedAt: restoreStartedAt } : {}),
      },
    });

    return NextResponse.json(toNodeDTO(node));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
