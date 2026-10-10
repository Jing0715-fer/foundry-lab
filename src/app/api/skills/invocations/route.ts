// GET /api/skills/invocations — the unified agent-operation audit log.
//
// Query: ?limit=50&skillId=&source=&agentId=&status= — all optional filters.
// Returns newest-first SkillInvocation rows (every agent operation in the
// system lands here: chat, chat-stream, workflow, canvas, api, task,
// meeting, research lanes).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const VALID_SOURCES = new Set([
  "chat",
  "chat-stream",
  "workflow",
  "canvas",
  "api",
  "task",
  "meeting",
  "research",
]);
const VALID_STATUSES = new Set(["ok", "error", "denied", "invalid", "skipped"]);

export interface SkillInvocationDTO {
  id: string;
  skillId: string;
  source: string;
  agentId: string | null;
  agentTitle: string | null;
  workflowId: string | null;
  nodeId: string | null;
  status: string;
  params: Record<string, unknown>;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50) || 50, 1), 200);
  const skillId = sp.get("skillId") ?? undefined;
  const agentId = sp.get("agentId") ?? undefined;
  const source = sp.get("source") ?? undefined;
  const status = sp.get("status") ?? undefined;

  const where: Record<string, unknown> = {};
  if (skillId) where.skillId = skillId;
  if (agentId) where.agentId = agentId;
  if (source && VALID_SOURCES.has(source)) where.source = source;
  if (status && VALID_STATUSES.has(status)) where.status = status;

  const rows = await db.skillInvocation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const invocations: SkillInvocationDTO[] = rows.map((r) => {
    let params: Record<string, unknown> = {};
    try {
      params = r.params ? JSON.parse(r.params) : {};
    } catch {
      params = {};
    }
    return {
      id: r.id,
      skillId: r.skillId,
      source: r.source,
      agentId: r.agentId,
      agentTitle: r.agentTitle,
      workflowId: r.workflowId,
      nodeId: r.nodeId,
      status: r.status,
      params,
      resultSummary: r.resultSummary,
      error: r.error,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ invocations, count: invocations.length });
}
