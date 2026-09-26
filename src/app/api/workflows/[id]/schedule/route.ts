// GET    /api/workflows/[id]/schedule         — list scheduled runs for a workflow.
// POST   /api/workflows/[id]/schedule         — schedule a new run. Body: { runAt, label? }.
// DELETE /api/workflows/[id]/schedule?scheduleId=<id> — cancel one scheduled run.
// DELETE /api/workflows/[id]/schedule         — cancel ALL scheduled runs for a workflow.
//
// Storage is mock — an in-memory `Map<workflowId, Schedule[]>` scoped to the
// server process. In production this would be a DB table (e.g. a `WorkflowSchedule`
// Prisma model with a `runAt` timestamp + a `label` column + an index on
// `workflowId`). The shape + handler semantics below are written to drop straight
// onto a real DB table without touching the client code.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// In-memory schedule store (mock — would be a DB table in production).
// Keyed by workflowId. Each value is an array of schedules for that workflow.
type Schedule = {
  id: string;
  workflowId: string;
  runAt: string;
  label: string;
  createdAt: string;
};

// Use a stable global so HMR in dev doesn't blow away the schedules between
// hot reloads. Without this, every file edit during `bun run dev` would
// re-evaluate this module and wipe the in-memory map.
const globalForSchedules = globalThis as unknown as {
  __workflowSchedules?: Map<string, Schedule[]>;
};
const scheduledRuns: Map<string, Schedule[]> =
  globalForSchedules.__workflowSchedules ?? new Map();
if (!globalForSchedules.__workflowSchedules) {
  globalForSchedules.__workflowSchedules = scheduledRuns;
}

export interface ScheduleDTO {
  id: string;
  workflowId: string;
  runAt: string;
  label: string;
  createdAt: string;
}

// GET — list schedules for a workflow.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Touch the DB to ensure the workflow exists (mirrors the versions route).
  const workflow = await db.workflow.findUnique({ where: { id } });
  if (!workflow) {
    return NextResponse.json(
      { error: "Workflow not found" },
      { status: 404 },
    );
  }

  const schedules = scheduledRuns.get(id) ?? [];
  // Newest-first by runAt so the UI's optimistic prepend is a no-op on next fetch.
  const sorted = [...schedules].sort((a, b) => a.runAt.localeCompare(b.runAt));
  return NextResponse.json({ schedules: sorted });
}

// POST — schedule a new run.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const workflow = await db.workflow.findUnique({ where: { id } });
  if (!workflow) {
    return NextResponse.json(
      { error: "Workflow not found" },
      { status: 404 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { runAt, label } = body as { runAt?: string; label?: string };

  if (!runAt || typeof runAt !== "string") {
    return NextResponse.json(
      { error: "runAt is required" },
      { status: 400 },
    );
  }

  // Validate it parses as a date. datetime-local inputs return a string like
  // "2025-01-30T14:30" — `new Date(...)` handles that.
  const runAtDate = new Date(runAt);
  if (Number.isNaN(runAtDate.getTime())) {
    return NextResponse.json(
      { error: "runAt must be a valid ISO datetime" },
      { status: 400 },
    );
  }

  const schedule: Schedule = {
    id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: id,
    runAt: runAtDate.toISOString(),
    label:
      typeof label === "string" && label.trim().length > 0
        ? label.trim()
        : `Run at ${runAtDate.toLocaleString()}`,
    createdAt: new Date().toISOString(),
  };

  const existing = scheduledRuns.get(id) ?? [];
  scheduledRuns.set(id, [...existing, schedule]);

  return NextResponse.json({ schedule });
}

// DELETE — cancel one schedule (?scheduleId=<id>) or all schedules for the
// workflow (no query param).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const scheduleId = url.searchParams.get("scheduleId");

  if (scheduleId) {
    const existing = scheduledRuns.get(id) ?? [];
    const next = existing.filter((s) => s.id !== scheduleId);
    if (next.length === 0) {
      // Drop the key entirely so GET returns an empty list cleanly.
      scheduledRuns.delete(id);
    } else {
      scheduledRuns.set(id, next);
    }
  } else {
    scheduledRuns.delete(id);
  }

  return NextResponse.json({ ok: true });
}
