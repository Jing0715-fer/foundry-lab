// POST /api/workflow/run — run the ACTIVE (first) workflow in topological
// order. The execution engine itself lives in src/lib/workflow-runner.ts and
// is shared with the scheduled-run sweeper (src/lib/scheduler.ts) so manual
// and scheduled runs behave identically.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWorkflowById } from "@/lib/workflow-runner";

export async function POST() {
  try {
    const wf = await db.workflow.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (!wf) {
      return NextResponse.json(
        { error: "No workflow exists" },
        { status: 404 },
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
