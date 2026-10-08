// POST /api/workflow/nodes — create a Node.
//
// Target workflow resolution:
//   - body.workflowId present (multi-workflow switcher) → the node is created
//     in THAT workflow; 404 when the id doesn't exist.
//   - absent → the legacy default: the FIRST workflow (oldest by createdAt
//     asc), so pre-switcher clients keep working unchanged.
//
// C3 (undo status semantics): an OPTIONAL snapshot block — status / progress /
// result / logs — lets history-apply re-create nodes exactly as they were
// captured (an undo-of-delete used to resurrect every node as idle, silently
// wiping a completed run's state). Defaults are unchanged for every other
// caller. Status is validated against the NodeStatus enum; result/logs are
// size-capped so the endpoint can't be abused as an unbounded blob store.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, resolveTargetWorkflow } from "@/lib/workflow-engine";

/** Valid node statuses for the optional snapshot block (C3). */
const SNAPSHOT_STATUSES = new Set([
  "idle",
  "pending",
  "running",
  "completed",
  "failed",
]);
/** Blob size caps for snapshot-restored fields (1 MiB each). */
const MAX_SNAPSHOT_TEXT = 1024 * 1024;

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
    // Size cap on the params blob too (P2, qa-review-c-e-lane.md): the
    // route header promises the endpoint can't be abused as an unbounded
    // blob store — result/logs already cap at 1 MiB, params must as well.
    if (paramsJson.length > MAX_SNAPSHOT_TEXT) {
      return NextResponse.json(
        { error: "params exceeds the 1 MiB limit" },
        { status: 413 },
      );
    }

    // Optional sweep-group linkage — undo/redo replays a sweep batch through
    // this endpoint and the restored variants must land back in their group
    // (compare view + one-click campaign resolve by sweepGroup). Plain string
    // trim + length cap only: the id is opaque to this route.
    const sweepGroupId =
      typeof sweepGroup === "string" && sweepGroup.trim()
        ? sweepGroup.trim().slice(0, 64)
        : null;

    // Optional snapshot restore (C3): history-apply passes the captured
    // status/progress/result/logs so an undo-of-delete resurrects the node
    // as it was (e.g. still completed with its outputs) instead of idle.
    // "running" AND "pending" are coerced to "idle": a resurrected node has
    // no live executor behind it, and a revived "pending" row would sit in
    // the run queue forever (nothing will claim it — the runner that enqueued
    // it is long gone).
    let snapStatus: string = "idle";
    if (typeof status === "string" && SNAPSHOT_STATUSES.has(status)) {
      snapStatus =
        status === "running" || status === "pending" ? "idle" : status;
    }
    const snapProgress =
      typeof progress === "number" && Number.isFinite(progress)
        ? Math.max(0, Math.min(100, Math.round(progress)))
        : snapStatus === "completed"
          ? 100
          : 0;
    const snapResult =
      typeof result === "string" && result.length <= MAX_SNAPSHOT_TEXT
        ? result
        : null;
    const snapLogs =
      typeof logs === "string" && logs.length <= MAX_SNAPSHOT_TEXT ? logs : "";
    const snapTerminal = snapStatus === "completed" || snapStatus === "failed";
    const now = new Date();

    const node = await db.node.create({
      data: {
        workflowId: target.workflow.id,
        type,
        name,
        refId: typeof refId === "string" ? refId : null,
        x: typeof x === "number" ? x : 0,
        y: typeof y === "number" ? y : 0,
        status: snapStatus,
        progress: snapProgress,
        result: snapResult,
        logs: snapLogs,
        startedAt: snapTerminal ? now : null,
        completedAt: snapTerminal ? now : null,
        params: paramsJson,
        sweepGroup: sweepGroupId,
      },
    });

    return NextResponse.json(toNodeDTO(node));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
