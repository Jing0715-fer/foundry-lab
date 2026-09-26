// POST /api/workflow/nodes/[id]/run — run a SINGLE node, then cascade
// downstream nodes whose all-upstream are completed (BFS).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
  executeNode,
} from "@/lib/workflow-engine";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const startNode = await db.node.findUnique({ where: { id } });
    if (!startNode) {
      return NextResponse.json(
        { error: "Node not found" },
        { status: 404 },
      );
    }
    const workflowId = startNode.workflowId;

    // Helper: load fresh workflow snapshot.
    async function loadSnapshot() {
      const wf = await db.workflow.findUnique({
        where: { id: workflowId },
        include: { nodes: true, edges: true },
      });
      return {
        nodes: (wf?.nodes ?? []).map(toNodeDTO),
        edges: (wf?.edges ?? []).map(toEdgeDTO),
      };
    }

    // Run one node and persist result.
    async function runOne(nodeId: string): Promise<"completed" | "failed"> {
      const nodeRow = await db.node.findUnique({ where: { id: nodeId } });
      if (!nodeRow) return "failed";
      await db.node.update({
        where: { id: nodeId },
        data: {
          status: "running",
          progress: 10,
          startedAt: nodeRow.startedAt ?? new Date(),
        },
      });

      const { nodes, edges } = await loadSnapshot();
      const current = nodes.find((n) => n.id === nodeId);
      if (!current) {
        await db.node.update({
          where: { id: nodeId },
          data: { status: "failed", completedAt: new Date() },
        });
        return "failed";
      }
      const inputs = gatherInputs(nodeId, nodes, edges);
      const { result, logs, status } = await executeNode(
        current,
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
      return status;
    }

    // 1) Run the target node.
    await runOne(id);

    // 2) BFS cascade — repeatedly find pending/idle nodes whose ALL upstream
    //    nodes are now completed, and run them. Stop when no such node exists.
    let guard = 0;
    while (guard++ < 1000) {
      const { nodes, edges } = await loadSnapshot();
      const next = nodes.find((n) => {
        if (n.status !== "pending" && n.status !== "idle") return false;
        const upstreamIds = edges
          .filter((e) => e.toNodeId === n.id)
          .map((e) => e.fromNodeId);
        if (upstreamIds.length === 0) return false; // Don't auto-trigger unrelated nodes.
        return upstreamIds.every(
          (uid) =>
            nodes.find((x) => x.id === uid)?.status === "completed",
        );
      });
      if (!next) break;
      await runOne(next.id);
    }

    // 3) Return the updated target node DTO.
    const final = await db.node.findUnique({ where: { id } });
    if (!final) {
      return NextResponse.json(
        { error: "Node disappeared after run" },
        { status: 500 },
      );
    }
    return NextResponse.json(toNodeDTO(final));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
