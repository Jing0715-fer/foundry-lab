// Skill executor — the ONE standardized invocation pipeline every agent
// operation flows through:
//
//   invokeSkill(id, params, ctx)
//     1. registry lookup        → unknown skill       → failed  (audited)
//     2. permission gate        → knowledge mismatch  → denied  (audited)
//     3. param validation       → coerce + defaults   → failed   (audited)
//     4. execution w/ watchdog  → timeoutMs ceiling   → timeout  (audited)
//     5. audit row (SkillInvocation) — fire-and-forget, never blocks the loop
//     6. canonical feedback block pushed back into the LLM conversation
//
// The timeout is a NET, not the primary bound: compute skills run real
// engines whose own process-level timeouts apply first, bio queries carry
// AbortController timeouts, and search is SDK-bounded. The skill-level
// watchdog guarantees the agent loop can never wedge on one invocation.

import { db } from "../db";
import { getSkill } from "./registry";
import type {
  InvokeResult,
  SkillContext,
  SkillDefinition,
  SkillInvocationStatus,
  SkillOutcome,
} from "./types";

/** Cap for text stored in the audit row / ToolCall result. */
const AUDIT_TEXT_CAP = 2000;

export class SkillTimeoutError extends Error {
  constructor(ms: number) {
    super(`skill watchdog timeout after ${ms}ms`);
    this.name = "SkillTimeoutError";
  }
}

/** Coerce + validate raw params against the skill's schema. */
export function validateSkillParams(
  def: SkillDefinition,
  raw: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  const known = new Map(def.params.map((p) => [p.name, p]));
  for (const p of def.params) {
    const v = raw[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) {
        errors.push(`missing required param "${p.name}" (${p.type})`);
      } else if (p.default !== undefined) {
        out[p.name] = p.default;
      }
      continue;
    }
    switch (p.type) {
      case "string":
      case "enum": {
        const s = typeof v === "string" ? v : String(v);
        if (p.type === "enum" && !p.enumValues?.includes(s)) {
          errors.push(`"${p.name}" must be one of ${p.enumValues?.join("|")}`);
          continue;
        }
        out[p.name] = s;
        break;
      }
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push(`"${p.name}" must be a number (got ${JSON.stringify(v)})`);
          continue;
        }
        let clamped = n;
        if (p.min !== undefined && clamped < p.min) clamped = p.min;
        if (p.max !== undefined && clamped > p.max) clamped = p.max;
        out[p.name] = clamped;
        break;
      }
      case "boolean": {
        if (typeof v === "boolean") out[p.name] = v;
        else if (v === "true" || v === 1 || v === "1") out[p.name] = true;
        else if (v === "false" || v === 0 || v === "0") out[p.name] = false;
        else errors.push(`"${p.name}" must be a boolean`);
        break;
      }
    }
  }
  // Unknown extras are passed through untouched (engines tolerate extra
  // params; stripping them would silently break e.g. advanced flags).
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k) && v !== undefined) out[k] = v;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, params: out };
}

/** Gate check — mirrors the knowledge config semantics. */
function gateDenied(
  def: SkillDefinition,
  ctx: SkillContext,
): string | null {
  if (def.gate === "tools" && !ctx.knowledge?.bioToolsEnabled) {
    return (
      `skill ${def.id} requires the agent's tool access to be enabled ` +
      "(knowledge config: bioToolsEnabled=false)"
    );
  }
  if (def.gate === "search" && !ctx.knowledge?.webSearchEnabled) {
    return (
      `skill ${def.id} requires the agent's web search to be enabled ` +
      "(knowledge config: webSearchEnabled=false)"
    );
  }
  return null;
}

function cap(s: string | undefined): string | null {
  if (!s) return null;
  return s.length > AUDIT_TEXT_CAP ? s.slice(0, AUDIT_TEXT_CAP) + "…" : s;
}

/** Fire-and-forget audit write — never blocks or fails the invocation. */
function audit(
  def: SkillDefinition,
  ctx: SkillContext,
  status: SkillInvocationStatus,
  durationMs: number,
  params: Record<string, unknown>,
  result: string | null,
  error: string | null,
): void {
  void db.skillInvocation
    .create({
      data: {
        skillId: def.id,
        skillName: def.name,
        category: def.category,
        caller: ctx.caller,
        agentId: ctx.agentId ?? null,
        agentTitle: ctx.agentTitle ?? null,
        status,
        durationMs: Math.max(0, Math.round(durationMs)),
        params: JSON.stringify(params),
        resultSummary: result === null ? undefined : cap(result),
        error: error === null ? undefined : cap(error),
      },
    })
    .catch(() => {
      // Audit is best-effort (DB hiccup must never break the agent loop).
    });
}

