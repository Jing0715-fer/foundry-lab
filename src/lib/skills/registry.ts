// Skill registry — id/alias resolution + eligibility filtering.
//
// Server-side singleton. The catalog (catalog.ts) registers every built-in
// skill at import time; call sites import { getSkill, listSkills } etc. The
// registry is data-adjacent (definitions carry handlers) — wire consumers get
// the serializable SkillCatalogEntry projection instead.

import type { AgentDTO } from "../types";
import type { SkillCatalogEntry, SkillDefinition } from "./types";
import { toCatalogEntry } from "./types";

const registry = new Map<string, SkillDefinition>();
/** alias / bare comp key → canonical skill id. */
const aliasIndex = new Map<string, string>();

/** Register a skill. Ids and aliases must be unique — a duplicate logs loudly
 *  and wins (registry corruption should never be silent). */
export function registerSkill(def: SkillDefinition): void {
  if (registry.has(def.id)) {
    console.warn(`[skills] duplicate skill id "${def.id}" — overwriting`);
  }
  registry.set(def.id, def);
  for (const alias of def.aliases) {
    aliasIndex.set(alias, def.id);
  }
}

/** Look up a skill by canonical id OR any registered alias. */
export function getSkill(idOrAlias: string): SkillDefinition | undefined {
  const canonical = aliasIndex.get(idOrAlias) ?? idOrAlias;
  return registry.get(canonical);
}

/** All registered skills, stable insertion order (catalog order). */
export function listSkills(): SkillDefinition[] {
  return [...registry.values()];
}

/** Serializable catalog — what /api/skills serves. */
export function catalogEntries(): SkillCatalogEntry[] {
  return listSkills().map(toCatalogEntry);
}

/**
 * Resolve a raw wire id to its canonical skill id:
 *   "comp.rfdiffusion"            → "comp.rfdiffusion"
 *   "rfdiffusion" (bare comp key) → "comp.rfdiffusion"
 *   "tool:rfdiffusion"            → "comp.rfdiffusion"
 *   "bio.blast" / "blast"         → "bio.blast"
 *   "web.search" / "search"       → "web.search"
 * Returns null when nothing matches.
 */
export function resolveSkillId(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Canonical / alias hit.
  const hit = aliasIndex.get(trimmed) ?? (registry.has(trimmed) ? trimmed : undefined);
  if (hit) return hit;
  // Legacy "tool:<key>" and "type:<key>" prefixes from the old fences.
  const prefixed = trimmed.match(/^(?:tool|type|bio|web):(\w+)$/);
  if (prefixed) {
    return resolveSkillId(prefixed[1]);
  }
  // Bare key ("rfdiffusion") → assume comp family.
  if (registry.has(`comp.${trimmed}`)) return `comp.${trimmed}`;
  return null;
}

/** Skills an agent is ELIGIBLE for — the same rule runSkill enforces. */
export function skillsForAgent(agent: AgentDTO): SkillDefinition[] {
  return listSkills().filter((s) =>
    s.requires.every((r) => agent.knowledge[r] === true),
  );
}
