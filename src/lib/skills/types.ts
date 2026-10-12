// Skill layer — the standardized capability protocol for the agent layer.
//
// Every operation an agent can invoke (compute engines, bioinformatics
// queries, web search) is registered here as a Skill: one definition with a
// dotted id, a parameter schema, a permission gate, a hard timeout, and an
// execute() implementation. The agent tool-calling loop no longer hard-codes
// comp/bio branches — it parses fenced blocks into skill calls and runs them
// through the single executor (validation → gate → timeout → audit →
// feedback), so every invocation is validated, bounded, observable, and
// reported back to the LLM in one canonical format.
//
// Fence protocol (forward): the system prompt teaches the LLM to emit
//
//   ```skill
//   {"id": "bio.blast", "params": {"sequence": "MKT…", "program": "blastp"}}
//   ```
//
// Legacy fences (```tool {"tool": "rfdiffusion"} / ```bio {"type": "blast"})
// keep parsing — persisted history replays them and models imitate them.

import type { AgentKnowledgeConfig } from "../types";

export type SkillCategory = "compute" | "bio" | "search";

/**
 * Which knowledge-config gate controls the skill:
 * - "tools"  → agent.knowledge.bioToolsEnabled (historical gate for tool+bio
 *              fences — compute AND bio skills share it, unchanged semantics)
 * - "search" → agent.knowledge.webSearchEnabled (now actually enforced —
 *              previously the flag existed but no search tool was wired)
 * - "none"   → always available
 */
export type SkillGate = "tools" | "search" | "none";

/** One parameter of a skill, used for validation + prompt documentation. */
export interface SkillParamSpec {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  enumValues?: string[];
  /** Inclusive numeric bounds when type === "number". */
  min?: number;
  max?: number;
}

export interface SkillDefinition {
  /** Dotted id, e.g. "comp.rfdiffusion" / "bio.blast" / "search.websearch". */
  id: string;
  /** Human display name (Skills panel, audit feed). */
  name: string;
  category: SkillCategory;
  gate: SkillGate;
  /** One-paragraph description for the LLM system prompt + the catalog UI. */
  description: string;
  params: SkillParamSpec[];
  /** Hard execution ceiling (ms) enforced by the executor watchdog. */
  timeoutMs: number;
  /**
   * Legacy fence mapping: when the old ```tool / ```bio protocol names this
   * skill, the parser normalizes it to this skill id. Compute fences key on
   * {"tool": "<key>"}; bio fences key on {"type": "<type>"}.
   */
  legacy?: { fence: "tool" | "bio"; key: string };
  /** Render the ONE example line embedded in the system prompt. */
  exampleLine: () => string;
  execute: (
    params: Record<string, unknown>,
    ctx: SkillContext,
  ) => Promise<SkillOutcome>;
}

/** Who is invoking the skill (audit dimension). */
export type SkillCaller =
  | "agent-chat"
  | "agent-chat-stream"
  | "agent-node"
  | "meeting"
  | "research"
  | "manual";

export interface SkillContext {
  caller: SkillCaller;
  agentId?: string;
  agentTitle?: string;
  /** The invoking agent's knowledge config — permission-gate source. */
  knowledge?: AgentKnowledgeConfig;
}

/** Result contract every skill implementation must satisfy. */
export interface SkillOutcome {
  ok: boolean;
  /** Truncated, LLM-friendly result text fed back into the conversation. */
  summary: string;
  /** Fuller detail for the audit row (executor caps the stored length). */
  detail?: string;
  /** Output artifacts produced (absolute file paths). */
  files?: string[];
}

export type SkillInvocationStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "denied";

/** What the executor returns to the agent loop (feedback ready). */
export interface InvokeResult {
  skillId: string;
  skillName: string;
  category: SkillCategory;
  status: SkillInvocationStatus;
  durationMs: number;
  /** Canonical feedback block pushed into the LLM conversation. */
  feedback: string;
  /** Result summary (audit-grade, truncated) — also used for ToolCall.result. */
  result: string;
  files?: string[];
}

/** Parsed skill call from an LLM reply (any of the three fence protocols). */
export interface SkillCall {
  skillId: string;
  params: Record<string, unknown>;
}
