// Skill runner — THE single execution pipeline for agent operations.
//
//   runSkill(skillId, params, ctx):
//     1. RESOLVE    — registry id/alias lookup (unknown skill → "invalid")
//     2. VALIDATE   — param coercion/clamping against the declared schema
//     3. GATE       — knowledge requirements ENFORCED (agent in ctx + requires)
//     4. EXECUTE    — handler; thrown errors normalized, never leaked raw
//     5. AUDIT      — one SkillInvocation row, best-effort (DB failure must
//                     never break the operation itself)
//
// Specialized executors that keep their own substrate (workflow engine comp
// nodes with cluster routing + auto-wiring, ToolJob queue runs) call
// recordSkillInvocation directly so their operations land in the SAME audit
// table. skipSkill records lane-policy declines (e.g. the streaming chat lane
// refusing slow engine runs) as status "skipped" — the model asked, the lane
// said no, and that is now visible instead of invisible.

import { db } from "@/lib/db";
import { getSkill } from "./registry";
import { checkSkillRateLimit } from "./rate-limit";
import type {
  SkillContext,
  SkillDefinition,
  SkillParamDef,
  SkillRunResult,
  SkillStatus,
} from "./types";

// Convenience re-exports so call sites can import everything runner-related
// from one module.
export type { SkillRunResult, SkillSource, SkillStatus, SkillContext } from "./types";

export interface ParamValidation {
  params: Record<string, unknown>;
  errors: string[];
}

/** Coerce + clamp raw (LLM-emitted) params against a skill's schema.
 *  Unknown keys pass through untouched — handlers decide their meaning. */
export function validateParams(
  def: SkillDefinition,
  raw: Record<string, unknown>,
): ParamValidation {
  const params: Record<string, unknown> = { ...raw };
  const errors: string[] = [];
  for (const p of def.params) {
    const has = p.key in params && params[p.key] !== undefined && params[p.key] !== null;
    if (!has) {
      if (p.default !== undefined) {
        params[p.key] = p.default;
      } else if (p.required) {
        errors.push(`missing required param "${p.key}" (${p.type})`);
      }
      continue;
    }
    const v = params[p.key];
    switch (p.type) {
      case "number": {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          errors.push(`param "${p.key}" must be a number (got ${JSON.stringify(v)})`);
        } else {
          params[p.key] =
            p.min !== undefined || p.max !== undefined
              ? Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n))
              : n;
        }
        break;
      }
      case "boolean": {
        params[p.key] = v === true || v === "true" || v === 1 || v === "1";
        break;
      }
      case "json": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          errors.push(`param "${p.key}" must be a JSON object`);
        }
        break;
      }
      case "string":
      default: {
        if (typeof v === "string") continue;
        if (typeof v === "number" || typeof v === "boolean") {
          params[p.key] = String(v);
        } else {
          errors.push(`param "${p.key}" must be a string (got ${typeof v})`);
        }
        break;
      }
    }
    const s = params[p.key];
    if (p.type === "string" && p.required && !String(s).trim()) {
      errors.push(`param "${p.key}" must be a non-empty string`);
    }
  }
  return { params, errors };
}

