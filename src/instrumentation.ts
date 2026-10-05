// Next.js instrumentation hook — runs once when the server process boots
// (dev and production).
//
//   1. BOOT RECONCILIATION — honest failure for runs orphaned by a restart:
//      - every Node stuck in "running" (its executing request died with the
//        old process) → "failed" with an honest log line + result text;
//      - every ToolJob stuck in "running" with no live LOCAL pid → "failed".
//        Local tool runs never persist a pid (a known, deferred gap), so any
//        local row still "running" after a boot is provably orphaned. CLUSTER
//        jobs (params._meta.cluster === true) are left alone — the cluster
//        sweep (reconcileClusterJobs) keeps advancing them from the remote
//        side, and the node stream route reconciles their nodes later.
//   2. Starts the workflow scheduled-run sweeper, which persists + fires
//      WorkflowSchedule rows through the real execution engine.
//
// register() must never throw (Next.js treats it as a boot error), so every
// step is defensive: try/catch, best-effort, log-and-continue.
//
// A globalThis guard prevents double execution across hot reloads (dev HMR
// can re-import this module without a new process).

const globalForBoot = globalThis as unknown as {
  __foundryBootReconciled?: boolean;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ── 1. Boot reconciliation (once per server process) ────────────────────
  if (!globalForBoot.__foundryBootReconciled) {
    globalForBoot.__foundryBootReconciled = true;
    try {
      await reconcileStaleRuns();
    } catch (e) {
      console.error(
        "[instrumentation] boot reconciliation failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ── 2. Scheduled-run sweeper (has its own HMR guard) ─────────────────────
  const { startScheduleSweeper } = await import("./lib/scheduler");
  startScheduleSweeper();
}

/** Fail nodes + local tool jobs orphaned by a server restart (see header). */
async function reconcileStaleRuns(): Promise<void> {
  // Dynamic import keeps the Prisma client out of the edge/inspect phases.
  const { db } = await import("./lib/db");
  const now = new Date();

  // 1a. Nodes stuck in "running" — the request that was executing them died
  //     with the old process. Mark failed with an honest log + result.
  const stuckNodes = await db.node.findMany({
    where: { status: "running" },
    select: { id: true, name: true, logs: true },
  });
  for (const n of stuckNodes) {
    const logLine =
      "[boot reconcile] server restarted mid-run — the execution lane died " +
      "with the old process; this run cannot complete. Re-run the node.";
    try {
      await db.node.update({
        where: { id: n.id },
        data: {
          status: "failed",
          progress: 100,
          completedAt: now,
          result: "Error: server restarted mid-run — re-run this node.",
          logs: `${n.logs ?? ""}${n.logs ? "\n" : ""}${logLine}`,
        },
      });
      console.log(`[instrumentation] failed stale running node ${n.name} (${n.id})`);
    } catch (e) {
      console.error(
        `[instrumentation] could not fail stale node ${n.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // 1b. ToolJobs stuck in "running" WITHOUT a live local process. Local runs
  //     never persist their pid, so any non-cluster "running" row is
  //     orphaned. Cluster rows (params._meta.cluster === true) are skipped —
  //     the sweep owns them.
  const stuckJobs = await db.toolJob.findMany({
    where: { status: "running" },
    select: { id: true, tool: true, params: true },
  });
  for (const j of stuckJobs) {
    let isCluster = false;
    try {
      const parsed: unknown = j.params ? JSON.parse(j.params) : null;
      isCluster =
        !!parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { _meta?: { cluster?: unknown } })._meta?.cluster === true;
    } catch {
      isCluster = false;
    }
    if (isCluster) {
      continue; // the cluster sweep + stream reconciliation own this row
    }
    try {
      await db.toolJob.update({
        where: { id: j.id },
        data: {
          status: "failed",
          stderr:
            `Server restarted mid-run — the local process died with the old ` +
            `server (no pid was persisted to verify/stop it). Re-run the tool.`,
          exitCode: 1,
          finishedAt: now,
        },
      });
      console.log(`[instrumentation] failed stale local tool job ${j.tool} (${j.id})`);
    } catch (e) {
      console.error(
        `[instrumentation] could not fail stale tool job ${j.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  const total = stuckNodes.length + stuckJobs.length;
  if (total > 0) {
    console.log(
      `[instrumentation] boot reconciliation: ${stuckNodes.length} node(s) + ` +
        `${stuckJobs.length} local tool job(s) marked failed (server restarted mid-run)`,
    );
  }
}
