// POST /api/workflow/nodes — create a Node.
//
// Target workflow resolution:
//   - body.workflowId present (multi-workflow switcher) → the node is created
//     in THAT workflow; 404 when the id doesn't exist.
//   - absent → the legacy default: the FIRST workflow (oldest by createdAt
//     asc), so pre-switcher clients keep working unchanged.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO, resolveTargetWorkflow } from "@/lib/workflow-engine";

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
      sweepGroup,
    } = body ?? {};

    if (typeof type !== "string" || typeof name !== "string") {
      return NextResponse.json(
        { error: "type and name are required" },
        { status: 400 },
      );
    }

    // Resolve the target workflow (explicit workflowId → that one, else the
    // first workflow by createdAt asc). 404 when an explicit id is missing.
    const target = await resolveTargetWorkflow(workflowId);
    if (!target.ok) {
      return NextResponse.json(
        { error: target.error },
        { status: target.status },
      );
    }

    const paramsJson =
      params && typeof params === "object"
        ? JSON.stringify(params)
        : "{}";

    // Optional sweep-group linkage — undo/redo replays a sweep batch through
    // this endpoint and the restored variants must land back in their group
    // (compare view + one-click campaign resolve by sweepGroup). Plain string
    // trim + length cap only: the id is opaque to this route.
    const sweepGroupId =
      typeof sweepGroup === "string" && sweepGroup.trim()
        ? sweepGroup.trim().slice(0, 64)
        : null;

    const node = await db.node.create({
      data: {
        workflowId: target.workflow.id,
        type,
        name,
        refId: typeof refId === "string" ? refId : null,
        x: typeof x === "number" ? x : 0,
        y: typeof y === "number" ? y : 0,
        status: "idle",
        progress: 0,
        params: paramsJson,
        sweepGroup: sweepGroupId,
      },
    });

    return NextResponse.json(toNodeDTO(node));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
