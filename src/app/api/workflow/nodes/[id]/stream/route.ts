// GET /api/workflow/nodes/[id]/stream — Server-Sent Events endpoint that
// streams a node's run progress live. Polls the DB every 500ms and emits a
// "status" event per poll; emits a terminal "done" event (and closes the
// stream) when the node reaches "completed" or "failed". A heartbeat comment
// is sent every 15s to keep proxies from closing the idle connection.
//
// Event shape:
//   event: status  data: { status, progress, logs, result }
//   event: done    data: { status, reason? }       (terminal — stream closes)
//   event: error   data: { error }                 (terminal — stream closes)
//
// Use the browser-native EventSource API on the client (GET-based, simpler
// than fetch + ReadableStream for unidirectional server→client streaming).
//
// Resource-safety (review fix "SSE leak"):
//   - `cancel()` is implemented on the ReadableStream: when the client goes
//     away (tab closed / EventSource.close()), the runtime calls cancel() —
//     we flip the closed flag and clear BOTH the heartbeat interval AND the
//     pending poll setTimeout, so the 500ms poll chain can no longer run
//     forever against a dead connection.
//   - A HARD CAP (2h) ends the stream with a terminal "done" event no matter
//     what — a node wedged in "running" (e.g. a cluster job that outlived
//     every ceiling) can't hold a DB-polling stream open indefinitely.
//
// Cluster poll-ceiling reconciliation (review fix "poll ceiling lies as
// success"): when a cluster-dispatched node reaches its poll ceiling, the
// workflow engine leaves it in "running" and stamps its logs with a
// "[cluster run · job <jobId>]" marker. The cluster sweep
// (reconcileClusterJobs) keeps updating that job's ToolJob row to a terminal
// state even though no poll loop is attached to the node anymore. So while
// this node is "running" and its logs carry that marker, each poll ALSO
// checks the ToolJob row: once it is terminal, the terminal state
// (status/result/logs + ##OUTPUTS## trailer) is copied onto the NODE so the
// UI settles honestly instead of spinning forever.
//
// G-lane sweep co-driver (roadmap #21): the sweep used to be driven ONLY by
// the cluster panel / jobs-list pollers — with just this stream open, the
// ToolJob row would never advance and the node would spin until the 2h hard
// cap. While the node is "running" with a cluster marker, this stream now
// fires the (re-entrant-guarded, best-effort) sweep itself every ~3s, so a
// ceiling'd node settles even with no other surface attached.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { reconcileClusterJobs } from "@/lib/cluster/cluster-run";

export const runtime = "nodejs";

/** Absolute ceiling for one stream connection (hard cap). */
const STREAM_HARD_CAP_MS = 2 * 60 * 60 * 1000; // 2h

/** Extract the cluster ToolJob id from a node's run logs, if any.
 *  Matches BOTH log formats the cluster lane stamps:
 *    "[cluster run · job <id>]"            (normal completion prefix)
 *    "[cluster run · job <id> — poll ceiling reached, remote job still running]"
 *  The id is a cuid (no spaces/brackets) so it ends at the first
 *  whitespace/bracket — no need to match the closing bracket. */
