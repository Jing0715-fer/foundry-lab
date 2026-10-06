// POST /api/workflow/run — run a workflow in topological order. The
// execution engine itself lives in src/lib/workflow-runner.ts and is shared
// with the scheduled-run sweeper (src/lib/scheduler.ts) so manual and
// scheduled runs behave identically.
//
// Target workflow resolution:
//   - body.workflowId present (multi-workflow switcher) → run THAT workflow;
//     404 when the id doesn't exist.
//   - absent → the legacy default: the FIRST workflow (oldest by createdAt
//     asc).
//
// Double-execution guard: if any node of the target workflow is already
// `running` (double-clicked Run, an in-flight single-node run, or a cluster
// node still executing past its poll ceiling), respond 409 instead of
// double-running the DAG. workflow-runner.ts additionally claims each node
// atomically (idle/pending → running) before executing it.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWorkflowById } from "@/lib/workflow-runner";
import { resolveTargetWorkflow } from "@/lib/workflow-engine";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { workflowId } = body ?? {};

    // Resolve the target workflow (explicit workflowId → that one; absent →
    // legacy first workflow by createdAt asc). 404 on unknown id.
    const target = await resolveTargetWorkflow(workflowId);
    if (!target.ok) {
      return NextResponse.json(
        { error: target.error },
        { status: target.status },
      );
    }
    const wf = target.workflow;

    // Cheap pre-check for nodes still running (double-execution guard). The
    // per-node atomic claim inside workflow-runner.ts is the hard guarantee;
    // this gives the client an honest 409 in the common double-click case.
    const running = await db.node.findMany({
      where: { workflowId: wf.id, status: "running" },
      select: { id: true },
    });
    if (running.length > 0) {
      return NextResponse.json(
        {
          error:
            `Workflow is already running (${running.length} node(s) in ` +
            "running state) — wait for the current run to finish or stop it first.",
        },
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
      // B2 parallel lane telemetry: peak simultaneous executions of this
      // run (3 = the pool cap was reached; 1 = strictly sequential DAG).
      peakConcurrency: result.peakConcurrency,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
