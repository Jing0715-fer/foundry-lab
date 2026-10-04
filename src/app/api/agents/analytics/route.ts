import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/agents/analytics — per-agent usage stats.
 *
 * Returns `{ agents: AgentAnalytics[] }` where each entry aggregates:
 *   - chatMessages  : count of ChatMessage rows for this agent
 *   - toolJobs      : count of ToolJob rows whose `agentId` matches
 *   - workflowNodes : count of Node rows where type='agent' and refId=agentId
 */
export async function GET() {
  const agents = await db.agent.findMany({
    orderBy: { createdAt: "asc" },
  });

  // Count chat messages per agent.
  const chatCounts = await db.chatMessage.groupBy({
    by: ["agentId"],
    _count: { id: true },
  });
  const chatMap = new Map(chatCounts.map((c) => [c.agentId, c._count.id]));

  // Count tool jobs triggered by each agent — GROUP BY agentId instead of
  // loading the whole ToolJob table (stdout/logs per row can be megabytes;
  // the old full findMany pulled every byte just to count).
  // (The schema has an `agentId` column on ToolJob — we use it directly
  // rather than parsing the `triggeredBy` string, which is a display label
  // like "agent:Atlas" — it would otherwise need an extra title→id lookup.)
  const jobCounts = await db.toolJob.groupBy({
    by: ["agentId"],
    _count: { id: true },
    where: { agentId: { not: null } },
  });
  const agentJobCounts = new Map<string, number>();
  for (const c of jobCounts) {
    if (c.agentId) agentJobCounts.set(c.agentId, c._count.id);
  }

  // Count workflow nodes referencing each agent (refId) — projection query:
  // only the refId column, never stdout/logs/result payloads.
  const nodes = await db.node.findMany({
    where: { type: "agent" },
    select: { refId: true },
  });
  const nodeCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.refId) {
      nodeCounts.set(n.refId, (nodeCounts.get(n.refId) ?? 0) + 1);
    }
  }

  const analytics = agents.map((a) => ({
    agentId: a.id,
    title: a.title,
    color: a.color,
    icon: a.icon,
    chatMessages: chatMap.get(a.id) ?? 0,
    toolJobs: agentJobCounts.get(a.id) ?? 0,
    workflowNodes: nodeCounts.get(a.id) ?? 0,
    isBuiltin: a.builtin,
  }));

  return NextResponse.json({ agents: analytics });
}
