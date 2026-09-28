import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PREDEFINED_AGENTS } from "@/lib/agents";

/** Node types from the removed comp-tool system — migrated to "alphafold". */
const LEGACY_COMP_NODE_TYPES = [
  "comptool",
  "rfdiffusion",
  "rfantibody",
  "proteinmpnn",
  "ligandmpnn",
  "solublempnn",
  "rosetta",
  "pyrosetta",
  "rf3",
  "esmfold",
  "colabfold",
];

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

  // 3. Comp-tool removal migration: every legacy comp-tool node becomes an
  //    "alphafold" node (the single prediction tool that replaced them).
  let migratedNodes = 0;
  try {
    const res = await db.node.updateMany({
      where: { type: { in: LEGACY_COMP_NODE_TYPES } },
      data: { type: "alphafold" },
    });
    migratedNodes = res.count;
  } catch {
    /* best-effort — old rows keep their type and render as unknown nodes */
  }

  // 4. Drop stale jobs from the removed comp tools (their tool badges and
  //    re-run affordances no longer exist). AlphaFold history is kept.
  let prunedJobs = 0;
  try {
    const res = await db.toolJob.deleteMany({
      where: {
        tool: { in: ["comptool", ...LEGACY_COMP_NODE_TYPES] },
      },
    });
    prunedJobs = res.count;
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ agents, workflow: workflowId, migratedNodes, prunedJobs });
}
