// M2 (K6) — SkillInvocation retention (SQLite size governance).
//
// The audit table grows one row per agent operation (a single QA round
// accumulated 45; real use grows it much faster), and every row carries a
// params JSON blob — unbounded growth eventually degrades the very queries
// the observability surface runs. Retention is two orthogonal policies,
// both DELIBERATELY conservative:
//
//   1. AGE — terminal rows older than maxAgeDays (default 90) are deleted.
//      `queued` rows are never touched by ANY policy: their owning
//      background executor may still land them (instrumentation's boot
//      sweep is the only thing that honestly fails orphans).
//   2. CAP — beyond the newest rowCap rows (default 20,000, matching the
//      insights ROW_CAP so the aggregate window and the retention floor
//      agree on "how much history matters"), the OLDEST terminal rows are
//      trimmed to the cap.
//
// The two candidate sets are provably disjoint AND share one predicate
// shape, so the dry-run numbers are exactly the numbers a delete produces
// (no separate estimate path that can drift):
//
//   age candidates : status != queued AND createdAt <  cutoff
//   cap candidates : status != queued AND createdAt >= cutoff  (oldest-first)
//
// (After the age pass deletes every terminal row below the cutoff, every
// remaining terminal row is cap-eligible — the dry run mirrors that by
// construction.) Cap trimming only ever removes terminal rows; a flood of
// live `queued` rows occupying the overflow window shrinks what CAN be
// trimmed, never silently over-deletes.

import { db } from "@/lib/db";

export const RETENTION_DEFAULT_MAX_AGE_DAYS = 90;
export const RETENTION_HARD_ROW_CAP = 20_000;

/** Never delete a queued row — its executor may still be running. */
const PROTECTED_STATUS = "queued";

export interface RetentionDecision {
  maxAgeDays: number;
  rowCap: number;
  cutoffAt: string;
  totalRows: number;
  /** Terminal rows older than the cutoff (policy 1). */
  agedOut: number;
  /** Additional oldest terminal rows beyond the cap (policy 2). */
  overCap: number;
  /** agedOut + overCap — the exact set a delete would remove. */
  deletable: number;
  /** Rows the DELETE actually removed (apply mode; 0 in dry-run). */
  applied: number;
}

/** Compute (and optionally execute) the retention decision.
 *  Defaults mirror the constants above; the API validates its own bounds
 *  before calling — this function clamps defensively anyway. */
export async function runRetention(
  opts: {
    maxAgeDays?: number;
    rowCap?: number;
    dryRun?: boolean;
  } = {},
): Promise<RetentionDecision> {
  const maxAgeDays = clampInt(
    opts.maxAgeDays ?? RETENTION_DEFAULT_MAX_AGE_DAYS,
    1,
    3650,
  );
  const rowCap = clampInt(opts.rowCap ?? RETENTION_HARD_ROW_CAP, 100, 1_000_000);
  const dryRun = opts.dryRun !== false;
  const cutoffAt = new Date(Date.now() - maxAgeDays * 24 * 3600_000);

  const totalRows = await db.skillInvocation.count();

  // Policy 1 — terminal rows aged out.
  const agedWhere = {
    createdAt: { lt: cutoffAt },
    status: { not: PROTECTED_STATUS },
  };
  const agedOut = await db.skillInvocation.count({ where: agedWhere });

  // Policy 2 — cap overflow among the rows age keeps. Kept = total minus
  // aged-out (protected queued rows are always kept by the age pass).
  const keptByAge = Math.max(0, totalRows - agedOut);
  const overflow = Math.max(0, keptByAge - rowCap);
  let overCap = 0;
  if (overflow > 0) {
    // Terminal rows kept by age (createdAt >= cutoff), oldest-first —
    // exactly the post-age-pass candidate list the apply walk uses.
    const candidates = await db.skillInvocation.findMany({
      where: { status: { not: PROTECTED_STATUS }, createdAt: { gte: cutoffAt } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: overflow,
      select: { id: true },
    });
    overCap = candidates.length;
  }

  const decision: RetentionDecision = {
    maxAgeDays,
    rowCap,
    cutoffAt: cutoffAt.toISOString(),
    totalRows,
    agedOut,
    overCap,
    deletable: agedOut + overCap,
    applied: 0,
  };

  if (dryRun) return decision;

  // Apply — age pass (one bulk delete), then the cap pass over the REAL
  // post-age remaining set (id-list delete, oldest terminal rows first).
  const ageDelete = await db.skillInvocation.deleteMany({ where: agedWhere });
  let capDelete = 0;
  const remaining = await db.skillInvocation.count();
  if (remaining > rowCap) {
    const realOverflow = remaining - rowCap;
    const victims = await db.skillInvocation.findMany({
      where: { status: { not: PROTECTED_STATUS } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: realOverflow,
      select: { id: true },
    });
    if (victims.length > 0) {
      const res = await db.skillInvocation.deleteMany({
        where: { id: { in: victims.map((v) => v.id) } },
      });
      capDelete = res.count;
    }
  }
  decision.applied = ageDelete.count + capDelete;
  return decision;
}

/** Boot sweep with the defaults (instrumentation) — best-effort, log-only. */
export async function sweepRetentionOnBoot(): Promise<void> {
  const decision = await runRetention({ dryRun: false });
  if (decision.applied > 0) {
    console.log(
      `[instrumentation] skill-audit retention: pruned ${decision.applied} row(s) ` +
        `(${decision.agedOut} aged-out + ${decision.overCap} over-cap; ` +
        `${decision.totalRows} rows before)`,
    );
  }
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}
