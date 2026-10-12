// Search skills — REAL web search for the agent layer. The knowledge config
// flag `webSearchEnabled` previously existed but no search tool was wired;
// through the skill protocol it now gates a live z-ai SDK search function.

import ZAI from "z-ai-web-dev-sdk";
import { registerSkill } from "./registry";
import type { SkillOutcome } from "./types";

interface SearchHit {
  url: string;
  name: string;
  snippet: string;
  host_name?: string;
  rank?: number;
  date?: string;
}

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getZai() {
  if (_zai) return _zai;
  _zai = await ZAI.create();
  return _zai;
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "(no results)";
  return hits
    .slice(0, 8)
    .map(
      (h) =>
        `- ${h.name}${h.host_name ? ` (${h.host_name})` : ""}${h.date ? ` ${h.date}` : ""}\n` +
        `  ${h.snippet?.slice(0, 200) ?? ""}\n` +
        `  ${h.url}`,
    )
    .join("\n");
}

registerSkill({
  id: "search.websearch",
  name: "Web Search",
  category: "search",
  gate: "search",
  description:
    "Live web search for up-to-date information beyond the model's knowledge — literature, news, methods, documentation. Cite URLs in your answer.",
  params: [
    { name: "query", type: "string", required: true, description: "Search query" },
    { name: "num", type: "number", min: 1, max: 10, default: 5, description: "Results to return" },
    { name: "recency_days", type: "number", min: 1, description: "Only results newer than N days" },
  ],
  timeoutMs: 30_000,
  exampleLine: () => '{"id": "search.websearch", "params": {"query": "RFdiffusion binder design benchmarks 2026"}}',
  execute: async (params): Promise<SkillOutcome> => {
    try {
      const zai = await getZai();
      const args: Record<string, unknown> = {
        query: String(params.query),
        num: Number(params.num ?? 5),
      };
      if (params.recency_days != null && params.recency_days !== "") {
        const d = Number(params.recency_days);
        if (Number.isFinite(d) && d >= 1) args.recency_days = Math.floor(d);
      }
      const invoke = zai.functions.invoke as unknown as (
        name: string,
        a: Record<string, unknown>,
      ) => Promise<SearchHit[]>;
      const hits = (await invoke("web_search", args)) ?? [];
      return {
        ok: true,
        summary: `Web search "${params.query}" returned ${hits.length} result(s):\n${formatHits(hits)}`,
      };
    } catch (e) {
      return {
        ok: false,
        summary: `Web search failed: ${(e as Error).message}`,
      };
    }
  },
});
