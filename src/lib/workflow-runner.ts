// Workflow runner — shared execution lane for manual runs (POST
// /api/workflow/run) and the SCHEDULED-run sweeper (src/lib/scheduler.ts).
//
// Runs one workflow by id in topological order:
//   1. Fetch the workflow with nodes + edges.
//   2. Topological order via topologicalOrder(nodes, edges). Fails on a cycle.
//   3. Set all idle nodes to pending, save.
//   4. For each node in topo order (sequential):
//      - Skip if not pending or idle.
//      - Set running, save.
//      - gatherInputs from already-completed upstream nodes.
//      - executeNode.
//      - Set completed/failed, save result + logs.
//   5. Return { started, completed, error? }.

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

    // Set running.
    await db.node.update({
      where: { id: nodeId },
      data: {
        status: "running",
        progress: 10,
        startedAt: nodeRow.startedAt ?? new Date(),
      },
    });

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
