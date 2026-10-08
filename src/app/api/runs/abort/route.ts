// POST /api/runs/abort — user-initiated stop (E4 "runs you can also govern").
//
// Body: { nodeId } (node-level) or { workflowId } (workflow-level: aborts
// every running/pending node of that workflow). Both shapes validated;
// exactly one is required.
//
// Semantics (node-lifecycle.ts):
//   - pending  → failed: run lanes claim only pending/idle, so the aborted
//     queued node is skipped when its turn comes.
//   - running  → failed: the in-flight executeNode's late result is
//     discarded by persistExecOutcome's conditional write; the runner's
//     finally unlocks downstream and the pool moves on.
//   - Cluster poll-ceiling nodes are NOT special-cased here: flipping one
//     terminal only detaches the node — the remote job itself is cancelled
//     from the Cluster panel (remote cancel is out of scope for this route).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { abortNodeRun, abortWorkflowRun } from "@/lib/node-lifecycle";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
    const workflowId =
      typeof body?.workflowId === "string" ? body.workflowId.trim() : "";

    if (!nodeId === !workflowId) {
      // Neither or both — exactly one target is required.
      return NextResponse.json(
        { error: "Provide exactly one of nodeId or workflowId" },
        { status: 400 },
      );
    }

    if (nodeId) {
      const node = await db.node.findUnique({
        where: { id: nodeId },
        select: { id: true, name: true, status: true },
      });
      if (!node) {
        return NextResponse.json({ error: "Node not found" }, { status: 404 });
      }
      const aborted = await abortNodeRun(nodeId);
      if (!aborted) {
        return NextResponse.json(
          {
            error: `"${node.name}" is not running or queued (status: ${node.status}) — nothing to stop.`,
          },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok: true,
        scope: "node",
        nodeId,
        name: node.name,
      });
    }

    const wf = await db.workflow.findUnique({
      where: { id: workflowId },
      select: { id: true, name: true },
    });
    if (!wf) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 },
      );
    }
    const count = await abortWorkflowRun(workflowId);
    return NextResponse.json({
      ok: true,
      scope: "workflow",
      workflowId,
      name: wf.name,
      aborted: count,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
