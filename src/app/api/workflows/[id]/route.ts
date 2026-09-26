// GET /api/workflows/[id] — return one workflow as a full WorkflowDTO. 404 if not found.
// PATCH /api/workflows/[id] — rename a workflow. Body: { name? }. Returns WorkflowDTO.
// DELETE /api/workflows/[id] — delete the workflow (cascades nodes + edges via Prisma).
//   If the deleted workflow was the LAST one, a new default workflow is created so the
//   app always has at least one workflow to land on.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, toEdgeDTO } from "@/lib/workflow-engine";
import type { WorkflowDTO } from "@/lib/types";

function toWorkflowDTO(w: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  nodes: unknown[];
  edges: unknown[];
}): WorkflowDTO {
  return {
    id: w.id,
    name: w.name,
    nodes: (w.nodes as unknown[]).map((n) => toNodeDTO(n as never)),
    edges: (w.edges as unknown[]).map((e) => toEdgeDTO(e as never)),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const wf = await db.workflow.findUnique({
      where: { id },
      include: { nodes: true, edges: true },
    });
    if (!wf) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(toWorkflowDTO(wf));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const name =
      typeof body?.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : undefined;

    const existing = await db.workflow.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 },
      );
    }

    const updated = await db.workflow.update({
      where: { id },
      data: name ? { name } : {},
      include: { nodes: true, edges: true },
    });
    return NextResponse.json(toWorkflowDTO(updated));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = await db.workflow.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 },
      );
    }

    // Prisma cascade (onDelete: Cascade on Node.workflow + Edge.workflow) cleans
    // the children. The whole row is deleted in one transaction.
    await db.workflow.delete({ where: { id } });

    // If that was the last workflow, create a fresh default so the app always
    // has somewhere to land.
    const remaining = await db.workflow.count();
    if (remaining === 0) {
      await db.workflow.create({
        data: { name: "My First Workflow" },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
