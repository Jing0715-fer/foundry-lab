// GET    /api/workflows/[id]/schedule         — list scheduled runs for a workflow.
// POST   /api/workflows/[id]/schedule         — schedule a new run. Body: { runAt, label? }.
// DELETE /api/workflows/[id]/schedule?scheduleId=<id> — cancel one scheduled run.
// DELETE /api/workflows/[id]/schedule         — cancel ALL scheduled runs for a workflow.
//
// REAL persistence: schedules are WorkflowSchedule rows in SQLite. The
// scheduled-run sweeper (src/lib/scheduler.ts, started from
// instrumentation.ts) claims due rows and runs the workflow through the same
// execution lane as manual runs (runWorkflowById). Rows survive restarts —
// a schedule whose runAt passed while the server was down fires on boot.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export interface ScheduleDTO {
  id: string;
  workflowId: string;
  runAt: string;
  label: string;
  status: "scheduled" | "firing" | "fired" | "failed" | "cancelled";
  firedAt: string | null;
  error: string | null;
  started: number;
  completed: number;
  createdAt: string;
}

function toDTO(s: {
  id: string;
  workflowId: string;
  runAt: Date;
  label: string;
  status: string;
  firedAt: Date | null;
  error: string | null;
  started: number;
  completed: number;
  createdAt: Date;
}): ScheduleDTO {
  return {
    id: s.id,
    workflowId: s.workflowId,
    runAt: s.runAt.toISOString(),
    label: s.label,
    status: s.status as ScheduleDTO["status"],
    firedAt: s.firedAt ? s.firedAt.toISOString() : null,
    error: s.error,
    started: s.started,
    completed: s.completed,
    createdAt: s.createdAt.toISOString(),
  };
}

// GET — list schedules for a workflow (pending first by runAt, then history
// newest-first so the UI's upcoming-runs list is what matters).
export async function GET(
  _request: NextRequest,
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

  const rows = await db.workflowSchedule.findMany({
    where: { workflowId: id },
    orderBy: [{ runAt: "desc" }],
  });
  const upcoming = rows
    .filter((r) => r.status === "scheduled" || r.status === "firing")
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
    .map(toDTO);
  const history = rows
    .filter((r) => r.status !== "scheduled" && r.status !== "firing")
    .map(toDTO);
  return NextResponse.json({ schedules: upcoming, history });
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
  if (runAtDate.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "runAt must be in the future" },
      { status: 400 },
    );
  }

  const row = await db.workflowSchedule.create({
    data: {
      workflowId: id,
      runAt: runAtDate,
      label:
        typeof label === "string" && label.trim().length > 0
          ? label.trim()
          : `Run at ${runAtDate.toLocaleString()}`,
      status: "scheduled",
    },
  });

  return NextResponse.json({ schedule: toDTO(row) });
}

// DELETE — cancel one schedule (?scheduleId=<id>) or all PENDING schedules
// for the workflow (no query param). Fired history rows are kept.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const scheduleId = url.searchParams.get("scheduleId");

  if (scheduleId) {
    const existing = await db.workflowSchedule.findUnique({
      where: { id: scheduleId },
    });
    if (!existing || existing.workflowId !== id) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 },
      );
    }
    if (existing.status === "fired" || existing.status === "firing") {
      return NextResponse.json(
        { error: "This run already fired and cannot be cancelled" },
        { status: 409 },
      );
    }
    await db.workflowSchedule.update({
      where: { id: scheduleId },
      data: { status: "cancelled" },
    });
  } else {
    await db.workflowSchedule.updateMany({
      where: { workflowId: id, status: "scheduled" },
      data: { status: "cancelled" },
    });
  }

  return NextResponse.json({ ok: true });
}
