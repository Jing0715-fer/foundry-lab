// POST /api/tools/jobs/[id]/stop — cancel a running tool job.
//
// Cluster jobs are cancelled ON the cluster (scancel for slurm, process-group
// kill for direct setsid runs). Local jobs get a best-effort SIGTERM to the
// stored pid. Either way the row lands in `cancelled` with a finishedAt.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getRun, stopClusterJob } from "@/lib/cluster/cluster-run";

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
    const job = await db.toolJob.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Tool job not found" }, { status: 404 });
    }
    let warning: string | undefined;
    if (job.pid && job.pid > 0) {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch (e) {
        warning = `could not kill pid ${job.pid}: ${(e as Error).message}`;
      }
    }
    await db.toolJob.update({
      where: { id },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return NextResponse.json({ ok: true, warning });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to stop tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
