// Run a bioinformatics query (blast | pdb | pubmed | uniprot).
// The URL segment selects the tool; the POST body is the params object.

import { NextResponse } from "next/server";
import { runBio } from "@/lib/bio-tools";

const VALID_TYPES = new Set(["blast", "pdb", "pubmed", "uniprot"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  const { type } = await params;
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json(
      {
        error: `Invalid bio tool type. Must be one of: ${[...VALID_TYPES].join(", ")}`,
      },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Allow empty body — runBio will fall back to defaults.
    body = {};
  }

  try {
    const result = await runBio(
      type as "blast" | "pdb" | "pubmed" | "uniprot",
      body,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Bio tool query failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
