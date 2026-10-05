// Scheduled-run sweeper — REAL persistence + REAL firing.
//
// Schedules live in the WorkflowSchedule table (status: scheduled | firing |
// fired | failed | cancelled). This module polls every SWEEP_INTERVAL_MS,
// claims due rows (runAt <= now, status = scheduled) by flipping them to
// `firing`, runs each workflow through the SAME execution lane as manual
// runs (runWorkflowById), and records fired/failed + counts.
//
// The sweeper is started once per server process from instrumentation.ts
// (Next.js register() hook) — it survives across requests and hot reloads
// via a globalThis guard.

import { db } from "@/lib/db";
import { runWorkflowById } from "@/lib/workflow-runner";

const SWEEP_INTERVAL_MS = 15_000;

const globalForScheduler = globalThis as unknown as {
  __foundryScheduleSweeper?: NodeJS.Timeout;
};

/** Start the sweeper loop (idempotent across HMR / multiple imports). */
export function startScheduleSweeper(): void {
  if (globalForScheduler.__foundryScheduleSweeper) return;
  const timer = setInterval(() => {
    void sweepDueSchedules().catch((e) => {
      console.error("[scheduler] sweep failed:", e instanceof Error ? e.message : e);
    });
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open just for the sweeper.
  timer.unref?.();
  globalForScheduler.__foundryScheduleSweeper = timer;
  console.log(
    `[scheduler] workflow schedule sweeper started (every ${SWEEP_INTERVAL_MS / 1000}s)`,
  );
  // Boot-time recovery: rows stuck in "firing" belong to a previous process
  // that crashed mid-run (the sweeper only writes a terminal status —
  // fired/failed — when the run finishes; firing alone means it never did).
  // This process has no in-flight fires yet, so reclaim them by flipping back
  // to "scheduled" — the next sweep re-fires them. ("scheduled" is the
  // claimable state; firedAt stays null so history isn't fabricated.)
  void db.workflowSchedule
    .updateMany({
      where: { status: "firing", firedAt: null },
      data: { status: "scheduled" },
    })
    .then((r) => {
      if (r.count > 0) {
        console.warn(
          `[scheduler] reclaimed ${r.count} schedule(s) stuck in "firing" (crashed mid-run) → re-queued as "scheduled"`,
        );
      }
    })
    .catch(() => {});
  // Sweep immediately on boot — a schedule whose runAt passed while the
  // server was down fires as soon as we come back up.
  void sweepDueSchedules().catch(() => {});
}

/** One pass: claim + fire every due schedule. */
async function sweepDueSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.workflowSchedule.findMany({
    where: { status: "scheduled", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: 5, // bounded per sweep — long workflows shouldn't starve the loop
  });
  for (const s of due) {
    // Claim atomically: only proceed if the row is still `scheduled`
    // (guards against a second server instance racing the same row).
    const claimed = await db.workflowSchedule
      .updateMany({
        where: { id: s.id, status: "scheduled" },
        data: { status: "firing" },
      })
      .catch(() => ({ count: 0 }));
    if (claimed.count === 0) continue;

    console.log(`[scheduler] firing schedule ${s.id} (${s.label})`);
    const result = await runWorkflowById(s.workflowId);
    if (result.ok) {
      await db.workflowSchedule
        .update({
          where: { id: s.id },
          data: {
            status: "fired",
            firedAt: new Date(),
            started: result.started,
            completed: result.completed,
            error: null,
          },
        })
        .catch(() => {});
      console.log(
        `[scheduler] schedule ${s.id} fired — started ${result.started}, completed ${result.completed}`,
      );
    } else {
      await db.workflowSchedule
        .update({
          where: { id: s.id },
          data: {
            status: "failed",
            firedAt: new Date(),
            started: result.started,
            completed: result.completed,
            error: result.error ?? "run failed",
          },
        })
        .catch(() => {});
      console.error(
        `[scheduler] schedule ${s.id} failed: ${result.error ?? "unknown"}`,
      );
    }
  }
}
