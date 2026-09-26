// POST /api/workflow/run — run the WHOLE workflow in topological order.
// Steps:
//   1. Fetch first workflow with nodes + edges.
//   2. Topological order via topologicalOrder(nodes, edges). 400 if cycle.
//   3. Set all idle nodes to pending, save.
//   4. For each node in topo order (sequential):
//      - Skip if not pending or idle.
//      - Set running, save.
//      - gatherInputs from already-completed upstream nodes.
//      - executeNode.
//      - Set completed/failed, save result + logs.
//   5. Return { started, completed }.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
  executeNode,
} from "@/lib/workflow-engine";
import { topologicalOrder } from "@/lib/canvas-utils";

export async function POST() {
  try {
    const wf = await db.workflow.findFirst({
      orderBy: { createdAt: "asc" },
      include: { nodes: true, edges: true },
    });
    if (!wf) {
      return NextResponse.json(
        { error: "No workflow exists" },
        { status: 404 },
      );
    }

    const nodes = wf.nodes.map(toNodeDTO);
    const edges = wf.edges.map(toEdgeDTO);
    const order = topologicalOrder(nodes, edges);
    if (!order) {
      return NextResponse.json(
        { error: "Workflow has a cycle" },
        { status: 400 },
      );
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
      if (
        nodeRow.status !== "pending" &&
        nodeRow.status !== "idle"
      ) {
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
        where: { id: wf.id },
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
        wf.id,
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

    return NextResponse.json({
      started: startedCount,
      completed: completedCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
