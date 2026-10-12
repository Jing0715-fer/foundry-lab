// GET /api/skills/invocations — recent skill invocations (audit feed).
//
// Query params:
//   ?agentId=<id>   filter by agent
//   ?limit=<n>      1–200, default 50

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId")?.trim() || undefined;
  let limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  if (!Number.isFinite(limit)) limit = 50;
  limit = Math.min(200, Math.max(1, Math.floor(limit)));

  const rows = await db.skillInvocation.findMany({
    where: agentId ? { agentId } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillName: r.skillName,
      category: r.category,
      caller: r.caller,
      agentId: r.agentId,
      agentTitle: r.agentTitle,
      status: r.status,
      durationMs: r.durationMs,
      params: safeJson(r.params),
      resultSummary: r.resultSummary,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
