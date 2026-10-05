// POST /api/workflow/run — run a workflow in topological order. Body may
// carry { workflowId } to target a specific (e.g. currently viewed) workflow;
// omitted → the first workflow. The execution engine itself lives in
// src/lib/workflow-runner.ts and is shared with the scheduled-run sweeper
// (src/lib/scheduler.ts) so manual and scheduled runs behave identically.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWorkflowById, isWorkflowRunning } from "@/lib/workflow-runner";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const workflowId =
      typeof body?.workflowId === "string" ? body.workflowId : null;

    let wf: { id: string } | null = null;
    if (workflowId) {
      wf = await db.workflow.findUnique({ where: { id: workflowId } });
      if (!wf) {
        return NextResponse.json(
          { error: `Workflow ${workflowId} not found` },
          { status: 400 },
        );
      }
    } else {
      wf = await db.workflow.findFirst({
        orderBy: { createdAt: "asc" },
      });
    }
    if (!wf) {
      return NextResponse.json(
        { error: "No workflow exists" },
        { status: 404 },
      );
    }
    if (isWorkflowRunning(wf.id)) {
      return NextResponse.json(
        { error: "Workflow is already running" },
        { status: 409 },
      );
    }

    const result = await runWorkflowById(wf.id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Run failed" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      started: result.started,
      completed: result.completed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
