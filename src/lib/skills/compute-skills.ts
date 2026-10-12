// Compute skills — the five real algorithm engines wrapped in the skill
// protocol. Thin adapters: executeCompToolReal already owns native →
// built-in-engine dispatch, timeouts, and output bookkeeping; the skill
// layer adds the standardized schema/gate/audit/feedback around it.

import { resolve } from "path";
import { COMP_TOOLS, getCompTool } from "../tools";
import { executeCompToolReal } from "../real-executor";
import { registerSkill } from "./registry";
import type { SkillDefinition, SkillOutcome, SkillParamSpec } from "./types";

/** Derive a compact skill schema from the canonical COMP_TOOLS fields —
 *  single source of truth (a new tool field documents itself). */
function deriveParams(toolKey: string): SkillParamSpec[] {
  const def = getCompTool(toolKey);
  if (!def) return [];
  return def.paramFields
    .filter((f) => !f.advanced) // keep LLM docs concise; advanced flags still validate
    .map((f) => {
      const spec: SkillParamSpec = {
        name: f.key,
        type:
          f.type === "number"
            ? "number"
            : f.type === "bool"
              ? "boolean"
              : f.type === "select"
                ? "enum"
                : "string",
        description: f.hint ?? f.label,
      };
      if (f.required) spec.required = true;
      if (f.default !== "" && f.default !== undefined) spec.default = f.default;
      if (f.options) spec.enumValues = f.options;
      if (f.type === "number") {
        if (f.min !== undefined) spec.min = f.min;
        if (f.max !== undefined) spec.max = f.max;
      }
      return spec;
    });
}

function firstNumericParam(toolKey: string): string {
  const def = getCompTool(toolKey);
  const num = def?.paramFields.find((f) => f.type === "number");
  return num?.key ?? "num_designs";
}

for (const t of COMP_TOOLS) {
  const mainParam = firstNumericParam(t.key);
  const mainDefault = t.paramFields.find((f) => f.key === mainParam)?.default ?? 1;
  registerSkill({
    id: `comp.${t.key}`,
    name: t.label,
    category: "compute",
    gate: "tools",
    description: t.description,
    params: deriveParams(t.key),
    // Local engines finish in seconds-to-minutes; the spawned process has its
    // own timeout in real-executor — the skill watchdog is the outer net.
    timeoutMs: 10 * 60 * 1000,
    legacy: { fence: "tool", key: t.key },
    exampleLine: () => `{"id": "comp.${t.key}", "params": {"${mainParam}": ${mainDefault}}}`,
    execute: async (params, ctx): Promise<SkillOutcome> => {
      const workDir = resolve(
        process.cwd(),
        "outputs",
        t.key,
        `skill-${ctx.caller}-${Date.now()}`,
      );
      try {
        const res = await executeCompToolReal(t.key, params, workDir);
        const ok = res.exitCode === 0;
        const text = (ok ? res.stdout : res.stderr || res.stdout) || "";
        const summary = ok
          ? `${t.resultSummary(params, res.stdout)}\n` +
            `${res.outputFiles.length} output file(s) in ${workDir}` +
            (text ? `\n${text.slice(0, 800)}` : "")
          : `[exit ${res.exitCode}] ${text.slice(0, 800) || "tool failed"}`;
        return { ok, summary, detail: text.slice(0, 1500), files: res.outputFiles };
      } catch (e) {
        return {
          ok: false,
          summary: `${t.label} execution error: ${(e as Error).message}`,
        };
      }
    },
  });
}
