// Run a bioinformatics query (blast | pdb | pubmed | uniprot).
// The URL segment selects the tool; the POST body is the params object.
//
// J lane: executes through the skill pipeline — the SAME validate → gate →
// execute → audit path as agent chat, workflow biotool nodes, and the PI.
// The response envelope keeps the legacy BioResult shape (clients unchanged).

import { NextResponse } from "next/server";
import { runSkill, getSkill } from "@/lib/skills";
import type { BioResult } from "@/lib/bio-tools";

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
    // Allow empty body — the skill's defaults fill in.
    body = {};
  }

  const res = await runSkill(`bio.${type}`, body, { source: "api" });

  if (res.status === "ok") {
    // Skill handler returns the BioResult (error-free on the ok path).
    const data = res.data as BioResult;
    return NextResponse.json(data);
  }

  // invalid → 400 (client's fault); error/denied → 502/403 with honest detail.
  const status = res.status === "invalid" ? 400 : res.status === "denied" ? 403 : 502;
  const def = getSkill(`bio.${type}`);
  return NextResponse.json(
    {
      error: "Bio tool query failed",
      skillId: res.skillId,
      detail: res.error,
      // Legacy BioResult shape for clients that render hits arrays.
      tool: type,
      count: 0,
      hits: [],
      simulated: false,
      ...(def?.label ? { label: def.label } : {}),
    },
    { status },
  );
}
