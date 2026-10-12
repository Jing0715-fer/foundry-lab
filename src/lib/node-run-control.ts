// Node run control (E line) — the shared execution guards BOTH run lanes
// (workflow-runner worker pool + single-node run route) flow through:
//
//   executeNodeGuarded(node, inputs, workflowId)
//     1. E1 WATCHDOG — Promise.race(executeNode, timeout). A hung engine can
//        never wedge the worker pool: on timeout the node is marked failed
//        and downstream unlocks (the runner's finally). Cluster-routed tool
//        nodes are exempt-ish: their poll loops already carry 30/120-minute
//        ceilings, so the watchdog sits ABOVE them and never fires first.
//     2. E4 STOP GUARD — after execution returns (or is cut short), a stop
//        request registered by POST /nodes/:id/stop wins over the natural
//        outcome: the node lands in `cancelled` instead of completed/failed,
//        so a late-arriving result can never overwrite the user's stop.
//
// The stop route additionally (a) SIGTERMs the node's local engine process
// via the real-executor ActiveProcessRegistry (keyed by node id) and (b)
// cancels the node's cluster ToolJob (triggeredBy "node:<id>"), so stopping
// is REAL — the work actually halts, not just the row.

import { db } from "./db";
import { executeNode, type NodeExecResult } from "./workflow-engine";
import { killActiveProcess } from "./real-executor";
import { stopClusterJob } from "./cluster/cluster-run";
import { extractClusterTarget } from "./run-utils";
import type { NodeDTO } from "./types";

// ── Stop registry ───────────────────────────────────────────────────────────

const STOP_REQUESTED = new Set<string>();

export function requestStop(nodeId: string): void {
  STOP_REQUESTED.add(nodeId);
}

export function isStopRequested(nodeId: string): boolean {
  return STOP_REQUESTED.has(nodeId);
}

export function clearStop(nodeId: string): void {
  STOP_REQUESTED.delete(nodeId);
}

// ── E1 watchdog ─────────────────────────────────────────────────────────────

/** Default per-node ceiling: generous for the built-in engines (seconds) and
 *  LLM turns, but bounded so a wedged lane can't hold the pool forever. */
export const NODE_WATCHDOG_DEFAULT_MS = 15 * 60 * 1000;

const COMP_NODE_TYPES = new Set([
  "alphafold", "rfdiffusion", "rfantibody", "proteinmpnn", "ligandmpnn",
  "solublempnn", "rosetta", "pyrosetta", "rf3", "esmfold", "colabfold",
]);

/** Per-node watchdog budget. Cluster-routed tool nodes already carry their
 *  own poll deadlines (30 min, 120 min for alphafold) — the watchdog sits
 *  above them so it only ever fires on a genuinely wedged poll loop. */
export function nodeWatchdogMs(node: NodeDTO): number {
  if (COMP_NODE_TYPES.has(node.type)) {
    const cluster = extractClusterTarget(
      (node.params as Record<string, unknown>)._cluster,
    );
    if (cluster) {
      const pollCeiling = node.type === "alphafold" ? 120 : 30;
      return pollCeiling * 60_000 + 5 * 60_000;
    }
  }
  return NODE_WATCHDOG_DEFAULT_MS;
}

class NodeWatchdogError extends Error {
  constructor(ms: number) {
    super(`node watchdog timeout after ${ms}ms`);
    this.name = "NodeWatchdogError";
  }
}

// ── Guarded execution (watchdog + stop) ─────────────────────────────────────

/**
 * Execute one node through BOTH guards. Never throws — every failure mode
 * is a normal NodeExecResult:
 *  - watchdog fire      → failed with an explicit watchdog banner
 *  - stop requested     → cancelled (even when execution finished normally)
 *  - natural outcome    → passthrough
 */
