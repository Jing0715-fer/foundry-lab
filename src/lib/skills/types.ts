// Skill layer — the standardized contract for EVERY agent operation (J lane).
//
// Before this layer, agent operations were 8 parallel protocols: ```tool /
// ```bio / ```actions fences, direct REST calls, workflow-internal executors —
// each with its own (or no) validation, its own (or no) audit, and knowledge
// flags (bioToolsEnabled / webSearchEnabled) that were only ever ADVERTISED in
// prompts and never ENFORCED at execution time. This module defines the single
// declarative contract that replaces all of them.
//
// A Skill is: metadata + param schema + eligibility + handler. Everything an
// agent can DO is a skill; everything a skill does flows through runSkill
// (validate → gate → instrument → execute → normalize → audit).

import type { AgentDTO } from "../types";

/** Skill family — also the wire `kind` for backward-compatible ToolCall rows. */
export type SkillFamily = "comp" | "bio" | "web" | "canvas";

/** Where an invocation came from — recorded on every audit row. */
export type SkillSource =
  | "chat"
  | "chat-stream"
  | "workflow"
  | "canvas"
  | "api"
  | "task"
  | "meeting"
  | "research";

/** Terminal statuses of a skill invocation (persisted on SkillInvocation). */
export type SkillStatus = "ok" | "error" | "denied" | "invalid" | "skipped";

/**
 * Knowledge flags an agent must have set for the skill to run. Enforced by
 * runSkill at EXECUTION time whenever a ctx.agent is present — previously
 * these flags only shaped prompt text and a disabled agent's model could
 * still emit a ```bio fence that executed anyway.
 */
export type SkillRequirement = "bioToolsEnabled" | "webSearchEnabled";

/** Primitive param types the validator can coerce + clamp. */
export type SkillParamType = "string" | "number" | "boolean" | "json";

export interface SkillParamDef {
  key: string;
  type: SkillParamType;
  required?: boolean;
  /** Filled in when the LLM omitted the param. */
  default?: string | number | boolean;
  /** Hard clamp for numbers. */
  min?: number;
  max?: number;
  description: string;
}

/** Serializable projection of a SkillDefinition — what /api/skills serves
 *  and what renderSkillManifest consumes. Handlers never cross the wire. */
export interface SkillCatalogEntry {
  id: string;
  family: SkillFamily;
  label: string;
  description: string;
  aliases: string[];
  params: SkillParamDef[];
  requires: SkillRequirement[];
  /** fast (<~10s) | slow (minutes — engines). Streaming lane policy key. */
  latency: "fast" | "slow";
  /** Prompt-facing usage example rendered into system prompts. */
  example?: Record<string, unknown>;
}

export interface SkillDefinition extends SkillCatalogEntry {
  /**
   * Execute the operation. MUST throw on failure — the runner normalizes
   * thrown errors into the result envelope. Return value flows to
   * `summarize` and the audit row.
   */
  handler: (
    params: Record<string, unknown>,
    ctx: SkillContext,
  ) => Promise<unknown>;
  /** Derive the one-line audit/LLM summary from the handler result. */
  summarize?: (result: unknown) => string;
}

/** Execution context threaded through runSkill into handlers. */
export interface SkillContext {
  source: SkillSource;
  /** Present on agent-driven lanes — drives eligibility gating + attribution. */
  agent?: AgentDTO;
  workflowId?: string;
  nodeId?: string;
  /** Handler payload (canvas name→id maps, task ids, live edge lists, …). */
  extras?: Record<string, unknown>;
}

/** Normalized result envelope returned by runSkill for every invocation. */
export interface SkillRunResult {
  skillId: string;
  status: SkillStatus;
  /** Handler payload (present iff status === "ok"). */
  data?: unknown;
  /** One-line human summary — audit row + LLM feedback. */
  summary: string;
  /** Full error/reason text (present iff status !== "ok"). */
  error?: string;
  /** Honest wall-clock duration of the executed (or rejected) operation. */
  durationMs: number;
  /** SkillInvocation row id when the audit write succeeded. */
  invocationId?: string;
}

/** Convert a full definition into its wire-safe catalog projection. */
export function toCatalogEntry(def: SkillDefinition): SkillCatalogEntry {
  return {
    id: def.id,
    family: def.family,
    label: def.label,
    description: def.description,
    aliases: def.aliases,
    params: def.params,
    requires: def.requires,
    latency: def.latency,
    ...(def.example !== undefined ? { example: def.example } : {}),
  };
}
