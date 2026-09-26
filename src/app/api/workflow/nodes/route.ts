// POST /api/workflow/nodes — create a Node in the first workflow.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO } from "@/lib/workflow-engine";

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
    } = body ?? {};

    if (typeof type !== "string" || typeof name !== "string") {
      return NextResponse.json(
        { error: "type and name are required" },
        { status: 400 },
      );
    }

    const wf = await db.workflow.findFirst({ orderBy: { createdAt: "asc" } });
    if (!wf) {
      return NextResponse.json(
        { error: "No workflow exists" },
        { status: 404 },
      );
    }

    const paramsJson =
      params && typeof params === "object"
        ? JSON.stringify(params)
        : "{}";

    const node = await db.node.create({
      data: {
        workflowId: wf.id,
        type,
        name,
        refId: typeof refId === "string" ? refId : null,
        x: typeof x === "number" ? x : 0,
        y: typeof y === "number" ? y : 0,
        status: "idle",
        progress: 0,
        params: paramsJson,
      },
    });

    return NextResponse.json(toNodeDTO(node));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
