// POST /api/screening/[id]/rmsd — compute the structural-RMSD metric axis
// (H1c: RMSD as a weightable screening metric).
//
// Body: { refId } — the candidate to superpose every other candidate against.
// Response: { screening, candidates, scored, skipped } — the FULL detail shape
// (same as GET /api/screening/[id]) plus the compute counters, so the client
// refreshes everything in one round trip.
//
// Guards: 400 invalid body / ref lacks PDB / read failure · 404 screening or
// reference candidate not found.
//
// Runtime premise (QA 38-a P2-6): the compute is O(candidates × PDB parse +
// align) ≈ 100ms per small Fv structure — a 60-candidate campaign takes ~6s.
// This app is self-hosted (dev/Node server, no serverless maxDuration), and
// the client shows a busy spinner for the whole call, so a synchronous
// handler is acceptable here. Revisit (batching/maxDuration) before any
// serverless deployment.

import { NextResponse } from "next/server";
import {
  computeRmsdAxis,
  screeningErrorStatus,
} from "@/lib/screening";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const refId = body.refId;
  if (typeof refId !== "string" || refId.length === 0) {
    return NextResponse.json(
      { error: "refId is required (candidate id to superpose against)" },
      { status: 400 },
    );
  }

  try {
    const result = await computeRmsdAxis(id, refId);
    if (!result) {
      return NextResponse.json({ error: "Screening not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to compute RMSD axis" },
      { status: screeningErrorStatus(err) },
    );
  }
}
