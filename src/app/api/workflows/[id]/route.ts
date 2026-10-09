// GET /api/workflows/[id] — return one workflow as a full WorkflowDTO. 404 if not found.
// PATCH /api/workflows/[id] — rename a workflow and/or persist the canvas
//   group layer. Body: { name?, groups? } — `groups` is the full replacement
//   array [{id, label, color, nodeIds}] (F-lane persistence; null/[] clears).
//   Returns WorkflowDTO.
// DELETE /api/workflows/[id] — delete the workflow (cascades nodes + edges via Prisma).
//   If the deleted workflow was the LAST one, a new default workflow is created so the
//   app always has at least one workflow to land on.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, toEdgeDTO, toGroupDTOs, sanitizeGroupsJSON } from "@/lib/workflow-engine";
import type { WorkflowDTO } from "@/lib/types";

function toWorkflowDTO(w: {
  id: string;
  name: string;
  groups?: string | null;
  createdAt: Date;
  updatedAt: Date;
  nodes: unknown[];
  edges: unknown[];
}): WorkflowDTO {
  return {
    id: w.id,
    name: w.name,
    groups: toGroupDTOs(w.groups) ?? undefined,
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

    // Groups persistence (F-lane): the full replacement array, sanitized +
    // capped server-side. `groups` ABSENT from the body → no change; an
    // explicit `groups: null` or `groups: []` → CLEARS the layer (writes
    // NULL / "[]").
    let groupsData: string | null | undefined;
    if (body && "groups" in body) {
      const sanitized = sanitizeGroupsJSON(body.groups);
      if (typeof sanitized === "object" && sanitized && "error" in sanitized) {
        return NextResponse.json({ error: sanitized.error }, { status: 400 });
      }
      groupsData = sanitized as string | null;
    }

    const existing = await db.workflow.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 },
      );
    }

    const data: { name?: string; groups?: string | null } = {};
    if (name) data.name = name;
    if (groupsData !== undefined) data.groups = groupsData;
    const updated = await db.workflow.update({
      where: { id },
      data,
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
