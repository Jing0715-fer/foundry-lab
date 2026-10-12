// Skill registry — the single source of truth for every agent capability.
// Pure module (no db / child_process imports) so it can be loaded from any
// context; concrete skill implementations register themselves at import time
// (see index.ts, server-only).

import type {
  AgentKnowledgeConfig,
} from "../types";
import type { SkillDefinition, SkillGate } from "./types";

const REGISTRY = new Map<string, SkillDefinition>();

export function registerSkill(def: SkillDefinition): void {
  if (REGISTRY.has(def.id)) {
    throw new Error(`Skill already registered: ${def.id}`);
  }
  REGISTRY.set(def.id, def);
}

export function getSkill(id: string): SkillDefinition | undefined {
  return REGISTRY.get(id);
}

/** All registered skills in stable registration order. */
export function listSkills(): SkillDefinition[] {
  return [...REGISTRY.values()];
}

/** Look up a skill by its LEGACY fence mapping (```tool / ```bio keys). */
export function getSkillByLegacyKey(
  fence: "tool" | "bio",
  key: string,
): SkillDefinition | undefined {
  const k = key.trim().toLowerCase();
  return REGISTRY.get(fence === "tool" ? `comp.${k}` : `bio.${k}`);
}

function gateAllows(
  gate: SkillGate,
  knowledge: AgentKnowledgeConfig | undefined,
): boolean {
  switch (gate) {
    case "none":
      return true;
    case "tools":
      return !!knowledge?.bioToolsEnabled;
    case "search":
      return !!knowledge?.webSearchEnabled;
  }
}

/** Skills an agent may invoke given its knowledge config (gate-filtered). */
export function skillsForKnowledge(
  knowledge: AgentKnowledgeConfig | undefined,
): SkillDefinition[] {
  return listSkills().filter((s) => gateAllows(s.gate, knowledge));
}

/** Compact one-line param doc, e.g. `sequence (string, required)`. */
function paramDoc(p: SkillDefinition["params"][number]): string {
  const bits: string[] = [p.type];
  if (p.required) bits.push("required");
  else if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
  if (p.enumValues?.length) bits.push(`one of ${p.enumValues.join("|")}`);
  if (p.type === "number" && (p.min !== undefined || p.max !== undefined)) {
    bits.push(`${p.min ?? "-∞"}–${p.max ?? "∞"}`);
  }
  return `${p.name} (${bits.join(", ")}) — ${p.description}`;
}

/**
 * Render the skill-invocation section of an agent system prompt from the
 * registry — the single source of truth (the hand-written fence docs in
 * agents.ts are replaced by this; every new skill automatically documents
 * itself).
 */
export function describeSkillsForPrompt(
  knowledge: AgentKnowledgeConfig | undefined,
): string {
  const skills = skillsForKnowledge(knowledge);
  if (skills.length === 0) return "";

  const lines: string[] = [];
  lines.push("You may invoke skills by emitting fenced code blocks:");
  lines.push("");
  lines.push("  ```skill");
  lines.push('  {"id": "<skillId>", "params": {…}}');
  lines.push("  ```");
  lines.push("");
  lines.push("Available skills:");
  for (const s of skills) {
    lines.push(`- ${s.id} — ${s.description}`);
    if (s.params.length) {
      lines.push(`    params: ${s.params.map(paramDoc).join("; ")}`);
    }
  }
  lines.push("");
  lines.push("Example:");
  lines.push("  ```skill");
  lines.push(`  ${s0Example(skills[0])}`);
  lines.push("  ```");
  lines.push("");
  lines.push(
    "After each skill call, wait for the system to return results, then revise your answer. " +
      "One skill block per line of reasoning; only invoke a skill when its result materially helps.",
  );
  return lines.join("\n");
}

function s0Example(s: SkillDefinition): string {
  const ex = s.exampleLine();
  return ex.startsWith("{") ? ex : `{ "id": "${s.id}", "params": ${ex} }`;
}
