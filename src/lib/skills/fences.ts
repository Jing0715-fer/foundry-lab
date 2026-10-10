// Fence parsing — unified skill protocol + legacy compatibility.
//
// The model may emit any of:
//   ```skill {"skill":"bio.blast","params":{...}}   ← the unified protocol
//   ```tool  {"tool":"rfdiffusion","params":{...}}  ← legacy comp fence
//   ```bio   {"type":"blast","query":"..."}         ← legacy bio fence
//   ```web   {"query":"..."}                        ← tolerated improvisation
//
// All four normalize to SkillCall { skillId (canonical), params } and flow
// through runSkill. Legacy fences keep working so stored conversations and
// fine-tuned prompts never break; the system prompt teaches ```skill.
//
// Unknown skill ids are NOT silently dropped: the call resolves to the raw
// string and runSkill records an "invalid" invocation — model hallucinations
// become visible in the audit log instead of invisible.

import { resolveSkillId } from "./registry";

export type SkillFence = "skill" | "tool" | "bio" | "web";

export interface SkillCall {
  /** Canonical registry id, or the raw id when unresolvable (→ invalid). */
  skillId: string;
  params: Record<string, unknown>;
  /** Which fence the model actually used (audit/telemetry). */
  fence: SkillFence;
  /** The id exactly as emitted. */
  rawId: string;
}

interface ParsedFence {
  obj: Record<string, unknown>;
  idKey: string;
}

const FENCE_PATTERNS: { fence: SkillFence; re: RegExp }[] = [
  { fence: "skill", re: /```skill\s*\n([\s\S]*?)```/g },
  { fence: "tool", re: /```tool\s*\n([\s\S]*?)```/g },
  { fence: "bio", re: /```bio\s*\n([\s\S]*?)```/g },
  { fence: "web", re: /```web\s*\n([\s\S]*?)```/g },
];

const ID_KEYS: Record<SkillFence, string> = {
  skill: "skill",
  tool: "tool",
  bio: "type",
  web: "skill",
};

/** Context-aware id resolution — the fence family disambiguates bare keys. */
function resolveFor(fence: SkillFence, raw: string): string {
  const prefixed = fence === "skill" ? raw : `${fence}.${raw}`;
  return resolveSkillId(prefixed) ?? resolveSkillId(raw) ?? raw;
}

/** Extract every skill call from an LLM reply, in document order. */
export function extractSkillCalls(text: string): SkillCall[] {
  const calls: SkillCall[] = [];
  for (const { fence, re } of FENCE_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const parsed = parseFenceBody(m[1], fence);
      if (!parsed) continue;
      const rawId = String(parsed.obj[parsed.idKey] ?? "");
      if (!rawId) continue;
      const params =
        parsed.obj.params && typeof parsed.obj.params === "object" &&
        !Array.isArray(parsed.obj.params)
          ? (parsed.obj.params as Record<string, unknown>)
          : stripIdKeys(parsed.obj, parsed.idKey);
      calls.push({
        skillId: resolveFor(fence, rawId),
        params,
        fence,
        rawId,
      });
    }
  }
  return calls;
}

function parseFenceBody(body: string, fence: SkillFence): ParsedFence | null {
  try {
    const obj = JSON.parse(body.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { obj: obj as Record<string, unknown>, idKey: ID_KEYS[fence] };
    }
  } catch {
    // Malformed JSON in a fence — skip (not the same as an unknown skill).
  }
  return null;
}

function stripIdKeys(
  obj: Record<string, unknown>,
  idKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  delete out[idKey];
  delete out.skill;
  delete out.tool;
  delete out.type;
  return out;
}
