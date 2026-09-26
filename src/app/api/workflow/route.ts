// GET /api/workflow — return the first workflow (create one if none exists).
// POST /api/workflow — create a new workflow.

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

export async function GET() {
  try {
    let wf = await db.workflow.findFirst({
      orderBy: { createdAt: "asc" },
      include: { nodes: true, edges: true },
    });
    if (!wf) {
      wf = await db.workflow.create({
        data: { name: "My First Workflow" },
        include: { nodes: true, edges: true },
      });
    }
    return NextResponse.json(toWorkflowDTO(wf));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : "Untitled Workflow";
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