/** The pipeline. See module header for the contract. */
export async function runSkill(
  skillId: string,
  rawParams: Record<string, unknown>,
  ctx: SkillContext,
): Promise<SkillRunResult> {
  const t0 = Date.now();

  // 1. Resolve. M3: a miss may mean this module instance's custom-skill
  //    registry is stale (per-route bundles, TTL sync) — force a re-sync
  //    from the table and retry before declaring the id invalid.
  let def = getSkill(skillId);
  if (!def) {
    const { syncCustomSkillsNow } = await import("./dynamic");
    await syncCustomSkillsNow();
    def = getSkill(skillId);
  }
  if (!def) {
    return await finalize(
      {
        skillId: skillId || "(empty)",
        status: "invalid",
        summary: "Unknown skill",
        error: `No skill registered for "${skillId}". See the skill list in your instructions.`,
        durationMs: 0,
      },
      ctx,
      rawParams,
    );
  }

  // 2. Validate.
  const { params, errors } = validateParams(def, rawParams);
  if (errors.length > 0) {
    return await finalize(
      {
        skillId: def.id,
        status: "invalid",
        summary: "Invalid parameters",
        error: errors.join("; "),
        durationMs: Date.now() - t0,
      },
      ctx,
      params,
    );
  }

  // 3. Gate — execution-level enforcement of knowledge requirements.
  if (ctx.agent) {
    const missing = def.requires.filter((r) => ctx.agent?.knowledge[r] !== true);
    if (missing.length > 0) {
      return await finalize(
        {
          skillId: def.id,
          status: "denied",
          summary: `Denied — requires ${missing.join(", ")}`,
          error:
            `This agent has ${missing.join(" and ")} disabled in its knowledge ` +
            "configuration, so the skill was refused at execution time. Tell the " +
            "user to enable it in the agent's settings if they want this capability — " +
            "do not pretend the tool ran.",
          durationMs: Date.now() - t0,
        },
        ctx,
        params,
      );
    }

    // 3.5. Rate limit (K3) — per-agent sliding window, checked AND consumed
    // only when the invocation is about to execute. Anonymous lanes (no
    // ctx.agent) are unlimited. The refusal itself is audited as "limited".
    const rl = checkSkillRateLimit(ctx.agent.id, def);
    if (!rl.allowed) {
      const retryIn = Math.ceil((rl.retryAfterMs ?? 0) / 1000);
      return await finalize(
        {
          skillId: def.id,
          status: "limited",
          summary: `Rate limited — max ${rl.max} per ${Math.round(rl.windowMs / 1000)}s per agent`,
          error:
            `Rate limit reached for skill "${def.id}" — at most ${rl.max} ` +
            `invocations per ${Math.round(rl.windowMs / 1000)}s per agent. ` +
            `Try again in ~${retryIn}s. Do not retry immediately and do not ` +
            "pretend the tool ran — answer from what you already have.",
          durationMs: Date.now() - t0,
        },
        ctx,
        params,
      );
    }
  }

  // 4. Execute.
  try {
    const data = await def.handler(params, ctx);
    const summary = def.summarize ? safeSummarize(def, data) : `${def.label} completed`;
    return await finalize(
      {
        skillId: def.id,
        status: "ok",
        summary,
        durationMs: Date.now() - t0,
        data,
      },
      ctx,
      params,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await finalize(
      {
        skillId: def.id,
        status: "error",
        summary: `${def.label} failed`,
        error: msg,
        durationMs: Date.now() - t0,
      },
      ctx,
      params,
    );
  }
}

/** Record a lane-policy decline (never executes anything). */
export async function skipSkill(
  skillId: string,
  reason: string,
  ctx: SkillContext,
): Promise<SkillRunResult> {
  return await finalize(
    {
      skillId,
      status: "skipped",
      summary: "Skipped by lane policy",
      error: reason,
      durationMs: 0,
    },
    ctx,
    {},
  );
}

/** Audit-only hook for specialized executors (workflow engine, ToolJob runs). */
export async function recordSkillInvocation(entry: {
  skillId: string;
  source: SkillContext["source"];
  status: SkillStatus;
  params: Record<string, unknown>;
  summary?: string;
  error?: string;
  durationMs?: number;
  /** Attribution — structural subset of AgentDTO (id + title). */
  agent?: { id: string; title: string };
  workflowId?: string;
  nodeId?: string;
}): Promise<string | undefined> {
  try {
    const row = await db.skillInvocation.create({
      data: {
        skillId: entry.skillId,
        source: entry.source,
        agentId: entry.agent?.id ?? null,
        agentTitle: entry.agent?.title ?? null,
        workflowId: entry.workflowId ?? null,
        nodeId: entry.nodeId ?? null,
        status: entry.status,
        params: safeJson(entry.params),
        resultSummary: entry.summary ?? null,
        error: entry.error ?? null,
        durationMs: entry.durationMs ?? null,
      },
    });
    return row.id;
  } catch (e) {
    console.warn("[skills] audit write failed:", (e as Error).message);
    return undefined;
  }
}

// ── internals ────────────────────────────────────────────────────────────────

async function finalize(
  result: SkillRunResult,
  ctx: SkillContext,
  params: Record<string, unknown>,
): Promise<SkillRunResult> {
  const invocationId = await recordSkillInvocation({
    skillId: result.skillId,
    source: ctx.source,
    status: result.status,
    params,
    summary: result.status === "ok" ? result.summary : undefined,
    error: result.status === "ok" ? undefined : (result.error ?? result.summary),
    durationMs: result.durationMs,
    agent: ctx.agent,
    workflowId: ctx.workflowId,
    nodeId: ctx.nodeId,
  });
  return invocationId ? { ...result, invocationId } : result;
}

function safeSummarize(def: SkillDefinition, data: unknown): string {
  try {
    return def.summarize!(data) || `${def.label} completed`;
  } catch {
    return `${def.label} completed`;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}

/** Build the feedback message the LLM sees after an invocation — honest for
 *  every terminal status (the old lanes only fed back successes/exceptions). */
export function skillFeedback(res: SkillRunResult): string {
  switch (res.status) {
    case "ok":
      return `[Skill ${res.skillId} succeeded]\n${res.summary}\n\nRevise your answer using these results.`;
    case "error":
      return `[Skill ${res.skillId} failed]\n${res.error}\n\nReport the failure honestly and suggest an alternative.`;
    case "denied":
      return `[Skill ${res.skillId} denied]\n${res.error}`;
    case "invalid":
      return `[Skill ${res.skillId} rejected — invalid request]\n${res.error}\n\nEmit a corrected skill call if you still need it.`;
    case "skipped":
      return `[Skill ${res.skillId} skipped]\n${res.error}`;
    case "limited":
      return `[Skill ${res.skillId} rate limited]\n${res.error}`;
    case "queued":
      return (
        `[Skill ${res.skillId} queued]\n${res.summary}\n\n` +
        "The run executes in the background and is NOT finished yet. Tell the " +
        "user the job has been started, where to watch it (the Skills Activity " +
        "tab — its invocation row flips to ok / error / cancelled when the " +
        "run lands), and that results will appear there when it completes. " +
        "Do not fabricate results — answer from your own knowledge in the meantime."
      );
    case "cancelled":
      return `[Skill ${res.skillId} cancelled]\n${res.error ?? res.summary}`;
  }
}
