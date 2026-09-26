// GET  /api/workflows/[id]/versions — list all stored version snapshots of a
//   workflow (newest-first). Since the Prisma schema doesn't have a
//   dedicated Version model (we can't modify it from this subagent), we
//   synthesise a deterministic mock list anchored to the workflow's
//   `createdAt` + `updatedAt` timestamps so the UI has something real to
//   render. The shape matches what a real `db.workflowVersion.findMany(...)`
//   would return, so swapping in real storage later is a drop-in change.
//
// POST /api/workflows/[id]/versions — "create" a new version snapshot.
//   Body: { label?: string }. Returns the new version object. Storage is
//   mock — the persisted list isn't actually extended (no schema column for
//   it) — but the response is identical in shape to the GET items so the
//   UI's optimistic prepend just works.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export interface WorkflowVersionDTO {
  id: string;
  label: string;
  createdAt: string;
  current?: boolean;
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

// GET — list all versions of a workflow (returns synthesised snapshots).
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

  // Return mock versions anchored to the workflow's timestamps. Newest first
  // so the UI's prepend-then-sort is a no-op.
  const versions: WorkflowVersionDTO[] = [
    {
      id: "v2",
      label: "Latest",
      createdAt: toIso(workflow.updatedAt),
      current: true,
    },
    {
      id: "v1",
      label: "Initial version",
      createdAt: toIso(workflow.createdAt),
      current: false,
    },
  ];

  return NextResponse.json({ versions });
}

// POST — create a new version snapshot.
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
  const label =
    typeof body?.label === "string" && body.label.trim().length > 0
      ? body.label.trim()
      : `Snapshot ${new Date().toLocaleString()}`;

  // In a real implementation we'd persist the snapshot (e.g. a JSON blob in
  // a WorkflowVersion row). For now, just return success with the new shape
  // so the UI can optimistically prepend it.
  const version: WorkflowVersionDTO = {
    id: `v_${Date.now()}`,
    label,
    createdAt: new Date().toISOString(),
  };

  return NextResponse.json(version);
}
