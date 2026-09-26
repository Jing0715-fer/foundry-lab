// Tasks API — list + create.
// DTO mapper for Task is defined here and imported by [id] and [id]/run routes
// to keep it private to the tasks routes (no shared dto.ts to avoid 5-d conflicts).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { TaskDTO, TaskType, RunStatus } from "@/lib/types";

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function toTaskDTO(t: {
  id: string;
  title: string;
  prompt: string;
  taskType: string;
  agentIds: string | null;
  status: string;
  result: string | null;
  logs: string;
  tags: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): TaskDTO {
  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    taskType: t.taskType as TaskType,
    agentIds: parseJsonArray(t.agentIds),
    status: t.status as RunStatus,
    result: t.result,
    logs: t.logs ?? "",
    tags: parseJsonArray(t.tags),
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : new Date(t.createdAt).toISOString(),
    startedAt: t.startedAt ? (t.startedAt instanceof Date ? t.startedAt.toISOString() : new Date(t.startedAt).toISOString()) : null,
    completedAt: t.completedAt ? (t.completedAt instanceof Date ? t.completedAt.toISOString() : new Date(t.completedAt).toISOString()) : null,
  };
}

export async function GET() {
  try {
    const tasks = await db.task.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json(tasks.map(toTaskDTO));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list tasks", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!title || !prompt) {
    return NextResponse.json(
      { error: "title and prompt are required" },
      { status: 400 },
    );
  }

  const taskType =
    typeof body.taskType === "string" && body.taskType ? body.taskType : "general";
  const agentIds = Array.isArray(body.agentIds)
    ? body.agentIds.map(String)
    : [];
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

  try {
    const created = await db.task.create({
      data: {
        title,
        prompt,
        taskType,
        agentIds: JSON.stringify(agentIds),
        tags: JSON.stringify(tags),
        status: "queued",
      },
    });
    return NextResponse.json(toTaskDTO(created), { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create task", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