export async function executeNodeGuarded(
  node: NodeDTO,
  inputs: string,
  workflowId: string,
): Promise<NodeExecResult> {
  // Fresh execution discards any STALE stop flag (QA P1-1): a stop aimed at
  // a previous run (e.g. a poll-ceiling cluster row whose lane already
  // exited) must never burn this run — the user asked to stop the OLD one,
  // and this is a NEW run. Stops registered DURING this execution are still
  // honored by the post-race check below.
  clearStop(node.id);

  const limit = nodeWatchdogMs(node);
  let outcome: NodeExecResult;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    outcome = await Promise.race([
      executeNode(node, inputs, workflowId),
      new Promise<never>((_, reject) => {
        // Stored + cleared in finally (the skill-executor pattern, QA P2-1):
        // a losing timer must not linger for the full 15/35/125-min budget
        // after the node completed normally.
        watchdogTimer = setTimeout(
          () => reject(new NodeWatchdogError(limit)),
          limit,
        );
      }),
    ]);
  } catch (e) {
    if (e instanceof NodeWatchdogError) {
      return {
        result:
          `[watchdog] Node exceeded its ${limit / 60000} min execution budget and ` +
          "was marked failed to protect the run queue. The underlying engine may " +
          "still be finishing in the background — check the Logs before re-running.",
        logs: `[watchdog] timed out after ${limit / 1000}s`,
        status: "failed",
      };
    }
    return {
      result: `Error: ${(e as Error).message}`,
      logs: (e as Error).message,
      status: "failed",
    };
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
  }

  // Stop request wins over the natural outcome (a killed engine usually
  // reports failed; an LLM lane cut mid-flight may even report completed).
  if (isStopRequested(node.id)) {
    clearStop(node.id);
    return {
      result: "Stopped by user",
      logs: outcome.logs,
      status: "cancelled",
    };
  }
  return outcome;
}

// ── E4 stop route backend ───────────────────────────────────────────────────

export interface StopNodeResult {
  ok: boolean;
  /** A local engine process was found and signalled. */
  killedProcess: boolean;
  /** Cluster ToolJobs were found for this node: none | cancelled | error. */
  cluster: "none" | "cancelled" | "error";
  warning?: string;
}

/**
 * Stop a running node — the real thing, not just a row flip:
 *  1. register the stop (the in-flight executeNodeGuarded lands cancelled);
 *  2. SIGTERM the node's local engine process (real-executor registry);
 *  3. cancel the node's cluster job(s) (scancel / setsid kill on the remote);
 *  4. flip the row to `cancelled` immediately so the UI reacts at once.
 */
export async function stopNodeRun(nodeId: string): Promise<StopNodeResult> {
  requestStop(nodeId);

  const killedProcess = killActiveProcess(nodeId);

  // Flip the row FIRST, before the (slow, seconds-long) cluster cancel: the
  // SSE reconciler only acts on "running" rows, so once the row is cancelled
  // it can no longer race the stop into a wrong terminal state (QA P1-2).
  // (Queued-then-stopped rows keep startedAt null — the runs route matches
  // cancelled rows by completedAt too so they stay visible, QA P2-5.)
  await db.node
    .updateMany({
      where: { id: nodeId, status: { in: ["running", "pending"] } },
      data: {
        status: "cancelled",
        result: "Stopped by user",
        completedAt: new Date(),
      },
    })
    .catch(() => {});

  let cluster: StopNodeResult["cluster"] = "none";
  let warning: string | undefined;
  try {
    const jobs = await db.toolJob.findMany({
      where: {
        triggeredBy: `node:${nodeId}`,
        status: { in: ["queued", "running"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    for (const job of jobs) {
      const res = await stopClusterJob(job.id);
      if (res.ok) {
        cluster = "cancelled";
      } else {
        cluster = "error";
        warning = res.error;
      }
    }
  } catch (e) {
    cluster = "error";
    warning = (e as Error).message;
  }

  return { ok: true, killedProcess, cluster, warning };
}
