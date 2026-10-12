// GET /api/skills/insights — K1 aggregate analytics over the audit table.
//
// The Activity tab serves the RAW newest-first stream; this endpoint serves
// the OPERATIONAL view the roadmap called out: success rates, P50/P95
// latency, denied/invalid/limited trends — per skill, per agent, per lane.
//
//   GET /api/skills/insights?window=24h|7d|30d|all   (default 7d)
//
// Aggregation is computed in-process over the window's rows (SQLite has no
// percentile natives; the audit table is small and indexed on createdAt).
// Honest caps: rows beyond the LATEST 20,000 in the window are excluded and
// flagged via `truncated` — the numbers describe the newest slice, never a
// silently wrong total. Latency percentiles are computed over EXECUTED rows
// only (ok + error) — denied/invalid/limited/skipped/queued never measured
// a handler, so counting their ~0ms durations would fake a fast P50.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
// Barrel import — self-registers the catalog (side effect, #40).
import { catalogEntries } from "@/lib/skills";

export const dynamic = "force-dynamic";

const WINDOWS: Record<string, number | null> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  all: null,
};

const ROW_CAP = 20_000;

export interface InsightStatusCounts {
  ok: number;
  error: number;
  denied: number;
  invalid: number;
  skipped: number;
  limited: number;
  queued: number;
  cancelled: number;
}

export interface SkillInsight {
  skillId: string;
  label: string | null;
  family: string | null;
  count: number;
  byStatus: InsightStatusCounts;
  executed: number;
  okRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  lastUsedAt: string | null;
}

export interface AgentInsight {
  agentId: string;
  agentTitle: string;
  count: number;
  denied: number;
  limited: number;
  lastUsedAt: string | null;
}

export interface SourceInsight {
  source: string;
  count: number;
  byStatus: InsightStatusCounts;
}

export interface InsightsResponse {
  window: string;
  windowMs: number | null;
  truncated: boolean;
  generatedAt: string;
  totals: {
    invocations: number;
    byStatus: InsightStatusCounts;
    executed: number;
    okRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
  };
  skills: SkillInsight[];
  agents: AgentInsight[];
  sources: SourceInsight[];
}

function emptyCounts(): InsightStatusCounts {
  return {
    ok: 0,
    error: 0,
    denied: 0,
    invalid: 0,
    skipped: 0,
    limited: 0,
    queued: 0,
    cancelled: 0,
  };
}

function bump(counts: InsightStatusCounts, status: string): void {
  if (status in counts) {
    counts[status as keyof InsightStatusCounts] += 1;
  }
}

