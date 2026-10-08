// Node execution lifecycle — shared watchdog, conditional persist, and abort
// (E1/E4 execution robustness).
//
// Problems this module solves (see ROADMAP test findings #4/#5):
//   1. A hung engine (LLM call that never resolves, a stuck spawn) wedges the
//      worker pool forever: runNode's promise never settles, so `inFlight`
//      never decrements and the pool drains. WATCHDOG: race executeNode
//      against a timeout — the node is marked failed and the pool moves on.
//      The underlying promise keeps running (JS can't cancel it), but nobody
//      consumes its late result.
//   2. Late-result overwrite: a user STOP (or watchdog) flips the node to
//      failed while executeNode is still in flight. When it finally resolves,
//      the naive unconditional update would resurrect the node (completed,
//      progress 100). CONDITIONAL PERSIST: every outcome write targets
//      `status: "running"` — a node already flipped to failed/pending keeps
//      its terminal state and the late result is discarded.
//   3. User abort (Runs panel → Stop): flip running/pending → failed. Pending
//      nodes are claimed by run lanes only from pending/idle, so an aborted
//      queued node is skipped; a running node's late result is discarded by
//      the conditional persist.
//
// Cluster nodes are EXEMPT from the local watchdog: their executeCompTool
// poll loop legitimately runs for up to 30/120 minutes and always exits by
// its own deadline (poll ceiling) — the watchdog would otherwise kill healthy
// remote runs. The local timeout covers exactly what has no internal
// deadline: LLM lanes (agent/meeting/research) and biotool fetches.

import { db } from "@/lib/db";
import { extractClusterTarget } from "@/lib/run-utils";
import type { NodeDTO } from "@/lib/types";

export interface ExecOutcome {
  result: string;
  logs: string;
  status: "completed" | "failed" | "running";
}

/** Local-lane per-node execution timeout. Defaults to 15 min; override with
 *  NODE_TIMEOUT_MS (ms) — tests use a small value to exercise the watchdog. */
export function nodeTimeoutMs(): number {
  const v = Number(process.env.NODE_TIMEOUT_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000;
}

/** Cluster-lane watchdog: generous enough to never fire before the poll
 *  loop's own deadline (30 min, 120 min for alphafold) — pure wedge
 *  insurance (e.g. reconcileClusterJobs hanging) rather than a policy. */
export function clusterNodeTimeoutMs(): number {
  return 150 * 60 * 1000;
}

/** True when the node's params route execution to an SSH cluster (the poll
 *  loop owns that node's timing; local watchdog exempts it). Uses the SAME
 *  extractor the engine does — `extractClusterTarget` treats `""`, whitespace
 *  and JSON without a connectionId as LOCAL, so an inspector-cleared
 *  `_cluster: ""` param gets the 15-min local watchdog, not the 150-min
 *  cluster ceiling (P1 finding, qa-review-c-e-lane.md). */
export function isClusterRoutedNode(node: NodeDTO): boolean {
  return (
    extractClusterTarget((node.params as Record<string, unknown>)._cluster) !==
    null
  );
}

export interface WatchdogTimeout {
  timedOut: true;
  /** Timeout that was applied (for the failure message). */
  afterMs: number;
}

/** Result of racing an execution against the watchdog: either the engine's
 *  own outcome, or a timeout marker (discriminate with `"timedOut" in r`). */
export type WatchdogResult = ExecOutcome | WatchdogTimeout;

/** Race an execution against the watchdog timer. Resolves with the engine's
 *  outcome, or `{ timedOut: true }` when it never settled in time. */
export async function executeWithWatchdog(
  timeoutMs: number,
  exec: () => Promise<ExecOutcome>,
): Promise<WatchdogResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WatchdogTimeout>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, afterMs: timeoutMs }), timeoutMs);
  });
  try {
    return await Promise.race([exec(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Watchdog firing: fail the node (only if still running — an abort may have
 *  beaten us to it) so the pool unlocks and downstream proceeds. */
export async function markWatchdogTimeout(
  nodeId: string,
  afterMs: number,
): Promise<void> {
  const minutes = Math.max(1, Math.round(afterMs / 60000));
  try {
    await db.node.updateMany({
      where: { id: nodeId, status: "running" },
      data: {
        status: "failed",
        result: `Execution timed out after ~${minutes} min (watchdog) — the engine never returned.`,
        logs: `[watchdog] Timed out after ${minutes} min. The node was marked failed and downstream nodes were unlocked.`,
        progress: 100,
        completedAt: new Date(),
      },
    });
  } catch {
    // DB hiccup on the watchdog path: the runner's catch-all also marks the
    // node failed, so a lost write here is survivable.
  }
}

/**
 * Persist an execution outcome ONLY while the node is still running.
 * Returns false (and writes nothing) when a watchdog timeout or user abort
 * already flipped the node terminal — the late engine result is discarded
 * instead of resurrecting the node.
 */
export async function persistExecOutcome(
  nodeId: string,
  o: ExecOutcome,
): Promise<boolean> {
  if (o.status === "running") {
    // Poll-ceiling outcome: keep the honest in-progress state (progress 90,
    // no completedAt) — still conditional so an abort isn't overwritten.
    const r = await db.node.updateMany({
      where: { id: nodeId, status: "running" },
      data: { status: "running", result: o.result, logs: o.logs, progress: 90 },
    });
    return r.count > 0;
  }
  const r = await db.node.updateMany({
    where: { id: nodeId, status: "running" },
    data: {
      status: o.status,
      result: o.result,
      logs: o.logs,
      progress: 100,
      completedAt: new Date(),
    },
  });
  return r.count > 0;
}

/**
 * User-initiated stop (Runs panel → Stop). Flips a running/pending node to
 * failed. Returns true when something was actually aborted.
 *   - pending: run lanes claim only pending/idle → the aborted row is skipped.
 *   - running: the in-flight executeNode's late result is discarded by
 *     persistExecOutcome's conditional write.
 * Does NOT attempt to kill cluster ToolJobs: a cluster-routed node being
 * poll-ceiling "running" is a REMOTE job this lane can't cancel from here —
 * aborting would strand the node state while the remote job keeps going.
 * (Remote cancel stays on the Cluster panel's job list.)
 */
export async function abortNodeRun(nodeId: string): Promise<boolean> {
  const r = await db.node.updateMany({
    where: { id: nodeId, status: { in: ["running", "pending"] } },
    data: {
      status: "failed",
      result: "Aborted — execution was stopped from the Runs panel.",
      logs: "[abort] Stopped by user from the Runs panel.",
      progress: 100,
      completedAt: new Date(),
    },
  });
  return r.count > 0;
}

/** Workflow-level stop: abort every running/pending node of a workflow. */
export async function abortWorkflowRun(workflowId: string): Promise<number> {
  const r = await db.node.updateMany({
    where: { workflowId, status: { in: ["running", "pending"] } },
    data: {
      status: "failed",
      result: "Aborted — workflow execution was stopped from the Runs panel.",
      logs: "[abort] Stopped by user from the Runs panel (workflow-level stop).",
      progress: 100,
      completedAt: new Date(),
    },
  });
  return r.count;
}
