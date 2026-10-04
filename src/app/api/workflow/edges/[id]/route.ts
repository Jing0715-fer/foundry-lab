// DELETE /api/workflow/edges/[id] — delete an edge.
// A missing id surfaces as an honest 404 (Prisma P2025) instead of a raw 500.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await db.edge.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P2025 = "Record to delete does not exist" → honest 404, not a 500.
    if ((e as { code?: string }).code === "P2025") {
      return NextResponse.json(
        { error: "Edge not found" },
        { status: 404 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
