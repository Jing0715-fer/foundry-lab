import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PREDEFINED_AGENTS } from "@/lib/agents";

/** POST /api/seed — idempotently seed builtin agents + a default workflow. */
export async function POST() {
  // 1. Upsert predefined agents by title.
  let agents = 0;
  for (const tpl of PREDEFINED_AGENTS) {
    await db.agent.upsert({
      where: { title: tpl.title },
      create: {
        title: tpl.title,
        expertise: tpl.expertise,
        goal: tpl.goal,
        role: tpl.role,
        icon: tpl.icon,
        color: tpl.color,
        knowledge: JSON.stringify(tpl.knowledge),
        builtin: true,
      },
      update: {}, // skip if exists — leave user edits untouched
    });
    agents++;
  }

  // 2. Ensure a default workflow exists.
  let workflowId: string;
  const count = await db.workflow.count();
  if (count === 0) {
    const wf = await db.workflow.create({
      data: { name: "My First Workflow" },
    });
    workflowId = wf.id;
  } else {
    const first = await db.workflow.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    workflowId = first?.id ?? "";
  }

  return NextResponse.json({ agents, workflow: workflowId });
}
