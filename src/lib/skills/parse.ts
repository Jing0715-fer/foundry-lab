// Fence parser — extracts skill calls from an LLM reply in ANY of the three
// protocols:
//
//   ```skill {"id": "bio.blast", "params": {…}}     ← forward protocol
//   ```tool  {"tool": "rfdiffusion", "params": {…}}  ← legacy compute fence
//   ```bio   {"type": "blast", …}                    ← legacy bio fence
//
// Legacy fences normalize through the registry's legacy mapping, so
// persisted history and model imitation keep working. Pure text parsing —
// safe for any runtime.

import { getSkillByLegacyKey } from "./registry";
import type { SkillCall } from "./types";

const SKILL_FENCE = /```skill\s*\n([\s\S]*?)```/g;
const TOOL_FENCE = /```tool\s*\n([\s\S]*?)```/g;
const BIO_FENCE = /```bio\s*\n([\s\S]*?)```/g;

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extract(
  text: string,
  re: RegExp,
  map: (obj: Record<string, unknown>) => SkillCall | null,
): SkillCall[] {
  const out: SkillCall[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const obj = parseJson(m[1]);
    if (!obj) continue;
    const call = map(obj);
    if (call) out.push(call);
  }
  return out;
}

/** Parse every skill call in an LLM reply (all fence protocols). */
export function extractSkillCalls(text: string): SkillCall[] {
  const calls: SkillCall[] = [];

  // Forward protocol: {"id" | "skill": "<id>", "params": {…}}
  calls.push(
    ...extract(text, SKILL_FENCE, (obj) => {
      const id = typeof obj.id === "string" ? obj.id : typeof obj.skill === "string" ? obj.skill : "";
      if (!id.trim()) return null;
      const params =
        obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
          ? (obj.params as Record<string, unknown>)
          : {};
      return { skillId: id.trim(), params };
    }),
  );

  // Legacy compute fence: {"tool": "<key>", "params": {…}} → comp.<key>
  calls.push(
    ...extract(text, TOOL_FENCE, (obj) => {
      if (typeof obj.tool !== "string" || !obj.tool.trim()) return null;
      const def = getSkillByLegacyKey("tool", obj.tool);
      if (!def) {
        // Unknown legacy key — try comp.<key> anyway so the executor can
        // produce its canonical "unknown skill" feedback (better than
        // silently dropping the call).
        return { skillId: `comp.${obj.tool.trim()}`, params: (obj.params as Record<string, unknown>) ?? {} };
      }
      const params =
        obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
          ? (obj.params as Record<string, unknown>)
          : {};
      return { skillId: def.id, params };
    }),
  );

  // Legacy bio fence: {"type": "blast", …rest} → bio.<type>, rest as params
  calls.push(
    ...extract(text, BIO_FENCE, (obj) => {
      if (typeof obj.type !== "string" || !obj.type.trim()) return null;
      const def = getSkillByLegacyKey("bio", obj.type);
      if (!def) return { skillId: `bio.${obj.type.trim()}`, params: obj };
      const { type: _t, ...rest } = obj;
      return { skillId: def.id, params: rest };
    }),
  );

  return calls;
}
