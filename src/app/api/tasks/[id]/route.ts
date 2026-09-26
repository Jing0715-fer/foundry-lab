// Single-task API — fetch + delete.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toTaskDTO } from "../route";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await db.task.findUnique({ where: { id } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json(toTaskDTO(task));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch task", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await db.task.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to delete task", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
