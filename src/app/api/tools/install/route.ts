// POST /api/tools/install  { key } — start a REAL one-click install job.
// GET  /api/tools/install  — list recent install jobs.

import { NextRequest, NextResponse } from "next/server";
import { startInstall, listInstallJobs } from "@/lib/install-jobs";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) {
    return NextResponse.json({ error: "Missing 'key'" }, { status: 400 });
  }
  const result = startInstall(key);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result, { status: 201 });
}

export async function GET() {
  return NextResponse.json({ jobs: listInstallJobs() });
}
