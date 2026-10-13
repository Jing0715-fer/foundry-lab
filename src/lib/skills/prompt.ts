// Skill manifest → LLM system-prompt fragment (PURE, client-safe).
//
// Single source of truth for what the model is TOLD it can do: the fragment
// is rendered from the same registry entries the executor enforces, so the
// prompt and the execution gate can never drift apart (the old system
// hand-maintained fence docs in agents.ts and hand-maintained gates… nowhere).
//
// Import-safe from client components: this module imports ONLY types.

import type { SkillCatalogEntry, SkillParamDef } from "./types";

/** Render the skills the agent is eligible for as a system-prompt fragment.
 *  `knowledge` mirrors the flags the executor gates on — the SAME flags.
 *  P3a: `agentId` gates the per-skill whitelist exactly like runSkill
 *  step 3.25 — the manifest can never advertise a skill the executor
 *  would refuse (and must never hide one it would run). */
export function renderSkillManifest(
  entries: SkillCatalogEntry[],
  knowledge: { webSearchEnabled: boolean; bioToolsEnabled: boolean },
  agentId?: string,
): string {
  const eligible = entries.filter(
    (s) =>
      s.requires.every((r) => knowledge[r] === true) &&
      (!s.agents || s.agents.length === 0 || (agentId ? s.agents.includes(agentId) : false)),
  );
  if (eligible.length === 0) return "";

  const lines: string[] = [];
  lines.push("You may invoke SKILLS by emitting fenced code blocks:");
  lines.push("");
  lines.push("```skill");
  lines.push('{"skill":"<skill-id>","params":{...}}');
  lines.push("```");
  lines.push("");
  lines.push("Available skills:");
  for (const s of eligible) {
    const paramDocs = s.params.map(paramDoc).join(", ");
    lines.push(
      `- ${s.id}: ${s.description}` +
        (paramDocs ? ` (params: ${paramDocs})` : ""),
    );
  }
  lines.push("");
  if (eligible.some((s) => s.example)) {
    lines.push("Example:");
    for (const s of eligible) {
      if (!s.example) continue;
      lines.push("```skill");
      lines.push(JSON.stringify({ skill: s.id, params: s.example }));
      lines.push("```");
    }
    lines.push("");
  }
  // R2: stop-after-the-fence. Q1's grounding fixed what the model does
  // WITH the returned payload, but E2E proved a residual: in the SAME
  // reply as the fence, the model would continue past the closing ``` and
  // write prose describing the tool's RESULT before any result existed
  // (a prior guess, later contradicting the real feedback). This is the
  // source-level suppression: the reply that emits a fence must END at
  // the fence — everything after it would be fabricated by construction.
  lines.push(
    "CRITICAL — stop after each skill fence: the moment you emit a ```skill " +
      "block, END your reply immediately after its closing ```. Do NOT write " +
      "any text after a skill fence in the same reply: the skill has not run " +
      "yet, so any outcome, result, or data you describe there would be a " +
      "guess. Emit the fence, stop, and wait — the system executes the skill " +
      "and returns the actual result as your next input; continue from that.",
  );
  lines.push("");
  lines.push(
    "After each skill call, the system executes it and returns the result. " +
      "Revise your answer using the results. If a skill call fails or is " +
      "denied, report that honestly instead of inventing results.",
  );
  return lines.join("\n");
}

function paramDoc(p: SkillParamDef): string {
  const req = p.required ? "" : "?";
  let doc = `${p.key}${req}`;
  if (p.type === "number") {
    doc += `:number`;
    if (p.min !== undefined || p.max !== undefined) {
      doc += `(${p.min ?? "-∞"}..${p.max ?? "∞"})`;
    }
  } else if (p.type === "boolean") {
    doc += `:bool`;
  } else if (p.type === "json") {
    doc += `:object`;
  } else {
    doc += `:string`;
  }
  return doc;
}
