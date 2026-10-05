// Screening promotion — POST { ids, nodeName?, workflowId? } → creates an
// "input" node on the TARGET workflow (explicit workflowId, else the first
// workflow) whose logs embed the promoted files in a ##OUTPUTS## trailer
// (workflow-engine autoWireToolInputs auto-wires pdb_path/fasta_path on
// downstream tool nodes). Candidates are marked status "promoted".

import { NextResponse } from "next/server";
import {
  promoteCandidates,
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

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "ids must be a non-empty array of candidate ids" },
      { status: 400 },
    );
  }
  const nodeName =
    typeof body.nodeName === "string" && body.nodeName.trim()
      ? body.nodeName.trim()
      : undefined;
  // Optional target workflow — the promote-dialog sends the CURRENT workflow
  // from the store (multi-workflow safe). Absent → legacy first workflow.
  const workflowId =
    typeof body.workflowId === "string" && body.workflowId.trim()
      ? body.workflowId.trim()
      : undefined;

  try {
    const result = await promoteCandidates(
      id,
      ids as string[],
      nodeName,
      workflowId,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to promote candidates" },
      { status: screeningErrorStatus(err) },
    );
  }
}
