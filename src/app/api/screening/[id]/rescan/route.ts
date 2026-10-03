// Screening rescan — re-reads the source (node ##OUTPUTS## logs / job
// outputFiles / demo dir) and adds NEW candidates only (no duplicates).

import { NextResponse } from "next/server";
import { rescanScreening, screeningErrorStatus } from "@/lib/screening";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await rescanScreening(id);
    if (!result) {
      return NextResponse.json({ error: "Screening not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to rescan screening" },
      { status: screeningErrorStatus(err) },
    );
  }
}