function feedbackFor(
  def: Pick<SkillDefinition, "id">,
  status: SkillInvocationStatus,
  durationMs: number,
  body: string,
): string {
  const secs = (durationMs / 1000).toFixed(1);
  return (
    `[Skill result: ${def.id} — ${status} (${secs}s)]\n` +
    // Fence neutralization (QA P2-3): a search snippet or tool stdout that
    // itself contains ``` fences could be echoed by the model as a live
    // skill call — escaping keeps the feedback inert when read back.
    `${body.replace(/```/g, "`\u200b`\u200b`")}\n\nUse this result to revise your answer.`
  );
}

/**
 * Invoke a skill through the standardized pipeline. NEVER throws — every
 * failure mode is normalized into an InvokeResult the agent loop can feed
 * straight back into the conversation.
 */
export async function invokeSkill(
  skillId: string,
  rawParams: Record<string, unknown>,
  ctx: SkillContext,
): Promise<InvokeResult> {
  const t0 = Date.now();

  // 1. Registry lookup.
  const def = getSkill(skillId);
  if (!def) {
    const msg =
      `unknown skill "${skillId}". Check the skill id and parameter ` +
      "spelling against the documented list.";
    // Audited even without a definition (QA P2-2): unknown-id attempts are
    // the most useful signal for prompt tuning — they land in the Skills
    // panel feed with status failed instead of vanishing.
    void db.skillInvocation
      .create({
        data: {
          skillId,
          skillName: skillId,
          category: "unknown",
          caller: ctx.caller,
          agentId: ctx.agentId ?? null,
          agentTitle: ctx.agentTitle ?? null,
          status: "failed",
          durationMs: 0,
          params: JSON.stringify(rawParams),
          error: msg,
        },
      })
      .catch(() => {});
    return {
      skillId,
      skillName: skillId,
      // Unknown ids default to the comp lane ONLY for the ToolCall kind
      // label — the audit row carries the honest "unknown" category.
      category: "compute",
      status: "failed",
      durationMs: 0,
      feedback: feedbackFor({ id: skillId }, "failed", 0, msg),
      result: msg,
    };
  }

  // 2. Permission gate.
  const denied = gateDenied(def, ctx);
  if (denied) {
    audit(def, ctx, "denied", 0, rawParams, null, denied);
    return {
      skillId: def.id,
      skillName: def.name,
      category: def.category,
      status: "denied",
      durationMs: 0,
      feedback: feedbackFor(def, "denied", 0, denied),
      result: denied,
    };
  }

  // 3. Param validation.
  const validated = validateSkillParams(def, rawParams);
  if (!validated.ok) {
    const msg =
      `invalid parameters for ${def.id}:\n` +
      validated.errors.map((e) => `- ${e}`).join("\n");
    audit(def, ctx, "failed", Date.now() - t0, rawParams, null, msg);
    return {
      skillId: def.id,
      skillName: def.name,
      category: def.category,
      status: "failed",
      durationMs: Date.now() - t0,
      feedback: feedbackFor(def, "failed", Date.now() - t0, msg),
      result: msg,
    };
  }
  const params = validated.params;

  // 4. Execution with the skill-level watchdog.
  let outcome: SkillOutcome;
  let status: SkillInvocationStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SkillTimeoutError(def.timeoutMs)), def.timeoutMs);
    });
    outcome = await Promise.race([def.execute(params, ctx), timeoutPromise]);
    status = outcome.ok ? "completed" : "failed";
  } catch (err) {
    if (err instanceof SkillTimeoutError) {
      status = "timeout";
      const msg = `${def.name} did not finish within ${def.timeoutMs / 1000}s — the invocation was abandoned. Tell the user this step timed out and suggest a smaller input or the workflow canvas for long runs.`;
      outcome = { ok: false, summary: msg };
    } else {
      status = "failed";
      const msg = `execution error: ${(err as Error).message}`;
      outcome = { ok: false, summary: msg };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const durationMs = Date.now() - t0;

  // 5. Audit (fire-and-forget).
  audit(
    def,
    ctx,
    status,
    durationMs,
    params,
    status === "completed" ? outcome.summary : null,
    status === "completed" ? null : outcome.summary,
  );

  // 6. Canonical feedback.
  const body =
    status === "completed"
      ? outcome.summary || "(no output)"
      : outcome.summary || "(failed)";
  return {
    skillId: def.id,
    skillName: def.name,
    category: def.category,
    status,
    durationMs,
    feedback: feedbackFor(def, status, durationMs, body),
    result: outcome.summary,
    files: outcome.files,
  };
}
