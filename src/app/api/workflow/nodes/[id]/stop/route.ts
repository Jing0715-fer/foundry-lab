// POST /api/workflow/nodes/[id]/stop — user-initiated stop of a node (E4).
//
// Flips a running OR queued (pending) node to "failed" with an explicit
// "stopped by user" trace:
//   - RUNNING node: the in-flight execution keeps going in the background
//     (JavaScript can't cancel it), but its late result is DISCARDED — every
//     execution lane persists outcomes conditionally on the row still being
//     "running", so the stop verdict can never be resurrected. The watchdog
//     (E1) eventually frees the lane if the engine hangs forever.
//   - PENDING node: the runner's atomic claim only matches pending/idle, so a
//     failed row is skipped and its downstream unlocks with the normal
//     failure-doesn't-prune semantics.
//
// Linked job cancellation (QA 23-a P1 fix): a node whose logs carry the
// cluster-lane marker ("[cluster run · job <id>]") gets the REMOTE job
// cancelled too (scancel / process-group kill — same lane as
// POST /api/tools/jobs/:id/stop), so stopping a node no longer leaves a
// cluster slot burning until the poll ceiling. Local ToolJobs get the
// best-effort SIGTERM + cancelled row. Both are best-effort: the node's own
// failed verdict is already atomic and independent of job cancellation
// succeeding.
//
// Guards: 404 unknown node, 409 when the node is neither running nor pending
// (idle/terminal nodes have nothing to stop).
//
// This is the node-level half of "看得见也管得住" (the Runs sheet fires it per
// active row and for Stop-all).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO } from "@/lib/workflow-engine";
import { getRun, stopClusterJob } from "@/lib/cluster/cluster-run";
import { CANCELLED_VIA_NODE_STOP } from "@/lib/job-cancel-source";
const STOP_NOTE = "\n[stop] Stopped by user — node marked failed; downstream nodes proceed with no upstream output.";

/** Extract the cluster ToolJob id from a node's run logs (same regex as the
 *  SSE stream's reconcile — matches the normal and poll-ceiling variants). */
function clusterJobIdFromLogs(logs: string): string | null {
  const m = logs.match(/\[cluster run · job ([^\]\s]+)/);
  return m ? m[1] : null;
}

/** Best-effort cancellation of the job linked to this node's logs. Returns a
 *  log note describing the outcome (never throws). */
async function stopLinkedJob(nodeLogs: string): Promise<string | null> {
  const jobId = clusterJobIdFromLogs(nodeLogs ?? "");
  if (!jobId) return null;
  try {
    // Cluster run record present → remote cancellation (scancel / kill).
    // P2-1 fix (QA 30-a): the via-node-stop stderr marker is stamped inside
    // stopClusterJob's own row write (single point, no follow-up window for
    // the reconcile sweep to clobber).
    if (getRun(jobId)) {
      const res = await stopClusterJob(jobId, { viaNodeStop: true });
      return res.ok
        ? `\n[stop] cluster job ${jobId} cancelled on the remote host.`
        : `\n[stop] cluster job ${jobId} could not be cancelled (${res.error}) — it may keep running until its own ceiling.`;
    }
    // Local lane — best-effort SIGTERM to the stored pid + cancelled row.
    const job = await db.toolJob.findUnique({ where: { id: jobId } });
    if (!job) return null;
    if (job.status !== "running") return null;
    let note = `\n[stop] local job ${jobId} marked cancelled`;
    if (job.pid && job.pid > 0) {
      try {
        process.kill(job.pid, "SIGTERM");
        note += ` (SIGTERM → pid ${job.pid})`;
      } catch {
        note += ` (pid ${job.pid} already gone)`;
      }
    }
    await db.toolJob.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        // Two-way badge (ToolJob half): cancel-source trace in stderr.
        stderr: `${job.stderr}${job.stderr ? "\n" : ""}${CANCELLED_VIA_NODE_STOP}`,
      },
    });
    return note + ".";
  } catch (e) {
    return `\n[stop] linked job ${jobId} stop attempt failed (${e instanceof Error ? e.message : String(e)}).`;
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const node = await db.node.findUnique({ where: { id } });
    if (!node) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }
    if (node.status !== "running" && node.status !== "pending") {
      return NextResponse.json(
        {
          error: `Node is ${node.status} — only running or queued nodes can be stopped.`,
        },
        { status: 409 },
      );
    }

    // Best-effort: cancel the linked cluster/local job BEFORE flipping the
    // node (the job-stop lane reads the run record that the poll loop may
    // clear once the row settles).
    const jobNote = await stopLinkedJob(node.logs ?? "");

    const now = new Date();
    // Atomic guard against a concurrent stop/watchdog/settle: only a row still
    // running/pending flips.
    const stopped = await db.node.updateMany({
      where: { id, status: { in: ["running", "pending"] } },
      data: {
        status: "failed",
        result: "Stopped by user before completion.",
        logs: (node.logs ?? "") + STOP_NOTE + (jobNote ?? ""),
        completedAt: now,
      },
    });
    if (stopped.count === 0) {
      // Lost a race — the node settled between our read and the write. The
      // job note (if any) is lost with it, which is fine: the settle owns it.
      return NextResponse.json(
        { error: "Node already settled while stopping — refresh the queue." },
        { status: 409 },
      );
    }

    const final = await db.node.findUnique({ where: { id } });
    return NextResponse.json(
      final
        ? toNodeDTO(final)
        : { error: "Node disappeared after stop" },
      { status: final ? 200 : 500 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
