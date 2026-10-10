// Skill catalog — every built-in skill, registered on import.
//
// Four families:
//   comp.*   — the 11 computational tools, schemas derived from COMP_TOOLS'
//              own paramFields (single source of truth — the skill schema can
//              never disagree with the tool form).
//   bio.*    — BLAST / PDB / PubMed / UniProt live queries.
//   web.*    — web search via z-ai-web-dev-sdk. NEW capability: webSearch
//              was advertised in prompts since V2 but had NO execution path;
//              this is the first real implementation.
//   canvas.* — PI orchestrator graph mutations (create_node / create_edge),
//              same invariants as the user-drawn equivalents.
//
// Server-only: imports the real executors, the SDK, and the DB.

import { COMP_TOOLS, type CompParamField } from "../tools";
import { runBio, type BioResult } from "../bio-tools";
import { executeCompToolReal } from "../real-executor";
import { getZaiClient } from "../llm";
import { db } from "@/lib/db";
import { nodeSpec } from "../workflow-catalog";
import { wouldCreateCycle } from "../canvas-utils";
import { registerSkill } from "./registry";
import type { SkillParamDef } from "./types";
import { resolve } from "path";

// ── comp.* ───────────────────────────────────────────────────────────────────

function compParamDef(f: CompParamField): SkillParamDef {
  const type: SkillParamDef["type"] =
    f.type === "number" ? "number" : f.type === "bool" ? "boolean" : "string";
  return {
    key: f.key,
    type,
    required: f.required,
    ...(f.default !== "" && f.default !== undefined
      ? { default: f.default as string | number | boolean }
      : {}),
    ...(type === "number" && f.min !== undefined ? { min: f.min } : {}),
    ...(type === "number" && f.max !== undefined ? { max: f.max } : {}),
    description: f.hint ?? f.label,
  };
}

for (const t of COMP_TOOLS) {
  registerSkill({
    id: `comp.${t.key}`,
    family: "comp",
    label: t.label,
    description: t.description,
    aliases: [t.key],
    params: t.paramFields.map(compParamDef),
    requires: ["bioToolsEnabled"],
    latency: "slow",
    example: exampleForComp(t.key),
    handler: async (params, ctx) => {
      // Chat-lane comp execution = the local real engines (same as the
      // pre-skill runAgentTurn lane). Cluster routing stays a workflow-node
      // concern (recorded via recordSkillInvocation there).
      const stamp = ctx.nodeId ?? ctx.agent?.id?.slice(-6) ?? "anon";
      const workDir = resolve(
        process.cwd(),
        "outputs",
        t.key,
        `skill-${stamp}-${Date.now()}`,
      );
      const res = await executeCompToolReal(t.key, params, workDir);
      if (res.exitCode !== 0) {
        throw new Error(
          `${t.label} exited with code ${res.exitCode}:\n${(res.stderr || res.stdout).slice(-400)}`,
        );
      }
      return { params, stdout: res.stdout, files: res.outputFiles };
    },
    summarize: (data) => {
      const d = data as { params: Record<string, unknown>; stdout: string };
      const files = (data as { files?: string[] }).files ?? [];
      const base = t.resultSummary(d.params, d.stdout);
      return files.length ? `${base}\nArtifacts: ${files.join(", ")}` : base;
    },
  });
}

function exampleForComp(key: string): Record<string, unknown> | undefined {
  switch (key) {
    case "rfdiffusion":
      return { num_designs: 4, contigmap: "100" };
    case "rfantibody":
      return { num_designs: 2 };
    case "proteinmpnn":
    case "ligandmpnn":
    case "solublempnn":
      return { num_seq: 4, pdb_path: "outputs/design.pdb" };
    case "alphafold":
      return { sequence: ">query\nMKTAYIAKQRQISFVKSHFSRQLEERLGLI" };
    default:
      return undefined;
  }
}

// ── bio.* ────────────────────────────────────────────────────────────────────

function bioSkill(
  key: "blast" | "pdb" | "pubmed" | "uniprot",
  label: string,
  description: string,
  params: SkillParamDef[],
) {
  registerSkill({
    id: `bio.${key}`,
    family: "bio",
    label,
    description,
    aliases: [key],
    params,
    requires: ["bioToolsEnabled"],
    latency: "fast",
    handler: async (p) => {
      const res = await runBio(key, p);
      // BioResult.error = the live API failed — surface as a real error
      // (same honesty rule as the workflow biotool node: never paint a
      // failed API call green).
      if (res.error) throw new Error(res.error);
      return res;
    },
    summarize: (data) => {
      const res = data as BioResult;
      const hits = res.hits.map((h) => `- ${h.id}: ${h.title}`).join("\n");
      return `${res.count} hits from ${label}${hits ? `:\n${hits}` : ""}`;
    },
  });
}