/** Nearest-rank percentile over a SORTED ascending number array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function latencyStats(durations: number[]): {
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
} {
  if (durations.length === 0) {
    return { p50Ms: null, p95Ms: null, avgMs: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
  };
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("window") ?? "7d";
  const window = raw in WINDOWS ? raw : "7d";
  const windowMs = WINDOWS[window];

  const where =
    windowMs != null
      ? { createdAt: { gte: new Date(Date.now() - windowMs) } }
      : {};

  // Newest-first take = the LATEST ROW_CAP rows (honest truncation); we then
  // reverse so lastUsedAt tracking and percentile order behave naturally.
  const rows = await db.skillInvocation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: ROW_CAP,
    select: {
      skillId: true,
      source: true,
      agentId: true,
      agentTitle: true,
      status: true,
      durationMs: true,
      createdAt: true,
    },
  });
  const truncated = rows.length === ROW_CAP;
  rows.reverse();

  const catalog = new Map(
    catalogEntries().map((s) => [s.id, { label: s.label, family: s.family }]),
  );

  // ── totals ─────────────────────────────────────────────────────────────
  const byStatus = emptyCounts();
  const executedDurations: number[] = [];
  let lastUsedAt: Date | null = null;
  for (const r of rows) {
    bump(byStatus, r.status);
    if (r.status === "ok" || r.status === "error") {
      if (typeof r.durationMs === "number") {
        executedDurations.push(r.durationMs);
      }
    }
    if (!lastUsedAt || r.createdAt > lastUsedAt) lastUsedAt = r.createdAt;
  }
  const executed = byStatus.ok + byStatus.error;
  void lastUsedAt; // (kept for future "as of" semantics; totals don't need it)

  // ── per skill ──────────────────────────────────────────────────────────
  const skillMap = new Map<
    string,
    { counts: InsightStatusCounts; durations: number[]; last: Date | null }
  >();
  for (const r of rows) {
    let agg = skillMap.get(r.skillId);
    if (!agg) {
      agg = { counts: emptyCounts(), durations: [], last: null };
      skillMap.set(r.skillId, agg);
    }
    bump(agg.counts, r.status);
    if (r.status === "ok" || r.status === "error") {
      if (typeof r.durationMs === "number") agg.durations.push(r.durationMs);
    }
    if (!agg.last || r.createdAt > agg.last) agg.last = r.createdAt;
  }
  const skills: SkillInsight[] = [...skillMap.entries()]
    .map(([skillId, agg]) => {
      const executed = agg.counts.ok + agg.counts.error;
      const stats = latencyStats(agg.durations);
      const meta = catalog.get(skillId);
      return {
        skillId,
        label: meta?.label ?? null,
        family: meta?.family ?? null,
        count: agg.counts.ok +
          agg.counts.error +
          agg.counts.denied +
          agg.counts.invalid +
          agg.counts.skipped +
          agg.counts.limited +
          agg.counts.queued +
          agg.counts.cancelled,
        byStatus: agg.counts,
        executed,
        okRate: executed > 0 ? agg.counts.ok / executed : null,
        ...stats,
        lastUsedAt: agg.last ? agg.last.toISOString() : null,
      };
    })
    .sort((a, b) => b.count - a.count || a.skillId.localeCompare(b.skillId))
    .slice(0, 12);

  // ── per agent ──────────────────────────────────────────────────────────
  const agentMap = new Map<
    string,
    { title: string; count: number; denied: number; limited: number; last: Date | null }
  >();
  for (const r of rows) {
    if (!r.agentId) continue;
    let agg = agentMap.get(r.agentId);
    if (!agg) {
      agg = { title: r.agentTitle ?? "(deleted agent)", count: 0, denied: 0, limited: 0, last: null };
      agentMap.set(r.agentId, agg);
    }
    agg.count += 1;
    if (r.status === "denied") agg.denied += 1;
    if (r.status === "limited") agg.limited += 1;
    if (!agg.last || r.createdAt > agg.last) agg.last = r.createdAt;
  }
  const agents: AgentInsight[] = [...agentMap.entries()]
    .map(([agentId, agg]) => ({
      agentId,
      agentTitle: agg.title,
      count: agg.count,
      denied: agg.denied,
      limited: agg.limited,
      lastUsedAt: agg.last ? agg.last.toISOString() : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // ── per source (lane) ──────────────────────────────────────────────────
  const sourceMap = new Map<string, InsightStatusCounts>();
  for (const r of rows) {
    let counts = sourceMap.get(r.source);
    if (!counts) {
      counts = emptyCounts();
      sourceMap.set(r.source, counts);
    }
    bump(counts, r.status);
  }
  const sources: SourceInsight[] = [...sourceMap.entries()]
    .map(([source, counts]) => ({
      source,
      count:
        counts.ok + counts.error + counts.denied + counts.invalid +
        counts.skipped + counts.limited + counts.queued + counts.cancelled,
      byStatus: counts,
    }))
    .sort((a, b) => b.count - a.count);

  const stats = latencyStats(executedDurations);
  const response: InsightsResponse = {
    window,
    windowMs,
    truncated,
    generatedAt: new Date().toISOString(),
    totals: {
      invocations: rows.length,
      byStatus,
      executed,
      okRate: executed > 0 ? byStatus.ok / executed : null,
      ...stats,
    },
    skills,
    agents,
    sources,
  };

  return NextResponse.json(response);
}
