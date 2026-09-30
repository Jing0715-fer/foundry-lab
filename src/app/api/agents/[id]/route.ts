import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO } from "@/lib/run-utils";
import type { AgentKnowledgeConfig, AgentRuntimeConfig } from "@/lib/types";

/** GET /api/agents/:id — fetch one agent as AgentDTO. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await db.agent.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(toAgentDTO(row));
}

/** PUT /api/agents/:id — update any subset of agent fields. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existing = await db.agent.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  let body: {
    title?: string;
    expertise?: string;
    goal?: string;
    role?: string;
    model?: string;
    color?: string;
    icon?: string;
    knowledge?: AgentKnowledgeConfig;
    runtime?: AgentRuntimeConfig;
    builtin?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  for (const key of [
    "title",
    "expertise",
    "goal",
    "role",
    "model",
    "color",
    "icon",
    "builtin",
  ] as const) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  if (body.knowledge !== undefined) {
    data.knowledge = JSON.stringify(body.knowledge);
  }
  // Runtime settings (fine-tune dialog) — persisted as JSON and applied by
  // runAgentTurn / the chat-stream lane as the agent's sampling defaults.
  if (body.runtime !== undefined) {
    data.runtime = JSON.stringify(body.runtime);
  }

  const updated = await db.agent.update({ where: { id }, data });
  return NextResponse.json(toAgentDTO(updated));
}

/** DELETE /api/agents/:id — delete agent (cascades chat messages). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await db.agent.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
