// POST /api/workflows/[id]/versions/[versionId]/restore — restore a workflow
//   canvas from a stored snapshot.
//
// The restore is a REAL, transactional replacement:
//   1. Load the WorkflowVersion row (must belong to this workflow).
//   2. In one transaction: delete the workflow's current nodes (edges cascade)
//      and recreate the snapshot's nodes + edges with their ORIGINAL ids,
//      positions, params, results, logs, and timestamps.
//   3. Return the fresh WorkflowDTO so the client can swap the canvas.
//
// Restoring does NOT delete other snapshots — you can hop between versions.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, toEdgeDTO, toGroupDTOs } from "@/lib/workflow-engine";
import type { WorkflowDTO } from "@/lib/types";

interface SnapshotNodeRow {
  id: string;
  workflowId: string;
  type: string;
  refId: string | null;
  name: string;
  x: number;
  y: number;
  status: string;
  progress: number;
  params: string;
  result: string | null;
  logs: string;
  /** Optional: pre-sweep-era snapshots lack this column. */
  sweepGroup?: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface SnapshotEdgeRow {
  id: string;
  workflowId: string;
  fromNodeId: string;
  toNodeId: string;
  fromPort: string | null;
  toPort: string | null;
  createdAt: Date | string;
}

const asDate = (v: Date | string | null): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v);

export async function POST(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;

  const workflow = await db.workflow.findUnique({ where: { id } });
  if (!workflow) {
    return NextResponse.json(
      { error: "Workflow not found" },
      { status: 404 },
    );
  }

  const version = await db.workflowVersion.findUnique({
    where: { id: versionId },
  });
  if (!version || version.workflowId !== id) {
    return NextResponse.json(
      { error: "Version not found for this workflow" },
      { status: 404 },
    );
  }

  let snapshotNodes: SnapshotNodeRow[] = [];
  let snapshotEdges: SnapshotEdgeRow[] = [];
  try {
    const nodes = JSON.parse(version.nodes);
    const edges = JSON.parse(version.edges);
    if (Array.isArray(nodes)) snapshotNodes = nodes;
    if (Array.isArray(edges)) snapshotEdges = edges;
  } catch {
    return NextResponse.json(
      { error: "Version snapshot is corrupted (unparseable JSON)" },
      { status: 500 },
    );
  }

  // Transactional swap: wipe current canvas, recreate the snapshot verbatim.
  // Prisma cascades edge deletion with the nodes.
  await db.$transaction(async (tx) => {
    await tx.node.deleteMany({ where: { workflowId: id } });
    for (const n of snapshotNodes) {
      await tx.node.create({
        data: {
          id: n.id,
          workflowId: id,
          type: n.type,
          refId: n.refId,
          name: n.name,
          x: n.x,
          y: n.y,
          status: n.status,
          progress: n.progress,
          params: n.params,
          result: n.result,
          logs: n.logs ?? "",
          // Sweep-group linkage (older snapshots lack the column → null).
          sweepGroup: typeof n.sweepGroup === "string" ? n.sweepGroup : null,
          startedAt: asDate(n.startedAt),
          completedAt: asDate(n.completedAt),
        },
      });
    }
    for (const e of snapshotEdges) {
      await tx.edge.create({
        data: {
          id: e.id,
          workflowId: id,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          fromPort: e.fromPort,
          toPort: e.toPort,
        },
      });
    }
    // Touch updatedAt so list ordering reflects the restore.
    await tx.workflow.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
  });

  const fresh = await db.workflow.findUnique({
    where: { id },
    include: { nodes: true, edges: true },
  });
  if (!fresh) {
    return NextResponse.json(
      { error: "Workflow vanished after restore" },
      { status: 500 },
    );
  }

  const dto: WorkflowDTO = {
    id: fresh.id,
    name: fresh.name,
    // Groups live on the workflow row (not in the version snapshot) — they
    // survive a restore, matching the sweepGroup linkage semantics.
    groups: toGroupDTOs(fresh.groups) ?? undefined,
    nodes: fresh.nodes.map(toNodeDTO),
    edges: fresh.edges.map(toEdgeDTO),
    createdAt: fresh.createdAt.toISOString(),
    updatedAt: fresh.updatedAt.toISOString(),
  };

  return NextResponse.json({
    restored: true,
    version: { id: version.id, label: version.label },
    workflow: dto,
  });
}
