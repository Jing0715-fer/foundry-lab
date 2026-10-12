// POST /api/workflow/nodes/[id]/run — run a SINGLE node, then cascade
// downstream nodes whose all-upstream are completed (BFS).
//
// Double-execution guard: the entry point ATOMICALLY claims the target node
// (idle/pending → running, scheduler.ts updateMany pattern). A second
// concurrent POST loses the claim and gets a 409 with a clear message.
// Re-running a terminal (completed/failed/cancelled) node is still allowed —
// it is claimed conditionally from those states too.
//
// Poll-ceiling honesty: when executeNode reports status "running" (cluster
// job still executing remotely), the node is LEFT running (no completedAt,
// no progress-100) and the BFS cascade stops — downstream nodes only fire
// on completed upstreams. The node's SSE stream route reconciles the node
// against the ToolJob row the cluster sweep keeps updating.
//
// E2 async mode (?async=1): claim → respond IMMEDIATELY with the running
// node DTO, execute + cascade in the background. The RunsSheet retry lane
// uses this so the button spinner covers the claim phase only (previously
// the await spanned the whole node execution); the 3s pollers render
// execution state.
//
// E line guards: execution goes through executeNodeGuarded (E1 watchdog +
// E4 stop-registry). A stop request flips the outcome to `cancelled`, and
// a watchdog fire marks the node failed instead of wedging the lane.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  toNodeDTO,
  toEdgeDTO,
  gatherInputs,
} from "@/lib/workflow-engine";
import { executeNodeGuarded } from "@/lib/node-run-control";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // E2 async mode: claim → respond immediately, execute in the background.
    const asyncMode = request.nextUrl.searchParams.get("async") === "1";
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
    const claimed = await db.node.updateMany({
      where: { id, status: { in: ["idle", "pending"] } },
      data: {
        status: "running",
        progress: 10,
        startedAt: startNode.startedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) {
      // Either someone else is running it right now, or it's terminal.
      // Terminal (completed/failed/cancelled) nodes may be RE-run — claim
      // those too (conditional so a concurrent re-run still can't
      // double-execute).
      const reclaimer = await db.node.updateMany({
        where: { id, status: { in: ["completed", "failed", "cancelled"] } },
        data: {
          status: "running",
          progress: 10,
          startedAt: new Date(),
          completedAt: null,
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
    // below is skipped. Returns "skipped" when the atomic claim lost a race
    // (another lane owns the node right now).
    async function runOne(
      nodeId: string,
      alreadyClaimed = false,
    ): Promise<"completed" | "failed" | "running" | "cancelled" | "skipped"> {
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
          },
        });
        if (cascadeClaim.count === 0) return "skipped";
      }

      const { nodes, edges } = await loadSnapshot();
      const current = nodes.find((n) => n.id === nodeId);
      if (!current) {
        await db.node.update({
          where: { id: nodeId },
          data: { status: "failed", completedAt: new Date() },
        });
        return "failed";
      }
      const inputs = gatherInputs(nodeId, nodes, edges);
      const { result, logs, status } = await executeNodeGuarded(
        current,
        inputs,
        workflowId,
      );
      if (status === "running") {
        // Poll-ceiling outcome: remote cluster job still running — persist
        // the honest in-progress state, NO completedAt / progress-100.
        // CONDITIONAL write (row still running): never resurrect a row the
        // stop lane flipped terminal (QA P1-2).
        await db.node
          .updateMany({
            where: { id: nodeId, status: "running" },
            data: { status, result, logs, progress: 90 },
          })
          .catch(() => {});
        return status;
      }
      // CONDITIONAL terminal write — same rationale as above.
      await db.node
        .updateMany({
          where: { id: nodeId, status: "running" },
          data: {
            status,
            result,
            logs,
            progress: 100,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      return status;
    }

    // 1) Run the target node (already claimed by the entry guard above).
    // 2) BFS cascade — repeatedly find pending/idle nodes whose ALL upstream
    //    nodes are now completed, and run them. Stop when no such node exists.
    const executeAll = async () => {
      await runOne(id, true);

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
      // E2: fire-and-forget — respond with the claimed (running) node, let
      // the 3s pollers (RunsSheet / canvas) render execution state. The
      // background lane's own failure paths persist failed rows, so a
      // dropped lane can never leave a phantom "running". CONDITIONAL
      // write: if the user stopped the node mid-flight (row already
      // cancelled), the catch must NOT overwrite cancelled → failed (QA
      // P2-4).
      void executeAll().catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        await db.node
          .updateMany({
            where: { id, status: "running" },
            data: {
              status: "failed",
              result: `Async run lane failed: ${msg}`,
              completedAt: new Date(),
            },
          })
          .catch(() => {});
      });
      const running = await db.node.findUnique({ where: { id } });
      return NextResponse.json({
        async: true,
        node: running ? toNodeDTO(running) : null,
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
