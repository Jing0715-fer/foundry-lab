// Workflow runner — shared execution lane for manual runs (POST
// /api/workflow/run) and the SCHEDULED-run sweeper (src/lib/scheduler.ts).
//
// Runs one workflow by id in topological order:
//   1. Fetch the workflow with nodes + edges.
//   2. Topological order via topologicalOrder(nodes, edges). Fails on a cycle.
//   3. Set all idle nodes to pending, save.
//   4. For each node in topo order (sequential):
//      - Skip if not pending or idle.
//      - ATOMIC claim pending/idle → running (scheduler.ts pattern) — a
//        concurrent run lane loses the race and skips the node instead of
//        double-executing it.
//      - gatherInputs from already-completed upstream nodes.
//      - executeNode.
//      - Set completed/failed (progress 100, completedAt) — or leave the
//        node running when executeNode reports the poll-ceiling outcome
//        (remote cluster job still executing; the node's SSE stream route
//        reconciles it against the ToolJob row the cluster sweep updates).
//   5. Return { started, completed, error? }.
//
// A node that ends the loop in "running" state does NOT count as completed,
// and its downstream nodes never see it completed so nothing cascades on a
// lie — that's the whole point of the poll-ceiling honesty fix.

import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
  executeNode,
} from "@/lib/workflow-engine";
import { topologicalOrder } from "@/lib/canvas-utils";

export interface WorkflowRunResult {
  ok: boolean;
  workflowId: string;
  started: number;
  completed: number;
  error?: string;
}

/** Run the given workflow end-to-end (sequential, topological). */
export async function runWorkflowById(
  workflowId: string,
): Promise<WorkflowRunResult> {
  const wf = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { nodes: true, edges: true },
  });
  if (!wf) {
    return {
      ok: false,
      workflowId,
      started: 0,
      completed: 0,
      error: "Workflow not found",
    };
  }

  const nodes = wf.nodes.map(toNodeDTO);
  const edges = wf.edges.map(toEdgeDTO);
  const order = topologicalOrder(nodes, edges);
  if (!order) {
    return {
      ok: false,
      workflowId,
      started: 0,
      completed: 0,
      error: "Workflow has a cycle",
    };
  }

  // Mark all idle nodes as pending.
  const idleIds = wf.nodes
    .filter((n) => n.status === "idle")
    .map((n) => n.id);
  if (idleIds.length > 0) {
    await db.node.updateMany({
      where: { id: { in: idleIds } },
      data: { status: "pending" },
    });
  }
  const startedCount = idleIds.length;

  let completedCount = 0;

  // Re-fetch nodes after status change so we always work with fresh state.
  for (const nodeId of order) {
    const nodeRow = await db.node.findUnique({ where: { id: nodeId } });
    if (!nodeRow) continue;
    if (nodeRow.status !== "pending" && nodeRow.status !== "idle") {
      continue;
    }

    // Set running — ATOMIC claim (scheduler.ts updateMany pattern): only a
    // row still in pending/idle flips; a concurrent run (double-clicked Run,
    // scheduler overlap) that raced us to this node sees count 0 and skips
    // it instead of double-executing.
    const claimed = await db.node.updateMany({
      where: { id: nodeId, status: { in: ["pending", "idle"] } },
      data: {
        status: "running",
        progress: 10,
        startedAt: nodeRow.startedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) {
      // Another lane already claimed (or finished) this node.
      continue;
    }

    // Gather inputs from already-completed upstream nodes.
    const freshWf = await db.workflow.findUnique({
      where: { id: workflowId },
      include: { nodes: true, edges: true },
    });
    const freshNodes = (freshWf?.nodes ?? []).map(toNodeDTO);
    const freshEdges = (freshWf?.edges ?? []).map(toEdgeDTO);
    const currentNode = freshNodes.find((n) => n.id === nodeId);
    if (!currentNode) continue;
    const inputs = gatherInputs(nodeId, freshNodes, freshEdges);

    // Execute.
    const { result, logs, status } = await executeNode(
      currentNode,
      inputs,
      workflowId,
    );

    if (status === "running") {
      // Poll-ceiling outcome (cluster job still running remotely): persist
      // the honest in-progress result/logs but NO completedAt and NO
      // progress-100 — the node legitimately stays running.
      await db.node.update({
        where: { id: nodeId },
        data: { status, result, logs, progress: 90 },
      });
      continue;
    }

    await db.node.update({
      where: { id: nodeId },
      data: {
        status,
        result,
        logs,
        progress: 100,
        completedAt: new Date(),
      },
    });
    if (status === "completed") completedCount++;
  }

  return { ok: true, workflowId, started: startedCount, completed: completedCount };
}
