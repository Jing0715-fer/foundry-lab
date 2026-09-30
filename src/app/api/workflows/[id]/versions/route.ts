// GET  /api/workflows/[id]/versions — list all stored version snapshots of a
//   workflow (newest-first). Each row is a REAL persisted snapshot of the
//   canvas (nodes + edges JSON) taken at POST time.
// POST /api/workflows/[id]/versions — snapshot the workflow's CURRENT nodes
//   + edges into a new WorkflowVersion row. Body: { label? }.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export interface WorkflowVersionDTO {
  id: string;
  label: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  current?: boolean;
}

// GET — list all versions of a workflow (newest first). The newest snapshot
// is flagged `current` for the UI.
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

  const rows = await db.workflowVersion.findMany({
    where: { workflowId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      nodeCount: true,
      edgeCount: true,
      createdAt: true,
    },
  });

  const versions: WorkflowVersionDTO[] = rows.map((r, i) => ({
    id: r.id,
    label: r.label,
    nodeCount: r.nodeCount,
    edgeCount: r.edgeCount,
    createdAt: r.createdAt.toISOString(),
    current: i === 0,
  }));

  return NextResponse.json({ versions });
}

// POST — snapshot the current canvas into a new version row.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const workflow = await db.workflow.findUnique({
    where: { id },
    include: { nodes: true, edges: true },
  });
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

  // Snapshot the RAW rows (ids, positions, params, results, logs, status) —
  // restoring recreates the exact canvas, including run history.
  const row = await db.workflowVersion.create({
    data: {
      workflowId: id,
      label,
      nodes: JSON.stringify(workflow.nodes),
      edges: JSON.stringify(workflow.edges),
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
    },
  });

  const version: WorkflowVersionDTO = {
    id: row.id,
    label: row.label,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    createdAt: row.createdAt.toISOString(),
    current: true,
  };

  return NextResponse.json(version);
}
