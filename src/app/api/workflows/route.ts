// GET /api/workflows — list ALL workflows as WorkflowSummaryDTO[] (newest-first).
// POST /api/workflows — create a new workflow (body: { name? }). Returns full WorkflowDTO.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, toEdgeDTO } from "@/lib/workflow-engine";
import type { WorkflowDTO } from "@/lib/types";

/** Summarise a Prisma Workflow row (with nodes + edges loaded) into a slim DTO. */
function toWorkflowSummary(w: {
  id: string;
  name: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  nodes?: unknown[] | null;
  edges?: unknown[] | null;
}) {
  return {
    id: w.id,
    name: w.name,
    nodeCount: w.nodes?.length ?? 0,
    edgeCount: w.edges?.length ?? 0,
    createdAt:
      w.createdAt instanceof Date
        ? w.createdAt.toISOString()
        : new Date(w.createdAt).toISOString(),
    updatedAt:
      w.updatedAt instanceof Date
        ? w.updatedAt.toISOString()
        : new Date(w.updatedAt).toISOString(),
  };
}

/** Build a full WorkflowDTO from a Prisma row that has nodes + edges loaded. */
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

export async function GET() {
  try {
    const workflows = await db.workflow.findMany({
      orderBy: { updatedAt: "desc" },
      include: { nodes: true, edges: true },
    });
    return NextResponse.json(workflows.map(toWorkflowSummary));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name =
      typeof body?.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : "Untitled Workflow";
    const wf = await db.workflow.create({
      data: { name },
      include: { nodes: true, edges: true },
    });
    return NextResponse.json(toWorkflowDTO(wf));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