function clusterJobIdFromLogs(logs: string): string | null {
  const m = logs.match(/\[cluster run · job ([^\]\s]+)/);
  return m ? m[1] : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Shared stream lifecycle state — hoisted OUT of start() so the cancel()
  // handler (called by the runtime when the client disconnects) can flip the
  // closed flag and clear both timers. This is the "SSE leak" fix: without
  // cancel(), the 500ms poll setTimeout chain kept hitting the DB forever
  // after the client went away.
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // G-lane sweep co-driver: last time this stream fired reconcileClusterJobs
  // (throttled — the 500ms poll only re-reads, the sweep does real SSH work).
  let lastSweepAt = 0;
  const SWEEP_INTERVAL_MS = 3000;
  const deadline = Date.now() + STREAM_HARD_CAP_MS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller may have been closed by the client mid-write.
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (pollTimer) clearTimeout(pollTimer);
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      // Send initial state immediately so the client doesn't have to wait
      // 500ms for the first poll to learn the current status.
      const initial = await db.node.findUnique({ where: { id } });
      if (!initial) {
        send("error", { error: "Node not found" });
        close();
        return;
      }
      send("status", {
        status: initial.status,
        progress: initial.progress,
        logs: initial.logs ?? "",
        result: initial.result ?? "",
      });

      // Short-circuit if the node is already terminal on connection.
      if (initial.status === "completed" || initial.status === "failed") {
        send("done", { status: initial.status });
        close();
        return;
      }

      /**
       * Poll-ceiling reconciliation: a "running" node whose logs carry a
       * cluster-job marker may be waiting on a REMOTE job that the cluster
       * sweep keeps advancing in its ToolJob row. When that row is terminal,
       * copy the terminal state onto the node (status/exit text/result/logs +
       * an ##OUTPUTS## trailer so downstream auto-wiring can still find the
       * synced artifacts). Returns the fresh node row when it changed.
       */
      const reconcileClusterOutcome = async (
        nodeRow: { id: string; status: string; logs: string | null },
      ): Promise<{ status: string; progress: number; logs: string; result: string | null; writtenAt: Date } | null> => {
        if (nodeRow.status !== "running") return null;
        const jobId = clusterJobIdFromLogs(nodeRow.logs ?? "");
        if (!jobId) return null;
        const job = await db.toolJob
          .findUnique({ where: { id: jobId } })
          .catch(() => null);
        if (!job) return null;
        if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
          return null; // still running remotely — nothing to settle yet
        }

        // Map the ToolJob outcome onto node semantics.
        const nodeStatus = job.status === "completed" ? "completed" : "failed";
        let files: string[] = [];
        try {
          const parsed = job.outputFiles ? JSON.parse(job.outputFiles) : [];
          if (Array.isArray(parsed)) files = parsed.map(String);
        } catch {
          files = [];
        }
        const exitSuffix = job.exitCode != null ? ` (exit ${job.exitCode})` : "";
        const result =
          job.status === "completed"
            ? `Cluster job ${jobId} completed${exitSuffix}.`
            : `Cluster job ${jobId} ${job.status}${exitSuffix} — see logs.`;
        const logs =
          `${nodeRow.logs ?? ""}\n[cluster reconcile] job ${jobId} ${job.status}${exitSuffix}\n` +
          (job.stdout ? `${job.stdout.slice(-2000)}\n` : "") +
          (job.stderr ? `[stderr]\n${job.stderr.slice(-2000)}\n` : "") +
          (files.length ? `##OUTPUTS## ${JSON.stringify(files)}\n` : "");

        // E4 conditional persist (QA 23-a P1 fix): only a row STILL "running"
        // takes the cluster outcome — a user Stop (or the local watchdog)
        // may have settled this node between the poll's read and this write,
        // and a late cluster completion must never resurrect that verdict.
        const writeMark = new Date();
        const settled = await db.node
          .updateMany({
            where: { id: nodeRow.id, status: "running" },
            data: {
              status: nodeStatus,
              result,
              logs,
              progress: 100,
              completedAt: writeMark,
            },
          })
          .catch(() => ({ count: 0 }));
        if (settled.count === 0) return null;
        return { status: nodeStatus, progress: 100, logs, result, writtenAt: writeMark };
      };

      // Poll every 500ms until the node reaches a terminal state (or the
      // hard cap fires).
      const poll = async () => {
        if (closed) return;
        try {
          const current = await db.node.findUnique({ where: { id } });
          if (!current) {
            send("error", { error: "Node not found" });
            close();
            return;
          }

          // G-lane sweep co-driver (see file header): while this node waits
          // on a remote cluster job, keep the sweep advancing even when no
          // cluster panel / jobs list is polling. Fire-and-forget — the
          // sweep is global-re-entrant-guarded and never throws; the NEXT
          // 500ms poll reads whatever it wrote to the ToolJob row.
          if (
            current.status === "running" &&
            clusterJobIdFromLogs(current.logs ?? "")
          ) {
            const now = Date.now();
            if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
              lastSweepAt = now;
              void reconcileClusterJobs().catch(() => {});
            }
          }

          // Poll-ceiling reconciliation (see comment above).
          const settled = await reconcileClusterOutcome(current);
          const status = settled?.status ?? current.status;
          const progress = settled?.progress ?? current.progress;
          const logs = settled?.logs ?? current.logs ?? "";
          const result = settled?.result ?? current.result ?? "";

          // rowUpdatedAt (#6 stale-snapshot guard): the observed row's write
          // timestamp. The client drops a late status event that predates a
          // terminal state it already landed (run POST response race). The
          // settled branch reports the WRITE moment (P2-4) — not the emit
          // moment, which lags the row write by the poll+write latency.
          send("status", {
            status,
            progress,
            logs,
            result,
            rowUpdatedAt: (settled ? settled.writtenAt : current.updatedAt).toISOString(),
          });
          if (status === "completed" || status === "failed") {
            send("done", { status });
            close();
            return;
          }

          // Hard cap: 2h of polling is enough — end with a terminal event so
          // the client stops listening (the node itself stays untouched).
          if (Date.now() >= deadline) {
            send("done", {
              status,
              reason:
                "stream hard cap reached (2h) — the node is still running; " +
                "reopen the inspector to keep watching it",
            });
            close();
            return;
          }

          pollTimer = setTimeout(poll, 500);
        } catch {
          send("error", { error: "Poll failed" });
          close();
        }
      };

      pollTimer = setTimeout(poll, 500);

      // Keep the connection alive with a heartbeat every 15s. SSE comment
      // lines (starting with `:`) are ignored by the EventSource client but
      // are seen as traffic by intermediate proxies, preventing idle drops.
      heartbeat = setInterval(() => {
        if (closed) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          closed = true;
        }
      }, 15000);
    },

    // Client went away (EventSource.close() / tab closed): stop the poll
    // chain + heartbeat immediately instead of leaking a 500ms DB poll loop.
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (pollTimer) clearTimeout(pollTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
