// POST /api/workflow/nodes — create a Node.
// body.workflowId (optional string): target workflow, validated via
// findUnique (404→400 if it doesn't exist). Falls back to the first workflow
// so single-workflow clients keep working.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO } from "@/lib/workflow-engine";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      type,
      name,
      x,
      y,
      refId,
      params,
      workflowId,
    } = body ?? {};

    if (typeof type !== "string" || typeof name !== "string") {
      return NextResponse.json(
        { error: "type and name are required" },
        { status: 400 },
      );
    }

    const hasWorkflowId = typeof workflowId === "string" && workflowId.trim() !== "";
    const wf = hasWorkflowId
      ? await db.workflow.findUnique({
          where: { id: (workflowId as string).trim() },
        })
      : await db.workflow.findFirst({ orderBy: { createdAt: "asc" } });
    if (hasWorkflowId && !wf) {
      return NextResponse.json(
        { error: `Workflow not found: ${workflowId}` },
        { status: 400 },
      );
    }
    if (!wf) {
      return NextResponse.json(
        { error: "No workflow exists" },
        { status: 404 },
      );
    }

    const paramsJson =
      params && typeof params === "object"
        ? JSON.stringify(params)
        : "{}";

    const node = await db.node.create({
      data: {
        workflowId: wf.id,
        type,
        name,
        refId: typeof refId === "string" ? refId : null,
        x: typeof x === "number" ? x : 0,
        y: typeof y === "number" ? y : 0,
        status: "idle",
        progress: 0,
        params: paramsJson,
      },
    });

    return NextResponse.json(toNodeDTO(node));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
