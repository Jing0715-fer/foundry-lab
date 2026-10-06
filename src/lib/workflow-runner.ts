// Workflow runner — shared execution lane for manual runs (POST
// /api/workflow/run) and the SCHEDULED-run sweeper (src/lib/scheduler.ts).
//
// Runs one workflow by id as a PARALLEL DAG (B2 execution lane):
//   1. Fetch the workflow with nodes + edges.
//   2. Topological order via topologicalOrder(nodes, edges). Fails on a cycle.
//   3. Set all idle nodes to pending, save.
//   4. Kahn-style scheduling: a node becomes READY the moment its LAST
//      upstream reaches a terminal state (completed/failed/running-ceiling)
//      — exactly the unlock semantics of the old sequential loop, where a
//      failed or poll-ceiling node still let downstream nodes proceed.
//      Ready nodes are claimed by a bounded worker pool:
//        - MAX_CONCURRENCY lanes execute in parallel (sweep variants that
//          share upstream edges but not each other all run together).
//        - ATOMIC claim pending/idle → running (scheduler.ts pattern) — a
//          concurrent run lane loses the race and skips the node instead of
//          double-executing it.
//        - gatherInputs from the latest completed upstream nodes.
//        - executeNode → completed/failed (progress 100, completedAt) — or
//          the node legitimately stays "running" when executeNode reports
//          the poll-ceiling outcome (remote cluster job still executing;
//          the node's SSE stream route reconciles it against the ToolJob
//          row the cluster sweep updates).
//   5. Return { started, completed, error? } when the pool drains.
//
// A node that ends the loop in "running" state does NOT count as completed
// — that's the poll-ceiling honesty rule (unchanged from the sequential
// runner). Failure does NOT prune downstream: the sequential runner let a
// failed node's downstream still run (gatherInputs just sees no usable
// upstream result), and this runner keeps that behavior so a single tool
// failure doesn't strand the rest of the DAG.

import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
  executeNode,
} from "@/lib/workflow-engine";
import { topologicalOrder } from "@/lib/canvas-utils";

export interface WorkflowRunResult {
  ok: boolean;
  workflowId: string;
  started: number;
  completed: number;
  /** How many nodes ran simultaneously at the peak (0 for a no-op run). */
  peakConcurrency: number;
  error?: string;
}

/**
 * Parallel execution lanes. The built-in numpy engines are CPU-bound on a
 * single machine — 3 keeps a 4-variant sweep visibly concurrent (≈⅓ wall
 * time) without saturating the box or tripling LLM token contention.
 */
export const MAX_CONCURRENCY = 3;

