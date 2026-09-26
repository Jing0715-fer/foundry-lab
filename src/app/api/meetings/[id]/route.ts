import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toMeetingDTO } from "../route";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  try {
    const row = await db.meeting.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }
    return NextResponse.json(toMeetingDTO(row));
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to fetch meeting", detail: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  try {
    const existing = await db.meeting.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }
    await db.meeting.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to delete meeting", detail: (e as Error).message },
      { status: 500 },
    );
  }
}
