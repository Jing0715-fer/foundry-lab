// PATCH /api/workflow/nodes/[id] — update a Node.
// DELETE /api/workflow/nodes/[id] — delete a Node (cascades edges via Prisma).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO } from "@/lib/workflow-engine";

// The NodeStatus union from src/lib/types.ts — spelled out here so an
// unknown status string gets an honest 400 instead of silently persisting
// a state no consumer (runner / stream / UI) knows how to handle.
const VALID_NODE_STATUSES = [
  "idle",
  "pending",
  "running",
  "completed",
  "failed",
] as const;

type PatchBody = {
  name?: string;
  x?: number;
  y?: number;
  refId?: string | null;
  params?: Record<string, string | number | boolean>;
  status?: string;
  progress?: number;
  result?: string | null;
  logs?: string | null;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as PatchBody;

    const existing = await db.node.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string") data.name = body.name;
    if (typeof body.x === "number") data.x = body.x;
    if (typeof body.y === "number") data.y = body.y;
    if (body.refId !== undefined) {
      data.refId = body.refId === null ? null : String(body.refId);
    }
    if (typeof body.status === "string") {
      // Validate against the known NodeStatus enum — an arbitrary string
      // here would wedge the runner/stream/UI state machines.
      if (!(VALID_NODE_STATUSES as readonly string[]).includes(body.status)) {
        return NextResponse.json(
          {
            error:
              `status must be one of ${VALID_NODE_STATUSES.join(" | ")}` +
              ` (got "${body.status}")`,
          },
          { status: 400 },
        );
      }
      data.status = body.status;
    }
    if (typeof body.progress === "number") data.progress = body.progress;
    if (body.result !== undefined) {
      data.result = body.result === null ? null : String(body.result);
    }
    if (body.logs !== undefined) {
      data.logs = body.logs === null ? "" : String(body.logs);
    }
    if (body.params !== undefined && typeof body.params === "object") {
      data.params = JSON.stringify(body.params);
    }

    if (data.status === "running" && !existing.startedAt) {
      data.startedAt = new Date();
    }
    if (data.status === "completed" || data.status === "failed") {
      data.completedAt = new Date();
    }

    const updated = await db.node.update({ where: { id }, data });
    return NextResponse.json(toNodeDTO(updated));
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
    // Prisma cascade handles edges (onDelete: Cascade on Edge.workflowId is via Workflow,
    // but Edge has no direct relation to Node — we must manually clean up edges referencing this node).
    await db.edge.deleteMany({
      where: { OR: [{ fromNodeId: id }, { toNodeId: id }] },
    });
    await db.node.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