export async function runWorkflowById(
  workflowId: string,
): Promise<WorkflowRunResult> {
  const wf = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { nodes: true, edges: true },
  });
  if (!wf) {
    return {
      ok: false,
      workflowId,
      started: 0,
      completed: 0,
      peakConcurrency: 0,
      error: "Workflow not found",
    };
  }

  const nodes = wf.nodes.map(toNodeDTO);
  const edges = wf.edges.map(toEdgeDTO);
  const order = topologicalOrder(nodes, edges);
  if (!order) {
    return {
      ok: false,
      workflowId,
      started: 0,
      completed: 0,
      peakConcurrency: 0,
      error: "Workflow has a cycle",
    };
  }

  // Mark all idle nodes as pending.
  const idleIds = wf.nodes
    .filter((n) => n.status === "idle")
    .map((n) => n.id);
  if (idleIds.length > 0) {
    await db.node.updateMany({
      where: { id: { in: idleIds } },
      data: { status: "pending" },
    });
  }
  const startedCount = idleIds.length;

  // ── DAG bookkeeping (Kahn) ─────────────────────────────────────────────
  // indeg = upstream nodes still in a non-terminal state. A node is ready
  // when indeg hits 0 AND it is still pending/idle (terminal nodes skip).
  const runnable = new Set(
    wf.nodes
      .filter((n) => n.status === "pending" || n.status === "idle")
      .map((n) => n.id),
  );
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of wf.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of wf.edges) {
    if (!indeg.has(e.fromNodeId) || !indeg.has(e.toNodeId)) continue;
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    indeg.set(e.toNodeId, (indeg.get(e.toNodeId) ?? 0) + 1);
  }

  // Initial ready set: no upstream at all, or every upstream already
  // settled when the run started. Only pending/idle upstream can settle
  // INSIDE this run (they will be executed and unlock us) — terminal
  // upstream already settled, and a "running" upstream is a cluster
  // carry-over this runner can't advance, so neither blocks.
  const queue: string[] = [];
  for (const n of wf.nodes) {
    if (!runnable.has(n.id)) continue;
    const upEdges = wf.edges.filter((e) => e.toNodeId === n.id);
    let blockers = 0;
    for (const e of upEdges) {
      const src = wf.nodes.find((x) => x.id === e.fromNodeId);
      // Count only upstream that can still settle inside this run
      // (pending/idle — they will be executed and unlock us). Terminal
      // upstream already settled; a "running" upstream is a cluster
      // carry-over this runner can't advance, so it doesn't block.
      if (src && (src.status === "pending" || src.status === "idle")) {
        blockers++;
      }
    }
    indeg.set(n.id, blockers);
    if (blockers === 0) queue.push(n.id);
  }

  let completedCount = 0;
  let inFlight = 0;
  let peakConcurrency = 0;

  // ── One node through the engine (worker body) ──────────────────────────
  async function runNode(nodeId: string): Promise<void> {
    const nodeRow = await db.node.findUnique({ where: { id: nodeId } });
    if (!nodeRow) return;
    // ATOMIC claim pending/idle → running: only a row still in pending/idle
    // flips; a concurrent lane (double-clicked Run, single-node run, the
    // scheduler) that raced us to this node sees count 0 and skips it
    // instead of double-executing.
    const claimed = await db.node.updateMany({
      where: { id: nodeId, status: { in: ["pending", "idle"] } },
      data: {
        status: "running",
        progress: 10,
        startedAt: nodeRow.startedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) return;

    // Gather inputs from the latest snapshot (parallel siblings may have
    // written results while we waited for the claim).
    const freshWf = await db.workflow.findUnique({
      where: { id: workflowId },
      include: { nodes: true, edges: true },
    });
    const freshNodes = (freshWf?.nodes ?? []).map(toNodeDTO);
    const freshEdges = (freshWf?.edges ?? []).map(toEdgeDTO);
    const currentNode = freshNodes.find((n) => n.id === nodeId);
    if (!currentNode) return;
    const inputs = gatherInputs(nodeId, freshNodes, freshEdges);

    const { result, logs, status } = await executeNode(
      currentNode,
      inputs,
      workflowId,
    );

    if (status === "running") {
      // Poll-ceiling outcome (cluster job still running remotely): persist
      // the honest in-progress result/logs but NO completedAt and NO
      // progress-100 — the node legitimately stays running.
      await db.node.update({
        where: { id: nodeId },
        data: { status, result, logs, progress: 90 },
      });
      return;
    }

    await db.node.update({
      where: { id: nodeId },
      data: {
        status,
        result,
        logs,
        progress: 100,
        completedAt: new Date(),
      },
    });
    if (status === "completed") completedCount++;
  }

  // ── Bounded worker pool (event-driven pump) ────────────────────────────
  await new Promise<void>((resolve) => {
    const settle = () => {
      if (queue.length === 0 && inFlight === 0) resolve();
    };

    const pump = () => {
      while (queue.length > 0 && inFlight < MAX_CONCURRENCY) {
        const nodeId = queue.shift()!;
        inFlight++;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        void runNode(nodeId)
          .catch(() => {
            // runNode's own failure paths persist a failed status; a
            // thrown exception (DB hiccup) marks the node failed so the
            // pool never wedges on a phantom "running" lane.
            void db.node
              .update({
                where: { id: nodeId },
                data: { status: "failed", completedAt: new Date() },
              })
              .catch(() => {});
          })
          .finally(() => {
            inFlight--;
            // Unlock downstream: this node reached a decision state
            // (completed / failed / poll-ceiling running / claim lost) —
            // every semantics matches the sequential loop, including
            // "failure still unblocks downstream".
            for (const next of adj.get(nodeId) ?? []) {
              const remaining = (indeg.get(next) ?? 1) - 1;
              indeg.set(next, remaining);
              if (remaining === 0 && runnable.has(next)) {
                queue.push(next);
              }
            }
            pump();
            settle();
          });
      }
      settle();
    };

    pump();
  });

  return {
    ok: true,
    workflowId,
    started: startedCount,
    completed: completedCount,
    peakConcurrency,
  };
}
