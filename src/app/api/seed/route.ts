import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PREDEFINED_AGENTS } from "@/lib/agents";
import { COMP_TOOLS } from "@/lib/tools";

/** The removed legacy generic comp-tool node type. Its nodes are migrated to
 *  the SPECIFIC tool they were configured with (node.params.toolKey) — the
 *  per-tool node types themselves are alive and well. */
const LEGACY_COMPTOOL_TYPE = "comptool";
const VALID_TOOL_TYPES = new Set<string>(COMP_TOOLS.map((t) => t.key));

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

  // 3. Legacy-node migration: every generic "comptool" node becomes the
  //    SPECIFIC per-tool node it was configured with (its params.toolKey);
  //    unknown tool keys fall back to "rfdiffusion" (the old default).
  //    Per-tool node types (rfdiffusion, proteinmpnn, …) and "alphafold"
  //    nodes are untouched — those types are current.
  let migratedNodes = 0;
  try {
    const legacyNodes = await db.node.findMany({
      where: { type: LEGACY_COMPTOOL_TYPE },
      select: { id: true, params: true },
    });
    for (const n of legacyNodes) {
      let toolKey: string = "rfdiffusion";
      try {
        const p =
          typeof n.params === "string" ? JSON.parse(n.params) : n.params;
        const k = String((p as Record<string, unknown>)?.toolKey ?? "");
        if (VALID_TOOL_TYPES.has(k)) toolKey = k;
      } catch {
        /* keep the default */
      }
      await db.node.update({ where: { id: n.id }, data: { type: toolKey } });
      migratedNodes++;
    }
  } catch {
    /* best-effort — old rows keep their type and render as unknown nodes */
  }

  // 4. Drop stale jobs from the removed generic comptool only (per-tool
  //    + alphafold job history is all still valid).
  let prunedJobs = 0;
  try {
    const res = await db.toolJob.deleteMany({
      where: { tool: LEGACY_COMPTOOL_TYPE },
    });
    prunedJobs = res.count;
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ agents, workflow: workflowId, migratedNodes, prunedJobs });
}