bioSkill("blast", "BLAST", "NCBI BLAST sequence homology search (live URL-API, RID polling).", [
  { key: "sequence", type: "string", required: true, description: "Query amino-acid / nucleotide sequence" },
  { key: "program", type: "string", default: "blastp", description: "blastp | blastn | psi-blast" },
  { key: "database", type: "string", default: "swissprot", description: "NCBI database name" },
  { key: "maxResults", type: "number", default: 5, min: 1, max: 10, description: "Hit list size" },
]);
bioSkill("pdb", "PDB Search", "RCSB PDB structure search (live search API v2).", [
  { key: "query", type: "string", description: "Full-text search term (or use id)" },
  { key: "id", type: "string", description: "Specific PDB entry id, e.g. 4HRM" },
  { key: "maxResults", type: "number", default: 5, min: 1, max: 10, description: "Row count" },
]);
bioSkill("pubmed", "PubMed", "PubMed literature search (NCBI EUtils).", [
  { key: "query", type: "string", required: true, description: "Search term / MeSH query" },
  { key: "maxResults", type: "number", default: 5, min: 1, max: 10, description: "Result count" },
  { key: "sortBy", type: "string", description: "relevance | pub_date" },
]);
bioSkill("uniprot", "UniProt", "UniProt protein annotation search (live REST).", [
  { key: "query", type: "string", description: "Search query (or use accession)" },
  { key: "accession", type: "string", description: "Specific UniProt accession" },
  { key: "maxResults", type: "number", default: 5, min: 1, max: 10, description: "Result count" },
  { key: "reviewed", type: "boolean", description: "Only reviewed (Swiss-Prot) entries" },
]);

// ── web.* ────────────────────────────────────────────────────────────────────

interface WebSearchItem {
  url: string;
  name: string;
  snippet: string;
  host_name?: string;
  rank?: number;
  date?: string;
}

registerSkill({
  id: "web.search",
  family: "web",
  label: "Web Search",
  description: "Live web search — current information, literature, news, and documentation.",
  aliases: ["search", "websearch"],
  params: [
    { key: "query", type: "string", required: true, description: "Search keywords" },
    { key: "num", type: "number", default: 8, min: 1, max: 20, description: "Result count" },
    { key: "recencyDays", type: "number", description: "Only results from the last N days (omit for all time)" },
  ],
  requires: ["webSearchEnabled"],
  latency: "fast",
  example: { query: "RFdiffusion binder design benchmarks", num: 5 },
  handler: async (p) => {
    const zai = await getZaiClient();
    const invoke = zai.functions.invoke as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    const args: Record<string, unknown> = { query: p.query, num: p.num };
    if (typeof p.recencyDays === "number" && p.recencyDays > 0) {
      args.recency_days = p.recencyDays;
    }
    const results = await invoke("web_search", args);
    if (!Array.isArray(results)) {
      throw new Error("web_search returned an unexpected (non-array) response");
    }
    return results as WebSearchItem[];
  },
  summarize: (data) => {
    const items = data as WebSearchItem[];
    const list = items
      .map((r) => `- ${r.name}${r.host_name ? ` (${r.host_name})` : ""}: ${r.snippet?.slice(0, 140) ?? ""}`)
      .join("\n");
    return `${items.length} web results${list ? `:\n${list}` : ""}`;
  },
});

// ── canvas.* (PI orchestrator graph mutations) ───────────────────────────────
//
// ctx.extras contract (supplied by /api/pi/orchestrate):
//   workflowId    — target workflow
//   nodeNameToId  — live Map<string, string> (existing + created nodes)
//   liveEdges     — live mutable edge array for duplicate/cycle checks

interface CanvasExtras {
  workflowId: string;
  nodeNameToId: Map<string, string>;
  liveEdges: {
    fromNodeId: string;
    toNodeId: string;
    fromPort: string | null;
    toPort: string | null;
  }[];
}

function canvasExtras(ctx: { extras?: Record<string, unknown> }): CanvasExtras {
  const e = ctx.extras as Partial<CanvasExtras> | undefined;
  if (!e?.workflowId || !(e.nodeNameToId instanceof Map) || !Array.isArray(e.liveEdges)) {
    throw new Error("canvas skills require workflowId, nodeNameToId and liveEdges in the execution context");
  }
  return e as CanvasExtras;
}

