// GET /api/tools/install/[id] — poll an install job's status + live logs.

import { NextRequest, NextResponse } from "next/server";
import { getInstallJob } from "@/lib/install-jobs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getInstallJob(id);
  if (!job) {
    return NextResponse.json({ error: "Install job not found" }, { status: 404 });
  }
  return NextResponse.json(job);
}
