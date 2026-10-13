// K3 — per-agent skill rate limiting (abuse protection).
//
// A tiny sliding-window limiter enforced inside the runSkill pipeline
// (step 3.5, AFTER eligibility gating, BEFORE execution):
//
//   key   = `<agentId>::<skillId>`
//   rule  = def.rateLimit ?? FAMILY_RATE_LIMITS[def.family]
//   allow = (timestamps in window).length < rule.max
//
// Semantics (deliberate):
//  - Only AGENT-driven invocations are limited. Anonymous REST / user-
//    initiated lanes (no ctx.agent) are unlimited — the same trust level
//    POST /api/tools/run already grants. The abuse scenario is a looping
//    model, not a clicking human.
//  - A slot is CONSUMED only when the invocation will actually execute
//    (ok/error outcomes). denied / invalid / limited never consume —
//    refusing a call costs nothing and must not lock the agent out.
//  - The window is in-memory per server process (same lifetime caveat as
//    ACTIVE_PROCS / STOP_REQUESTED — see test conclusion #43). A dev-server
//    restart resets limits; that is acceptable for operational state.
//  - Every "limited" refusal lands in the audit table like every other
//    invocation outcome, so K1 insights can trend it.

import type { SkillDefinition, SkillFamily } from "./types";

/** Family defaults — engines are expensive, live APIs are cheap. */
export const FAMILY_RATE_LIMITS: Record<
  SkillFamily,
  { max: number; windowMs: number }
> = {
  // Comp engines: minutes of real CPU per call (chat-lane calls now go
  // through the K5 ToolJob queue — 6 queued engine runs per 15 min per
  // agent is already generous for a research assistant).
  comp: { max: 6, windowMs: 15 * 60_000 },
  // Bio APIs: live-but-cheap URL queries (1–3s each).
  bio: { max: 12, windowMs: 60_000 },
  // Web search: real metered upstream — strictest.
  web: { max: 6, windowMs: 60_000 },
  // Canvas mutations: cheap DB writes.
  canvas: { max: 30, windowMs: 60_000 },
  // M3 custom webhooks: external HTTP calls someone registered on purpose
  // — same ballpark as the bio family (12/min per agent).
  custom: { max: 12, windowMs: 60_000 },
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Present when refused — ms until the oldest slot frees up. */
  retryAfterMs?: number;
  /** The rule that was applied (family default or per-skill override). */
  max: number;
  windowMs: number;
}

// agentId::skillId → execution-start timestamps (sliding window).
const WINDOWS = new Map<string, number[]>();

/** Effective rule for a skill: per-skill override or family default. */
export function effectiveRateLimit(
  def: Pick<SkillDefinition, "family" | "rateLimit">,
): { max: number; windowMs: number } {
  if (
    def.rateLimit &&
    typeof def.rateLimit.max === "number" &&
    def.rateLimit.max > 0 &&
    typeof def.rateLimit.windowMs === "number" &&
    def.rateLimit.windowMs > 0
  ) {
    return def.rateLimit;
  }
  return FAMILY_RATE_LIMITS[def.family];
}

/**
 * Check AND consume in one step (only call this when the invocation is
 * about to execute — see module header for the cost semantics).
 */
export function checkSkillRateLimit(
  agentId: string,
  def: Pick<SkillDefinition, "id" | "family" | "rateLimit">,
): RateLimitDecision {
  const rule = effectiveRateLimit(def);
  const key = `${agentId}::${def.id}`;
  const now = Date.now();
  const cutoff = now - rule.windowMs;

  const prior = (WINDOWS.get(key) ?? []).filter((t) => t > cutoff);
  if (prior.length >= rule.max) {
    // Refused — do NOT consume (the oldest slot already gates the retry).
    WINDOWS.set(key, prior);
    const retryAfterMs = Math.max(1, prior[0] + rule.windowMs - now);
    return { allowed: false, retryAfterMs, ...rule };
  }

  prior.push(now);
  WINDOWS.set(key, prior);
  return { allowed: true, ...rule };
}

/** Test hook — clear every window (QA scripts + module reload discipline). */
export function resetSkillRateLimits(): void {
  WINDOWS.clear();
}
