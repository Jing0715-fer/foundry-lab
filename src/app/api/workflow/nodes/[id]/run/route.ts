// POST /api/workflow/nodes/[id]/run — run a SINGLE node, then cascade
// downstream nodes whose all-upstream are completed (BFS).
//
// Double-execution guard: the entry point ATOMICALLY claims the target node
// (idle/pending → running, scheduler.ts updateMany pattern). A second
// concurrent POST loses the claim and gets a 409 with a clear message.
// Re-running a terminal (completed/failed/cancelled) node is still allowed —
// it is claimed conditionally from those states too.
//
// K lane async mode (?async=1): claim → respond IMMEDIATELY with the running
// node; execution continues in the background (fire-and-forget) and the
// client's polling cadence (Runs sheet 3s poll / SSE stream) surfaces
// progress. The Runs sheet Retry button uses this so its spinner covers only
// the claim phase instead of spinning for the whole engine run. A background
// crash marks the node failed (the row can never wedge in "running").
//
// Poll-ceiling honesty: when executeNode reports status "running" (cluster
// job still executing remotely), the node is LEFT running (no completedAt,
// no progress-100) and the BFS cascade stops — downstream nodes only fire
// on completed upstreams. The node's SSE stream route reconciles the node
// against the ToolJob row the cluster sweep keeps updating.
//
// K lane: executeNodeGuarded may report `cancelled` (a user Stop raced this
// run) — persisted honestly via the same conditional write.
//
// I-6 execution token (#47): every claim writes a fresh runToken ATOMICALLY
// together with status=running (generated lane-side, so the lane KNOWS its
// own token without a read-back race). Every persist below adds the token to
// the conditional-write `where` — a late lane that resolves AFTER a
// stop→retry cycle holds a stale token, matches zero rows, and can never
// overwrite the new run's freshly claimed row. This closes the #47 window
// ("late lane overwrites the retry row") that `status: "running"` alone
// could not: a retried node is running TOO, just under a different epoch.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
  executeNodeGuarded,
} from "@/lib/workflow-engine";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // K lane async mode: claim → respond immediately, execute in background.
    const asyncMode = new URL(request.url).searchParams.get("async") === "1";
    const startNode = await db.node.findUnique({ where: { id } });
    if (!startNode) {
      return NextResponse.json(
        { error: "Node not found" },
        { status: 404 },
      );
    }
    const workflowId = startNode.workflowId;

    // ── Atomic claim (double-execution guard) ─────────────────────────────
    // idle/pending → running in ONE updateMany: a concurrent POST/route that
    // already claimed the node sees count 0 → 409 instead of double-run.
    // The claim also stamps this lane's runToken (I-6) — generated HERE so
    // the lane owns it from the moment the row flips (no read-back race).
    const entryToken = crypto.randomUUID();
    const claimed = await db.node.updateMany({
      where: { id, status: { in: ["idle", "pending"] } },
      data: {
        status: "running",
        progress: 10,
        startedAt: startNode.startedAt ?? new Date(),
        runToken: entryToken,
      },
    });
    // Which token this lane actually owns (the re-claim below mints its own).
    let claimToken = entryToken;
    if (claimed.count === 0) {
      // Either someone else is running it right now, or it's terminal.
      // Terminal (completed/failed/cancelled) nodes may be RE-run — claim
      // those too (conditional so a concurrent re-run still can't
      // double-execute). A cancelled row from a user Stop is re-runnable
      // the same way a failed one is. The re-claim REPLACES the runToken of
      // the settled run — any late lane still holding the old token is
      // thereby fenced off from this row (I-6 #47 fix).
      const reToken = crypto.randomUUID();
      const reclaimer = await db.node.updateMany({
        where: { id, status: { in: ["completed", "failed", "cancelled"] } },
        data: {
          status: "running",
          progress: 10,
          startedAt: new Date(),
          completedAt: null,
          runToken: reToken,
        },
      });
      if (reclaimer.count === 0) {
        return NextResponse.json(
          {
            error:
              "Node is already running — wait for it to finish (or stop the " +
              "underlying job) before running it again.",
          },
          { status: 409 },
        );
      }
      claimToken = reToken;
    }

    // Helper: load fresh workflow snapshot.
    async function loadSnapshot() {
      const wf = await db.workflow.findUnique({
        where: { id: workflowId },
        include: { nodes: true, edges: true },
      });
      return {
        nodes: (wf?.nodes ?? []).map(toNodeDTO),
        edges: (wf?.edges ?? []).map(toEdgeDTO),
      };
    }

    // Run one node and persist result. `alreadyClaimed` = the entry point
    // already flipped this node to running (the target node), so the claim
    // below is skipped and `claimedToken` carries the entry claim's token.
    // Returns "skipped" when the atomic claim lost a race (another lane owns
    // the node right now).
    async function runOne(
      nodeId: string,
      alreadyClaimed = false,
      claimedToken?: string,
    ): Promise<"completed" | "failed" | "running" | "cancelled" | "skipped"> {
      // I-6: the token THIS lane's persists are fenced by. Cascade nodes
      // mint their own at claim time; the target node inherits the entry
      // claim's token.
      const runToken = alreadyClaimed ? claimedToken : crypto.randomUUID();
      if (!alreadyClaimed) {
        const nodeRow = await db.node.findUnique({ where: { id: nodeId } });
        if (!nodeRow) return "failed";
        // Cascade nodes: claim atomically like the entry point (a concurrent
        // workflow run that raced us to this node keeps ownership).
        const cascadeClaim = await db.node.updateMany({
          where: { id: nodeId, status: { in: ["pending", "idle"] } },
          data: {
            status: "running",
            progress: 10,
            startedAt: nodeRow.startedAt ?? new Date(),
            runToken,
          },
        });
        if (cascadeClaim.count === 0) return "skipped";
      }

      const { nodes, edges } = await loadSnapshot();
      const current = nodes.find((n) => n.id === nodeId);
      if (!current) {
        // I-6: fence this failure write to OUR run too — an unconditional
        // update could stamp failed onto a row a stop→retry just re-claimed.
        await db.node.updateMany({
          where: { id: nodeId, status: "running", runToken },
          data: { status: "failed", completedAt: new Date() },
        });
        return "failed";
      }
      const inputs = gatherInputs(nodeId, nodes, edges);
      // E1 watchdog — same lane protection as the workflow runner.
      const { result, logs, status } = await executeNodeGuarded(
        current,
        inputs,
        workflowId,
      );
      if (status === "running") {
        // Poll-ceiling outcome: remote cluster job still running — persist
        // the honest in-progress state, NO completedAt / progress-100.
        // E4 conditional + I-6 token: never resurrect a row the user
        // stopped, and never touch a row a retry re-claimed after us.
        await db.node.updateMany({
          where: { id: nodeId, status: "running", runToken },
          data: { status, result, logs, progress: 90 },
        });
        return status;
      }
      // E4 conditional persist — only a still-running row takes the outcome
      // (a user Stop or watchdog settle wins over a late engine result);
      // I-6: …and only OUR run's row — a retry issued after this lane was
      // stopped has a different token and stays untouched (#47).
      await db.node.updateMany({
        where: { id: nodeId, status: "running", runToken },
        data: {
          status,
          result,
          logs,
          progress: 100,
          completedAt: new Date(),
        },
      });
      return status;
    }

    // 1) Run the target node (already claimed by the entry guard above),
    //    2) BFS cascade — repeatedly find pending/idle nodes whose ALL
    //    upstream nodes are now completed, and run them.
    const executeAll = async () => {
      await runOne(id, true, claimToken);
      let guard = 0;
      while (guard++ < 1000) {
        const { nodes, edges } = await loadSnapshot();
        const next = nodes.find((n) => {
          if (n.status !== "pending" && n.status !== "idle") return false;
          const upstreamIds = edges
            .filter((e) => e.toNodeId === n.id)
            .map((e) => e.fromNodeId);
          if (upstreamIds.length === 0) return false; // Don't auto-trigger unrelated nodes.
          return upstreamIds.every(
            (uid) =>
              nodes.find((x) => x.id === uid)?.status === "completed",
          );
        });
        if (!next) break;
        await runOne(next.id);
      }
    };

    if (asyncMode) {
      // K lane: fire-and-forget — respond with the claimed (running) node,
      // let the client's poll cadence own presentation. A background crash
      // marks the node failed so the row never wedges in "running" — fenced
      // to THIS run's token (I-6): a crash handler firing after a stop→retry
      // must not fail the new run's row.
      void executeAll().catch(async (e) => {
        await db.node
          .updateMany({
            where: { id, status: "running", runToken: claimToken },
            data: {
              status: "failed",
              result: `Error: ${e instanceof Error ? e.message : String(e)}`,
              completedAt: new Date(),
            },
          })
          .catch(() => {});
      });
      const running = await db.node.findUnique({ where: { id } });
      return NextResponse.json(running ? toNodeDTO(running) : { error: "Node disappeared after claim" }, {
        status: running ? 200 : 500,
      });
    }

    await executeAll();

    // 3) Return the updated target node DTO.
    const final = await db.node.findUnique({ where: { id } });
    if (!final) {
      return NextResponse.json(
        { error: "Node disappeared after run" },
        { status: 500 },
      );
    }
    return NextResponse.json(toNodeDTO(final));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
