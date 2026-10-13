// Node run control (K lane — ported from the parallel S/E line, Task 22
// reference branch, and adapted onto main's cluster/cancel-source lanes).
//
// stopNodeRun(nodeId) is the REAL stop, not just a row flip:
//   1. register the stop (stop-registry) — the in-flight executeNodeGuarded
//      reports `cancelled` post-race, and every persist lane's conditional
//      write keeps the verdict;
//   2. SIGTERM the node's LOCAL engine process (real-executor ACTIVE_PROCS
//      registry, keyed by node id) with a SIGKILL escalation;
//   3. flip the row to `cancelled` immediately — the UI reacts at once and
//      the SSE reconciler (which only acts on "running" rows) can no longer
//      race the stop into a wrong terminal state;
//   4. cancel the node's linked jobs — cluster ToolJobs are discovered by the
//      K-lane `triggeredBy: "node:<id>"` tag (primary) or the legacy
//      node-log marker (fallback, pre-K rows); remote cancellation goes
//      through stopClusterJob (scancel / process-group kill, with the
//      via-node-stop stderr badge stamped inside its own row write).
//      Local ToolJobs get best-effort SIGTERM + a cancelled row.
//
// A queued (pending, not yet claimed) node simply flips to cancelled — the
// runner's atomic claim only matches pending/idle, so it skips the node and
// downstream unlocks with the normal failure-doesn't-prune semantics.

import { db } from "./db";
import { killActiveProcess } from "./real-executor";
import { requestStop } from "./stop-registry";
import { stopClusterJob } from "./cluster/cluster-run";
import { CANCELLED_VIA_NODE_STOP } from "./job-cancel-source";

export interface StopNodeResult {
  ok: boolean;
  /** A local engine process was found and signalled (SIGTERM). */
  killedProcess: boolean;
  /** Linked job cancellation outcome: none | cancelled | error. */
  cluster: "none" | "cancelled" | "error";
  /** Human detail line for the response/toast. */
  detail: string;
  warning?: string;
}

/** Cluster/local ToolJob ids linked to this node: the K-lane triggeredBy tag
 *  (primary) ∪ the legacy node-log marker (fallback for pre-K rows). */
async function linkedJobIds(nodeId: string, nodeLogs: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const rows = await db.toolJob.findMany({
      where: {
        triggeredBy: `node:${nodeId}`,
        status: { in: ["queued", "running"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true },
    });
    for (const r of rows) ids.add(r.id);
  } catch {
    /* discovery is best-effort */
  }
  const m = (nodeLogs ?? "").match(/\[cluster run · job ([^\]\s]+)/);
  if (m) ids.add(m[1]);
  return [...ids];
}

/** Stop a running node — the real thing. Never throws; every failure mode is
 *  reported through the result envelope. */
export async function stopNodeRun(
  nodeId: string,
  nodeLogs: string,
): Promise<StopNodeResult> {
  // 1) Register the stop: the in-flight guarded execution will report
  //    `cancelled` when it returns, whatever its natural outcome was.
  requestStop(nodeId);

  // 2) Kill the local engine process registered under this node id.
  const killedProcess = killActiveProcess(nodeId);

  // 3) Flip the row FIRST (before the seconds-long remote cancel): the SSE
  //    reconciler only acts on "running" rows, so once the row is cancelled
  //    it can no longer race the stop into a wrong terminal state. Queued
  //    (pending) rows keep their startedAt null; the runs route matches
  //    cancelled rows by completedAt too, so they stay visible.
  await db.node
    .updateMany({
      where: { id: nodeId, status: { in: ["running", "pending"] } },
      data: {
        status: "cancelled",
        result: "Stopped by user before completion.",
        completedAt: new Date(),
      },
    })
    .catch(() => {});

  // 4) Linked job cancellation (best-effort; the row verdict above is
  //    already atomic and independent of this succeeding).
  let cluster: StopNodeResult["cluster"] = "none";
  let warning: string | undefined;
  try {
    const jobIds = await linkedJobIds(nodeId, nodeLogs);
    for (const jobId of jobIds) {
      // Remote cluster lane → scancel / process-group kill on the host.
      // The via-node-stop stderr badge is stamped inside stopClusterJob's
      // own row write (single point, no follow-up window).
      const res = await stopClusterJob(jobId, { viaNodeStop: true });
      if (res.ok) {
        cluster = "cancelled";
        continue;
      }
      // Not a cluster job (or its run record is gone) → local lane:
      // best-effort SIGTERM to the stored pid + cancelled row + badge.
      const job = await db.toolJob.findUnique({ where: { id: jobId } });
      if (!job || (job.status !== "running" && job.status !== "queued")) continue;
      if (job.pid && job.pid > 0) {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await db.toolJob
        .update({
          where: { id: jobId },
          data: {
            status: "cancelled",
            finishedAt: new Date(),
            stderr: `${job.stderr}${job.stderr ? "\n" : ""}${CANCELLED_VIA_NODE_STOP}`,
          },
        })
        .catch(() => {});
      cluster = "cancelled";
    }
  } catch (e) {
    cluster = "error";
    warning = e instanceof Error ? e.message : String(e);
  }

  const detail =
    killedProcess && cluster === "cancelled"
      ? "local engine process killed + linked job cancelled"
      : killedProcess
        ? "local engine process killed"
        : cluster === "cancelled"
          ? "linked job cancelled"
          : cluster === "error"
            ? `job cancel failed${warning ? `: ${warning}` : ""} — the node is cancelled; a remote job may finish on its own`
            : "row cancelled — the in-flight lane will report cancelled and its late result is discarded";

  return { ok: true, killedProcess, cluster, detail, warning };
}
