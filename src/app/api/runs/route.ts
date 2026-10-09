// GET /api/runs — global run queue (B4).
//
// Cross-workflow execution visibility:
//   - active:  every node currently running or queued (pending), with its
//              workflow name — the "what is executing right now" lane.
//   - failed:  terminal failures from the last 48h — each row carries a
//              retry affordance (the client POSTs /api/workflow/nodes/:id/run,
//              which claims completed/failed nodes conditionally and cascades
//              downstream).
//   - recent:  latest terminal runs (completed/failed) from the last 48h —
//              duration + status for the activity feed.
//
// Read-only: no mutations happen here. The query itself selects ONLY the
// fields the runs sheet renders (result/logs bodies can be megabytes and
// this route is polled at 3s while the sheet is open).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifyFailure, type FailureReason } from "@/lib/failure-reason";

const MAX_RECENT = 40;
const MAX_ACTIVE = 200;
const WINDOW_MS = 48 * 60 * 60 * 1000;

// Shared select: trimmed columns + the joined workflow label.
const SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  progress: true,
  startedAt: true,
  completedAt: true,
  workflowId: true,
  workflow: { select: { id: true, name: true } },
} as const;

type RunNode = {
  id: string;
  name: string;
  type: string;
  status: string;
  progress: number;
  startedAt: Date | null;
  completedAt: Date | null;
  workflow: { id: string; name: string } | null;
};

function trim(n: RunNode, failureReason?: FailureReason) {
  return {
    nodeId: n.id,
    name: n.name,
    type: n.type,
    status: n.status,
    progress: n.progress,
    startedAt: n.startedAt?.toISOString() ?? null,
    completedAt: n.completedAt?.toISOString() ?? null,
    workflow: n.workflow,
    // F1: only failed rows carry a reason (completed rows omit the field).
    ...(n.status === "failed" ? { failureReason: failureReason ?? "engine" } : {}),
  };
}

export async function GET() {
  try {
    const since = new Date(Date.now() - WINDOW_MS);

    // Active lane: running + queued, oldest first (queue order feel).
    const activeRows = (await db.node.findMany({
      where: { status: { in: ["running", "pending"] } },
      orderBy: { startedAt: "asc" },
      take: MAX_ACTIVE,
      select: SELECT,
    })) as RunNode[];

    // Terminal lanes from the window, newest first.
    const terminalRows = (await db.node.findMany({
      where: {
        status: { in: ["completed", "failed"] },
        startedAt: { gte: since },
      },
      orderBy: { startedAt: "desc" },
      take: MAX_RECENT * 2, // over-fetch once, split after (failed wins the cap)
      select: SELECT,
    })) as RunNode[];

    // Exact window counts (independent of the display caps above).
    const [failedCount, completedCount] = await Promise.all([
      db.node.count({
        where: { status: "failed", startedAt: { gte: since } },
      }),
      db.node.count({
        where: { status: "completed", startedAt: { gte: since } },
      }),
    ]);

    // F1: classify the failed rows by their persisted result marker
    // (stopped / watchdog / engine). The main SELECT stays trimmed for the
    // 3s poll — result bodies are fetched here ONLY for the failed rows
    // already in `terminalRows`, bounded by the same MAX_RECENT cap.
    const failedIds = terminalRows
      .filter((n) => n.status === "failed")
      .map((n) => n.id);
    const reasonById = new Map<string, FailureReason>();
    if (failedIds.length > 0) {
      const reasonRows = await db.node.findMany({
        where: { id: { in: failedIds } },
        select: { id: true, result: true },
      });
      for (const r of reasonRows) {
        // All three markers are head-anchored — classifying on a 512-char
        // prefix keeps the 3s poll constant-bound even for pathological
        // 256KB result rows (P2-2).
        reasonById.set(r.id, classifyFailure(r.result?.slice(0, 512)));
      }
    }

    const failed = terminalRows
      .filter((n) => n.status === "failed")
      .slice(0, MAX_RECENT)
      .map((n) => trim(n, reasonById.get(n.id)));
    const recent = terminalRows
      .slice(0, MAX_RECENT)
      .map((n) => trim(n, reasonById.get(n.id)));

    return NextResponse.json({
      scannedAt: new Date().toISOString(),
      active: activeRows.map((n) => trim(n)),
      failed,
      recent,
      summary: {
        running: activeRows.filter((n) => n.status === "running").length,
        queued: activeRows.filter((n) => n.status === "pending").length,
        failed: failedCount,
        completedInWindow: completedCount,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
