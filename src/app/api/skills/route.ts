// GET /api/skills — the skill catalog + per-skill invocation stats.
//
// Serves the Skills panel and any surface that needs to know what the agent
// layer can do. The registry is the source of truth; stats aggregate the
// SkillInvocation audit table (counts by status, avg duration).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
// Import the full skill layer (index registers all implementations).
import { listSkills } from "@/lib/skills";

export async function GET() {
  const skills = listSkills().map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    gate: s.gate,
    description: s.description,
    timeoutMs: s.timeoutMs,
    params: s.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: !!p.required,
      default: p.default ?? null,
      enumValues: p.enumValues ?? null,
      min: p.min ?? null,
      max: p.max ?? null,
      description: p.description,
    })),
    exampleLine: s.exampleLine(),
  }));

  // Per-skill stats from the audit table (missing table → zeroed).
  const stats = new Map<
    string,
    { invocations: number; completed: number; failed: number; timeout: number; denied: number; avgMs: number }
  >();
  try {
    const grouped = await db.skillInvocation.groupBy({
      by: ["skillId"],
      _count: { _all: true },
      _avg: { durationMs: true },
    });
    const byStatus = await db.skillInvocation.groupBy({
      by: ["skillId", "status"],
      _count: { _all: true },
    });
    for (const g of grouped) {
      stats.set(g.skillId, {
        invocations: g._count._all,
        completed: 0,
        failed: 0,
        timeout: 0,
        denied: 0,
        avgMs: Math.round(g._avg.durationMs ?? 0),
      });
    }
    for (const b of byStatus) {
      const entry = stats.get(b.skillId);
      if (!entry) continue;
      if (b.status === "completed") entry.completed = b._count._all;
      else if (b.status === "failed") entry.failed = b._count._all;
      else if (b.status === "timeout") entry.timeout = b._count._all;
      else if (b.status === "denied") entry.denied = b._count._all;
    }
  } catch {
    // Fresh DB / table missing — catalog still serves with zeroed stats.
  }

  return NextResponse.json({
    skills: skills.map((s) => ({ ...s, stats: stats.get(s.id) ?? null })),
  });
}
