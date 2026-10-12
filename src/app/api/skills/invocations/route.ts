// GET /api/skills/invocations — the unified agent-operation audit log.
//
// Query: ?limit=50&cursor=<id>&skillId=&source=&agentId=&status= — all
// optional filters. Returns newest-first SkillInvocation rows (every agent
// operation in the system lands here: chat, chat-stream, workflow, canvas,
// api, task, meeting, research lanes).
//
// M2 (K6) — cursor pagination: the Activity tab grew "Load more" + filters,
// so the endpoint is now keyset-paginated over a deterministic total order
// (createdAt DESC, id DESC — the id tiebreak makes the order unique even
// when many rows share one timestamp). `cursor` is the id of the LAST row
// of the previous page; the next page is everything strictly after it in
// that order. The response carries `total` (rows matching the filters) and
// `nextCursor` (present iff another page exists) — offset-based paging
// would silently skip/duplicate rows as new invocations stream in.

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
const VALID_STATUSES = new Set([
  "ok",
  "error",
  "denied",
  "invalid",
  "skipped",
  // K lane additions.
  "limited",
  "queued",
  "cancelled",
]);

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

export interface InvocationsResponse {
  invocations: SkillInvocationDTO[];
  count: number;
  /** Rows matching the CURRENT filters (across all pages). */
  total: number;
  /** Present iff another page exists after this one. */
  nextCursor?: string;
  hasMore: boolean;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50) || 50, 1), 100);
  const cursorParam = sp.get("cursor");
  const skillId = sp.get("skillId") ?? undefined;
  const agentId = sp.get("agentId") ?? undefined;
  const source = sp.get("source") ?? undefined;
  const status = sp.get("status") ?? undefined;

  const where: Record<string, unknown> = {};
  if (skillId) where.skillId = skillId;
  if (agentId) where.agentId = agentId;
  if (source && VALID_SOURCES.has(source)) where.source = source;
  if (status && VALID_STATUSES.has(status)) where.status = status;

  // `total` always describes the FULL filter match (never the cursor's
  // remaining window) — the UI renders "X of Y invocations" and the
  // Load-more label from it, so shrinking it per page would read as rows
  // vanishing. The cursor only narrows the ROW FETCH below.
  const total = await db.skillInvocation.count({ where });

  // Keyset: translate the cursor row's (createdAt, id) into a strict
  // "after this row in (createdAt DESC, id DESC) order" predicate.
  const fetchWhere: Record<string, unknown> = { ...where };
  if (cursorParam) {
    const cursorRow = await db.skillInvocation.findUnique({
      where: { id: cursorParam },
      select: { createdAt: true },
    });
    if (!cursorRow) {
      return NextResponse.json(
        { error: `cursor "${cursorParam}" does not match any invocation row` },
        { status: 400 },
      );
    }
    fetchWhere.OR = [
      { createdAt: { lt: cursorRow.createdAt } },
      { createdAt: cursorRow.createdAt, id: { lt: cursorParam } },
    ];
  }

  // take limit+1 → the extra row only tells us a next page exists.
  const rows = await db.skillInvocation.findMany({
    where: fetchWhere,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

  const invocations: SkillInvocationDTO[] = page.map((r) => {
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

  return NextResponse.json({
    invocations,
    count: invocations.length,
    total,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  } as InvocationsResponse);
}
