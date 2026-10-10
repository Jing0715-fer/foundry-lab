// GET /api/skills — the skill registry catalog.
//
// Serves the serializable SkillCatalogEntry[] projection (no handlers cross
// the wire). Optional ?agentId= resolves per-skill eligibility against that
// agent's knowledge flags — the SAME rule runSkill enforces at execution
// time, so the UI can never display a capability the executor would deny.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { catalogEntries } from "@/lib/skills";
import { parseKnowledge } from "@/lib/run-utils";
import type { SkillCatalogEntry } from "@/lib/skills/types";

export const dynamic = "force-dynamic";

export interface SkillCatalogResponse {
  skills: (SkillCatalogEntry & { eligible?: boolean })[];
  agentId?: string;
}

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;

  let knowledge: { webSearchEnabled: boolean; bioToolsEnabled: boolean } | null = null;
  if (agentId) {
    const row = await db.agent.findUnique({ where: { id: agentId } });
    if (!row) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    knowledge = parseKnowledge(row.knowledge);
  }

  const skills = catalogEntries().map((s) => ({
    ...s,
    ...(knowledge
      ? { eligible: s.requires.every((r) => knowledge![r] === true) }
      : {}),
  }));

  return NextResponse.json({
    skills,
    ...(agentId ? { agentId } : {}),
  } as SkillCatalogResponse);
}
