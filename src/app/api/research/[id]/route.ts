import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toResearchDTO } from "../route";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  try {
    const row = await db.researchReport.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: "Research report not found" }, { status: 404 });
    }
    return NextResponse.json(toResearchDTO(row));
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to fetch research report", detail: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  try {
    const existing = await db.researchReport.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Research report not found" }, { status: 404 });
    }
    await db.researchReport.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to delete research report", detail: (e as Error).message },
      { status: 500 },
    );
  }
}