registerSkill({
  id: "canvas.create_node",
  family: "canvas",
  label: "Create Canvas Node",
  description: "Create a node on the workflow canvas. Node types: see the palette (input/agent/meeting/research/comp tools/biotool/output).",
  aliases: ["create_node"],
  params: [
    { key: "nodeType", type: "string", required: true, description: "Palette node type, e.g. input | agent | rfdiffusion | biotool | meeting" },
    { key: "nodeName", type: "string", required: true, description: "Unique node name on this canvas" },
    { key: "nodeRefTitle", type: "string", description: "For agent nodes — the agent title to reference" },
    { key: "params", type: "json", description: "Node params object (e.g. {text: '…'} or {num_designs: 4})" },
  ],
  requires: [],
  latency: "fast",
  handler: async (p, ctx) => {
    const ex = canvasExtras(ctx);
    const nodeType = String(p.nodeType);
    const nodeName = String(p.nodeName);
    if (!nodeSpec(nodeType)) {
      throw new Error(`Invalid nodeType "${nodeType}" — must be a canvas palette type (NODE_SPECS).`);
    }
    // Idempotent: re-emitted create_node for an existing name is a no-op
    // (same semantics the PI route had inline).
    if (ex.nodeNameToId.has(nodeName)) {
      return { nodeId: ex.nodeNameToId.get(nodeName), name: nodeName, alreadyExisted: true };
    }
    // Resolve agent refId by title (top-level field first, params fallback —
    // the LLM occasionally nests nodeRefTitle).
    let refId: string | null = null;
    const refTitle =
      (typeof p.nodeRefTitle === "string" && p.nodeRefTitle) ||
      (typeof p.params === "object" && p.params !== null
        ? (p.params as Record<string, unknown>).nodeRefTitle
        : undefined);
    if (nodeType === "agent" && typeof refTitle === "string" && refTitle) {
      const agent = await db.agent.findFirst({ where: { title: refTitle } });
      if (agent) refId = agent.id;
    }
    // Grid positioning (same as the old inline code).
    const col = Math.floor(ex.nodeNameToId.size / 4);
    const row = ex.nodeNameToId.size % 4;
    const node = await db.node.create({
      data: {
        workflowId: ex.workflowId,
        type: nodeType,
        name: nodeName,
        x: 80 + col * 320,
        y: 80 + row * 170,
        refId,
        params: p.params ? JSON.stringify(p.params) : "{}",
        status: "idle",
      },
    });
    ex.nodeNameToId.set(node.name, node.id);
    return { nodeId: node.id, name: nodeName, alreadyExisted: false };
  },
  summarize: (data) => {
    const d = data as { name: string; alreadyExisted: boolean };
    return d.alreadyExisted
      ? `Node "${d.name}" already existed — no-op`
      : `Created node "${d.name}"`;
  },
});

registerSkill({
  id: "canvas.create_edge",
  family: "canvas",
  label: "Connect Canvas Nodes",
  description: "Create an edge between two named canvas nodes (port-aware, duplicate- and cycle-checked).",
  aliases: ["create_edge"],
  params: [
    { key: "fromNodeName", type: "string", required: true, description: "Source node name" },
    { key: "toNodeName", type: "string", required: true, description: "Target node name" },
    { key: "fromPort", type: "string", description: "Source port (optional)" },
    { key: "toPort", type: "string", description: "Target port (optional)" },
  ],
  requires: [],
  latency: "fast",
  handler: async (p, ctx) => {
    const ex = canvasExtras(ctx);
    const fromId = ex.nodeNameToId.get(String(p.fromNodeName));
    const toId = ex.nodeNameToId.get(String(p.toNodeName));
    if (!fromId) throw new Error(`Unknown source node "${String(p.fromNodeName)}"`);
    if (!toId) throw new Error(`Unknown target node "${String(p.toNodeName)}"`);
    const fromPort = typeof p.fromPort === "string" && p.fromPort ? p.fromPort : null;
    const toPort = typeof p.toPort === "string" && p.toPort ? p.toPort : null;
    // Same invariants as user-drawn edges / the old inline PI path.
    const dup = ex.liveEdges.some(
      (e) =>
        e.fromNodeId === fromId &&
        e.toNodeId === toId &&
        (e.fromPort ?? null) === fromPort &&
        (e.toPort ?? null) === toPort,
    );
    if (dup) {
      throw new Error(
        `Edge ${String(p.fromNodeName)} → ${String(p.toNodeName)} already exists`,
      );
    }
    if (
      wouldCreateCycle(
        ex.liveEdges.map((e) => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId })),
        fromId,
        toId,
      )
    ) {
      throw new Error(
        `Edge ${String(p.fromNodeName)} → ${String(p.toNodeName)} would create a cycle`,
      );
    }
    const edge = await db.edge.create({
      data: {
        workflowId: ex.workflowId,
        fromNodeId: fromId,
        toNodeId: toId,
        fromPort,
        toPort,
      },
    });
    ex.liveEdges.push({ fromNodeId: fromId, toNodeId: toId, fromPort, toPort });
    return { edgeId: edge.id };
  },
  summarize: () => "Edge created",
});
