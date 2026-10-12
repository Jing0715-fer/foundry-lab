// POST /api/tools/jobs/[id]/stop — cancel a running tool job.
//
// Cluster jobs are cancelled ON the cluster (scancel for slurm, process-group
// kill for direct setsid runs). Local jobs get a best-effort SIGTERM to the
// stored pid. Either way the row lands in `cancelled` with a finishedAt.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getRun, stopClusterJob } from "@/lib/cluster/cluster-run";
// K5: skill-queued local jobs register their engine process under
// runKey = jobId — the stop lane kills the REAL process (and arms the
// pre-spawn guard for jobs stopped before the engine spawns).
import { killActiveProcess } from "@/lib/real-executor";
import { requestStop } from "@/lib/stop-registry";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Cluster lane — the run record decides.
    if (getRun(id)) {
      const res = await stopClusterJob(id);
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }

    // Local lane — best-effort kill of the stored pid.
    //
    // K5 (skill-queued jobs): first arm the pre-spawn guard + kill the REAL
    // engine process via the ACTIVE_PROCS registry (runKey = jobId). These
    // rows used to rely on a pid that is never persisted — registry kill is
    // the only real stop for them. Then the pid attempt stays as a fallback
    // for any legacy lane that DID store one.
    requestStop(id);
    const registryKill = killActiveProcess(id);
    const job = await db.toolJob.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Tool job not found" }, { status: 404 });
    }
    let warning: string | undefined;
    if (!registryKill && job.pid && job.pid > 0) {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch (e) {
        warning = `could not kill pid ${job.pid}: ${(e as Error).message}`;
      }
    }
    // Flip the row to cancelled — CONDITIONALLY (a row that already landed
    // completed/failed keeps its natural verdict; only queued/running rows
    // are stoppable). Zero rows = the job finished before the stop arrived.
    const flipped = await db.toolJob.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return NextResponse.json({
      ok: true,
      ...(flipped.count === 0
        ? { detail: "job already finished — row untouched" }
        : registryKill
          ? { detail: "engine process killed (registry)" }
          : {}),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to stop tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
