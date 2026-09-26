import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO } from "@/lib/run-utils";
import { DEFAULT_KNOWLEDGE } from "@/lib/agents";
import type { AgentKnowledgeConfig } from "@/lib/types";

/** GET /api/agents — list all agents as AgentDTO[]. */
export async function GET() {
  const rows = await db.agent.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map(toAgentDTO));
}

/** POST /api/agents — create a new agent. */
export async function POST(request: Request) {
  let body: {
    title?: string;
    expertise?: string;
    goal?: string;
    role?: string;
    model?: string;
    color?: string;
    icon?: string;
    knowledge?: AgentKnowledgeConfig;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { title, expertise, goal, role, model, color, icon, knowledge } = body;

  if (!title || !expertise || !goal || !role) {
    return NextResponse.json(
      { error: "title, expertise, goal, and role are required" },
      { status: 400 },
    );
  }

  const created = await db.agent.create({
    data: {
      title,
      expertise,
      goal,
      role,
      model: model ?? "default",
      color: color ?? "#10b981",
      icon: icon ?? "bot",
      knowledge: JSON.stringify(knowledge ?? DEFAULT_KNOWLEDGE),
      builtin: false,
    },
  });

  return NextResponse.json(toAgentDTO(created), { status: 201 });
}
