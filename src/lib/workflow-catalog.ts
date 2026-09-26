// Workflow node catalog — the single source of truth for node types, ports, params.
// Inspired by cryoflow's JOB_TYPES but adapted for agentic research workflows.

import type { NodeSpec, NodeType, PortKind } from "./types";
import { COMP_TOOLS } from "./tools";

export const CARD_W = 248;
export const CARD_H = 116;
export const WORLD_MIN = -5000;
export const WORLD_MAX = 5000;
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;

export const NODE_COLORS = {
  teal: { text: "text-teal-600 dark:text-teal-400", bg: "bg-teal-500", border: "border-teal-500", soft: "bg-teal-500/10" },
  violet: { text: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500", border: "border-violet-500", soft: "bg-violet-500/10" },
  amber: { text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500", border: "border-amber-500", soft: "bg-amber-500/10" },
  rose: { text: "text-rose-600 dark:text-rose-400", bg: "bg-rose-500", border: "border-rose-500", soft: "bg-rose-500/10" },
  emerald: { text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500", border: "border-emerald-500", soft: "bg-emerald-500/10" },
  cyan: { text: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500", border: "border-cyan-500", soft: "bg-cyan-500/10" },
  slate: { text: "text-slate-600 dark:text-slate-400", bg: "bg-slate-500", border: "border-slate-500", soft: "bg-slate-500/10" },
  orange: { text: "text-orange-600 dark:text-orange-400", bg: "bg-orange-500", border: "border-orange-500", soft: "bg-orange-500/10" },
  pink: { text: "text-pink-600 dark:text-pink-400", bg: "bg-pink-500", border: "border-pink-500", soft: "bg-pink-500/10" },
} as const;

export const PORT_COLORS: Record<PortKind, { dot: string; label: string }> = {
  agent: { dot: "bg-violet-500", label: "Agent" },
  text: { dot: "bg-slate-500", label: "Text" },
  context: { dot: "bg-cyan-500", label: "Context" },
  summary: { dot: "bg-emerald-500", label: "Summary" },
  report: { dot: "bg-teal-500", label: "Report" },
  params: { dot: "bg-amber-500", label: "Params" },
  files: { dot: "bg-orange-500", label: "Files" },
  query: { dot: "bg-pink-500", label: "Query" },
  results: { dot: "bg-rose-500", label: "Results" },
  "*": { dot: "bg-slate-500", label: "Any" },
};

function num(key: string, label: string, def: number, extra: Record<string, unknown> = {}) {
  return { key, label, type: "number" as const, default: def, ...extra };
}
function sel(key: string, label: string, def: string, options: string[], extra: Record<string, unknown> = {}) {
  return { key, label, type: "select" as const, default: def, options, ...extra };
}
function bool(key: string, label: string, def: boolean, extra: Record<string, unknown> = {}) {
  return { key, label, type: "bool" as const, default: def, ...extra };
}
function txt(key: string, label: string, def: string, extra: Record<string, unknown> = {}) {
  return { key, label, type: "text" as const, default: def, ...extra };
}
function area(key: string, label: string, def: string, extra: Record<string, unknown> = {}) {
  return { key, label, type: "textarea" as const, default: def, ...extra };
}

export const NODE_SPECS: NodeSpec[] = [
  // ─── Agents ───────────────────────────────────────────────────────────────
  {
    type: "agent",
    label: "Agent",
    icon: "bot",
    color: "violet",
    description: "An LLM-powered agent persona. Connect it to a Task, Meeting, or Research node to participate. Output is the agent's response.",
    category: "Agents",
    usesLLM: true,
    inputs: [
      { name: "context", label: "Context / prior message", kind: "text", accepts: ["text", "summary", "context", "results", "report", "*"], multiple: true },
    ],
    outputs: [
      { name: "message", label: "Agent message", kind: "agent" },
    ],
    params: [
      txt("refId", "Agent (pick one)", "", { hint: "Selected from the Agents panel" }),
    ],
  },
  // ─── Tasks ────────────────────────────────────────────────────────────────
  {
    type: "task",
    label: "Task",
    icon: "square-pen",
    color: "slate",
    description: "A manual task submission — type a prompt and the connected agents will respond. This is the preserved manual submission surface.",
    category: "Tasks",
    usesLLM: false,
    inputs: [],
    outputs: [
      { name: "result", label: "Task result", kind: "text" },
    ],
    params: [
      txt("title", "Title", "New task", { required: true }),
      area("prompt", "Prompt / agenda", "Describe the task for the agent(s)...", { required: true }),
      sel("taskType", "Type", "general", ["general", "design", "analysis", "research"]),
    ],
  },
  {
    type: "meeting",
    label: "Team Meeting",
    icon: "users",
    color: "emerald",
    description: "Multi-round debate between connected agents on an agenda. Produces a structured summary.",
    category: "Tasks",
    usesLLM: true,
    inputs: [
      { name: "agents", label: "Agents (lead + members)", kind: "agent", accepts: ["agent"], multiple: true },
      { name: "agenda", label: "Agenda (optional override)", kind: "text", accepts: ["text", "*"] },
    ],
    outputs: [
      { name: "summary", label: "Meeting summary", kind: "summary" },
    ],
    params: [
      area("agenda", "Agenda", "Design a SARS-CoV-2 nanobody neutralizing Omicron BA.5."),
      num("numRounds", "Rounds", 3, { min: 1, max: 6 }),
      num("temperature", "Temperature", 0.7, { min: 0, max: 1.5, step: 0.05 }),
    ],
  },
  {
    type: "research",
    label: "Research Pipeline",
    icon: "book-open",
    color: "teal",
    description: "Deep 3-phase research: planning → research → compilation. Outputs a Markdown report.",
    category: "Tasks",
    usesLLM: true,
    inputs: [
      { name: "agents", label: "Agents (lead + members)", kind: "agent", accepts: ["agent"], multiple: true },
      { name: "topic", label: "Topic (optional override)", kind: "text", accepts: ["text", "*"] },
    ],
    outputs: [
      { name: "report", label: "Markdown report", kind: "report" },
    ],
    params: [
      txt("topic", "Topic", "Computational design of binders against RBD", { required: true }),
      area("description", "Description", "Scope, constraints, deliverables..."),
      num("numRounds", "Rounds", 2, { min: 1, max: 4 }),
      num("temperature", "Temperature", 0.6, { min: 0, max: 1.5, step: 0.05 }),
    ],
  },
  // ─── Tools ────────────────────────────────────────────────────────────────
  {
    type: "comptool",
    label: "Comp Tool",
    icon: "cpu",
    color: "cyan",
    description: "Run a computational tool (RFdiffusion / RFantibody / ProteinMPNN / Rosetta). Connect a context node to pass file paths.",
    category: "Tools",
    inputs: [
      { name: "input", label: "Input context", kind: "context", accepts: ["text", "context", "results", "*"], multiple: false },
    ],
    outputs: [
      { name: "files", label: "Output files", kind: "files" },
      { name: "summary", label: "Run summary", kind: "text" },
    ],
    params: [
      sel("toolKey", "Tool", "rfdiffusion", COMP_TOOLS.map((t) => t.key)),
      ...COMP_TOOLS.flatMap((t) =>
        t.paramFields.map((f) => ({
          key: `param_${t.key}_${f.key}`,
          label: `${t.label} · ${f.label}`,
          type: f.type === "path" ? "path" as const : f.type === "bool" ? "bool" as const : f.type === "select" ? "select" as const : f.type === "number" ? "number" as const : "text" as const,
          default: f.default,
          options: f.options,
          min: f.min,
          max: f.max,
          step: f.step,
          unit: f.unit,
          hint: f.hint,
          advanced: f.advanced,
        })),
      ),
    ],
  },
  {
    type: "biotool",
    label: "Bio Tool",
    icon: "database",
    color: "amber",
    description: "Query a bioinformatics API (BLAST / PDB / PubMed / UniProt). Returns structured hits.",
    category: "Tools",
    inputs: [
      { name: "query", label: "Query (optional override)", kind: "query", accepts: ["text", "query", "*"] },
    ],
    outputs: [
      { name: "results", label: "Search results", kind: "results" },
      { name: "summary", label: "Result summary", kind: "text" },
    ],
    params: [
      sel("bioKey", "API", "pdb", ["blast", "pdb", "pubmed", "uniprot"]),
      area("query", "Query", "antibody"),
      num("maxResults", "Max results", 5, { min: 1, max: 10 }),
    ],
  },
  // ─── I/O ──────────────────────────────────────────────────────────────────
  {
    type: "input",
    label: "Input",
    icon: "arrow-right-to-line",
    color: "slate",
    description: "A starting text/context node — feeds into downstream agents, tools, or meetings.",
    category: "I/O",
    inputs: [],
    outputs: [
      { name: "text", label: "Text", kind: "text" },
    ],
    params: [
      area("text", "Text", "Paste a sequence, a PDB ID, a research question..."),
    ],
  },
  {
    type: "output",
    label: "Output",
    icon: "flag",
    color: "rose",
    description: "Final result display. Renders the joined upstream output as Markdown.",
    category: "I/O",
    inputs: [
      { name: "value", label: "Value", kind: "text", accepts: ["text", "summary", "report", "results", "files", "*"], multiple: true },
    ],
    outputs: [],
    params: [],
  },
];

const SPEC_MAP = new Map<NodeType, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));
export function nodeSpec(type: string): NodeSpec | undefined {
  return SPEC_MAP.get(type as NodeType);
}

/** Y-position of the i-th port on a card edge. */
export function portY(i: number, count: number): number {
  if (count <= 1) return CARD_H / 2;
  return (CARD_H * (i + 1)) / (count + 1);
}

/** Are two ports compatible for connection? */
export function portsCompatible(
  fromKind: PortKind | undefined,
  toAccepts: (PortKind | "*")[] | undefined,
): boolean {
  if (!toAccepts || toAccepts.length === 0) return true;
  if (toAccepts.includes("*")) return true;
  if (!fromKind) return false;
  return toAccepts.includes(fromKind);
}

export function visiblePorts(
  ports: { name: string; kind?: PortKind; when?: (p: Record<string, unknown>) => boolean }[],
  params: Record<string, unknown>,
) {
  return ports.filter((p) => !p.when || p.when(params));
}
