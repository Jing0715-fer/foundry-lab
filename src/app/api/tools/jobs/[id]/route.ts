// Single tool job API — fetch (with a bounded cluster reconcile sweep first
// so cluster-dispatched jobs reflect fresh remote state).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileClusterJobs } from "@/lib/cluster/cluster-run";
import { toToolJobDTO, enrichCluster } from "../route";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Bounded sweep (1.2s) — same contract as the jobs list route.
    await Promise.race([
      reconcileClusterJobs(),
      new Promise<void>((r) => setTimeout(r, 1200)),
    ]).catch(() => {});
    const job = await db.toolJob.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Tool job not found" }, { status: 404 });
    }
    return NextResponse.json(enrichCluster(toToolJobDTO(job)));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
