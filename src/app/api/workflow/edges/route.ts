// POST /api/workflow/edges — create an Edge in the first workflow.
// Validates: both nodes exist + same workflow, no cycle, no duplicate.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toEdgeDTO } from "@/lib/workflow-engine";
import { wouldCreateCycle } from "@/lib/canvas-utils";
import { randomUUID } from "crypto";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      fromNodeId,
      toNodeId,
      fromPort,
      toPort,
      id,
    } = body ?? {};

    if (typeof fromNodeId !== "string" || typeof toNodeId !== "string") {
      return NextResponse.json(
        { error: "fromNodeId and toNodeId are required" },
        { status: 400 },
      );
    }

    const [fromNode, toNode] = await Promise.all([
      db.node.findUnique({ where: { id: fromNodeId } }),
      db.node.findUnique({ where: { id: toNodeId } }),
    ]);
    if (!fromNode || !toNode) {
      return NextResponse.json(
        { error: "Source or target node does not exist" },
        { status: 400 },
      );
    }
    if (fromNode.workflowId !== toNode.workflowId) {
      return NextResponse.json(
        { error: "Nodes belong to different workflows" },
        { status: 400 },
      );
    }
    if (fromNodeId === toNodeId) {
      return NextResponse.json(
        { error: "Self-loops are not allowed" },
        { status: 400 },
      );
    }

    const workflowId = fromNode.workflowId;
    const existingEdges = await db.edge.findMany({ where: { workflowId } });

    // Duplicate check (same from/to/ports).
    const dup = existingEdges.some(
      (e) =>
        e.fromNodeId === fromNodeId &&
        e.toNodeId === toNodeId &&
        (e.fromPort ?? null) === (fromPort ?? null) &&
        (e.toPort ?? null) === (toPort ?? null),
    );
    if (dup) {
      return NextResponse.json(
        { error: "Duplicate edge already exists" },
        { status: 400 },
      );
    }

    // Cycle check.
    if (
      wouldCreateCycle(
        existingEdges.map((e) => ({
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
        })),
        fromNodeId,
        toNodeId,
      )
    ) {
      return NextResponse.json(
        { error: "Edge would create a cycle" },
        { status: 400 },
      );
    }

    const edgeId =
      typeof id === "string" && id.length > 0 ? id : randomUUID();

    const edge = await db.edge.create({
      data: {
        id: edgeId,
        workflowId,
        fromNodeId,
        toNodeId,
        fromPort: typeof fromPort === "string" ? fromPort : null,
        toPort: typeof toPort === "string" ? toPort : null,
      },
    });

    return NextResponse.json(toEdgeDTO(edge));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
