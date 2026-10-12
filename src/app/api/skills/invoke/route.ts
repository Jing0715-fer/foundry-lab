// POST /api/skills/invoke — REST invocation of a FAST skill.
//
// K3 companion: gives the rate limiter (and the gating + validation layers)
// a deterministic REST surface to exercise end-to-end — and completes the
// "api" source lane (previously only comp tool runs recorded it).
//
// Contract:
//   body: { skillId: string, params?: object, agentId?: string }
//   - skillId resolves through the registry (aliases like "pdb" work).
//   - agentId, when present, resolves the FULL agent context: knowledge
//     gating AND per-agent rate limits apply exactly like an agent chat
//     turn (this is the honest way to test K3 over HTTP).
//   - Only fast, context-free skills (bio.* / web.*) are invocable here:
//       slow comp skills  → 400 (use POST /api/tools/run or the canvas —
//                           minutes-long requests would just time out)
//       canvas.* skills   → 400 (they require a workflow execution context)
//
// The response body is ALWAYS the SkillRunResult envelope (the same shape
// every lane sees); the HTTP status mirrors the envelope:
//   200 ok | 400 invalid | 403 denied | 429 limited | 500 error (handler)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
// Barrel import — self-registers the catalog (side effect, #40).
import { getSkill, runSkill } from "@/lib/skills";
import { toAgentDTO } from "@/lib/run-utils";
import type { SkillRunResult } from "@/lib/skills";
import type { AgentDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

function httpStatusFor(res: SkillRunResult): number {
  switch (res.status) {
    case "ok":
      return 200;
    case "invalid":
      return 400;
    case "denied":
      return 403;
    case "limited":
      return 429;
    case "error":
      return 500;
    default:
      // queued / skipped / cancelled never come out of runSkill for fast
      // skills — but a defensive 200 keeps the envelope honest if one does.
      return 200;
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
  if (!skillId) {
    return NextResponse.json(
      { error: "skillId is required (e.g. \"bio.pdb\" or \"web.search\")" },
      { status: 400 },
    );
  }
  const rawParams =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const agentId =
    typeof body.agentId === "string" && body.agentId ? body.agentId : null;

  // Resolve the def first so slow/canvas skills get a clear 400 BEFORE any
  // audit row is written (they never entered the pipeline).
  const def = getSkill(skillId);
  if (!def) {
    // Still route unknown ids through runSkill: the pipeline records the
    // honest "invalid" envelope (hallucinations stay visible in the audit
    // log) and returns it — we map that to HTTP 404.
    const res = await runSkill(skillId, rawParams, { source: "api" });
    return NextResponse.json(
      { ...res, error: res.error ?? "Unknown skill" },
      { status: 404 },
    );
  }
  if (def.latency === "slow") {
    return NextResponse.json(
      {
        error:
          `Skill "${def.id}" is a slow engine skill — REST invocation would ` +
          "block for minutes. Use POST /api/tools/run, a cluster/workflow " +
          "lane, or a workflow canvas node instead (agent chat lanes queue " +
          "it automatically).",
      },
      { status: 400 },
    );
  }
  if (def.family === "canvas") {
    return NextResponse.json(
      {
        error:
          `Skill "${def.id}" requires a live workflow execution context ` +
          "(node name maps, live edges) — invoke it through the PI copilot.",
      },
      { status: 400 },
    );
  }

  // Optional agent attribution: gating + rate limits apply (K2/K3 closed
  // loop — the same rules the chat lanes enforce).
  let ctxAgent: AgentDTO | undefined;
  if (agentId) {
    const row = await db.agent.findUnique({ where: { id: agentId } });
    if (!row) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    ctxAgent = toAgentDTO(row);
  }

  const res = await runSkill(def.id, rawParams, {
    source: "api",
    ...(ctxAgent ? { agent: ctxAgent } : {}),
  });

  return NextResponse.json(res, { status: httpStatusFor(res) });
}
