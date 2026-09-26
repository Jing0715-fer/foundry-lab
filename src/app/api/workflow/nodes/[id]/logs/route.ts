// GET /api/workflow/nodes/[id]/logs — return the node's logs string.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const node = await db.node.findUnique({
      where: { id },
      select: { logs: true },
    });
    if (!node) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }
    return NextResponse.json({ logs: node.logs ?? "" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
