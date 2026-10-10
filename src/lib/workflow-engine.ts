// Workflow DAG execution engine — server-only.
// Maps Prisma rows to DTOs, gathers upstream inputs, and dispatches node execution
// based on node.type (agent / task / meeting / research / comptool / biotool / input / output).

import { db } from "@/lib/db";
import {
  toAgentDTO,
  runAgentTurn,
  runTeamMeeting,
  runResearch,
  executeCompTool,
  extractClusterTarget,
} from "@/lib/run-utils";
import { runSkill, recordSkillInvocation } from "@/lib/skills";
import { parseFastaInput } from "@/lib/tools";
import type {
  NodeDTO,
  EdgeDTO,
  NodeStatus,
  NodeType,
  CanvasGroupDTO,
} from "@/lib/types";

export type NodeExecResult = {
  result: string;
  logs: string;
  status: "completed" | "failed" | "running";
};

/**
 * Resolve which workflow an API request targets.
 *   - `workflowId` present (multi-workflow switcher / import / promote) →
 *     THAT workflow; 404 when it no longer exists.
 *   - absent → the legacy default: the FIRST workflow by createdAt asc
 *     (identical to the old hard-coded behavior, so single-workflow
 *     clients keep working unchanged).
 * Shared by POST /api/workflow/nodes, POST /api/workflow/run and the
 * screening promote lane so the workflowId contract is enforced in ONE place.
 */
export async function resolveTargetWorkflow(
  workflowId: unknown,
): Promise<
  | { ok: true; workflow: { id: string; name: string } }
  | { ok: false; status: number; error: string }
> {
  if (typeof workflowId === "string" && workflowId.trim()) {
    const wf = await db.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) {
      return {
        ok: false,
        status: 404,
        error: `Workflow ${workflowId} not found`,
      };
    }
    return { ok: true, workflow: wf };
  }
  const wf = await db.workflow.findFirst({ orderBy: { createdAt: "asc" } });
  if (!wf) {
    return { ok: false, status: 404, error: "No workflow exists" };
  }
  return { ok: true, workflow: wf };
}

/** Map a Prisma Node row (any shape) to a NodeDTO. */
export function toNodeDTO(n: {
  id: string;
  workflowId: string;
  type: string;
  refId: string | null;
  name: string;
  x: number | { toNumber(): number };
  y: number | { toNumber(): number };
  status: string;
  progress: number | { toNumber(): number };
  params: string | null;
  result: string | null;
  logs: string | null;
  sweepGroup?: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): NodeDTO {
  const num = (v: unknown): number =>
    typeof v === "number" ? v : (v as { toNumber(): number } | null)?.toNumber?.() ?? 0;
  let params: Record<string, string | number | boolean> = {};
  try {
    const parsed = JSON.parse(n.params || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      params = parsed as Record<string, string | number | boolean>;
    }
  } catch {
    params = {};
  }
  const iso = (v: Date | string | null): string | null =>
    v == null ? null : typeof v === "string" ? v : new Date(v).toISOString();
  return {
    id: n.id,
    workflowId: n.workflowId,
    type: n.type as NodeType,
    refId: n.refId ?? null,
    name: n.name,
    x: num(n.x),
    y: num(n.y),
    status: n.status as NodeStatus,
    progress: num(n.progress),
    params,
    result: n.result,
    logs: n.logs ?? "",
    sweepGroup: n.sweepGroup ?? null,
    startedAt: iso(n.startedAt),
    completedAt: iso(n.completedAt),
    createdAt: iso(n.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(n.updatedAt) ?? new Date().toISOString(),
  };
}

/** Map a Prisma Edge row (any shape) to an EdgeDTO. */
export function toEdgeDTO(e: {
  id: string;
  workflowId: string;
  fromNodeId: string;
  toNodeId: string;
  fromPort: string | null;
  toPort: string | null;
  createdAt: Date | string;
}): EdgeDTO {
  return {
    id: e.id,
    workflowId: e.workflowId,
    fromNodeId: e.fromNodeId,
    toNodeId: e.toNodeId,
    fromPort: e.fromPort ?? null,
    toPort: e.toPort ?? null,
    createdAt:
      typeof e.createdAt === "string" ? e.createdAt : new Date(e.createdAt).toISOString(),
  };
}

// ── Canvas groups (F-lane persistence) ───────────────────────────────────────

const GROUP_COLORS_ALLOW = new Set(["teal", "violet", "amber", "rose"]);
const MAX_GROUPS = 32;
const MAX_GROUP_MEMBERS = 100;

/**
 * Parse + sanitize the Workflow.groups JSON column into CanvasGroupDTO[].
 * Returns null when absent/corrupt (callers serialize `undefined`).
 * Shared by every workflow→DTO mapper so the hand-drawn group layer
 * round-trips identically no matter which route served the workflow.
 */
export function toGroupDTOs(json: string | null | undefined): CanvasGroupDTO[] | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: CanvasGroupDTO[] = [];
  for (const raw of parsed.slice(0, MAX_GROUPS)) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === "string" ? g.id : "";
    const label = typeof g.label === "string" ? g.label.slice(0, 64).trim() : "";
    const color = typeof g.color === "string" && GROUP_COLORS_ALLOW.has(g.color) ? g.color : "teal";
    const nodeIds = Array.isArray(g.nodeIds)
      ? [...new Set(g.nodeIds.filter((x): x is string => typeof x === "string"))].slice(0, MAX_GROUP_MEMBERS)
      : [];
    if (!id || !label || nodeIds.length === 0) continue;
    out.push({ id, label, color, nodeIds });
  }
  return out;
}

/**
 * Sanitize client-submitted groups for the Workflow.groups column.
 * Returns the JSON string to persist (or null to clear). Enforces the same
 * caps as toGroupDTOs — the DB never sees unbounded blobs.
 */
export function sanitizeGroupsJSON(input: unknown): string | null | { error: string } {
  if (input == null) return null;
  if (!Array.isArray(input)) return { error: "'groups' must be an array" };
  if (input.length > MAX_GROUPS) {
    return { error: `Too many groups (max ${MAX_GROUPS})` };
  }
  const out: CanvasGroupDTO[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "Each group must be an object" };
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === "string" ? g.id.trim().slice(0, 40) : "";
    const label = typeof g.label === "string" ? g.label.trim().slice(0, 64) : "";
    const color = typeof g.color === "string" && GROUP_COLORS_ALLOW.has(g.color) ? g.color : "teal";
    const nodeIds = Array.isArray(g.nodeIds)
      ? [...new Set(g.nodeIds.filter((x): x is string => typeof x === "string"))].slice(0, MAX_GROUP_MEMBERS)
      : [];
    if (!id || !label) return { error: "Each group needs an id and a non-empty label" };
    if (nodeIds.length === 0) return { error: `Group "${label}" has no node ids` };
    out.push({ id, label, color, nodeIds });
  }
  return JSON.stringify(out);
}

/**
 * Gather upstream node outputs joined as a string (the "input" to a node).
 * Only includes upstream nodes that have a non-empty result string.
 */
export function gatherInputs(
  nodeId: string,
  nodes: NodeDTO[],
  edges: EdgeDTO[],
): string {
  const incoming = edges.filter((e) => e.toNodeId === nodeId);
  const parts: string[] = [];
  for (const e of incoming) {
    const src = nodes.find((n) => n.id === e.fromNodeId);
    if (src && src.result && src.result.trim().length > 0) {
      parts.push(`--- ${src.name} (${src.type}) ---\n${src.result}`);
    }
  }
  return parts.join("\n\n");
}

// ── Chained-tool file wiring ─────────────────────────────────────────────────
// Real tool nodes exchange FILES (PDB backbones, FASTA sequences), not prose.
// Upstream nodes advertise their artifacts via the ##OUTPUTS## trailer the
// engine stamps at the end of every successful tool run. These helpers read
// those trailers and auto-wire the downstream tool's file params when the
// user (or the PI Copilot) left them empty/placeholder.

/** Tool nodes that consume a backbone PDB (pdb_path param). */
const PDB_INPUT_TOOLS = new Set([
  "rfdiffusion",
  "rfantibody",
  "proteinmpnn",
  "ligandmpnn",
  "solublempnn",
  "rosetta",
  "pyrosetta",
]);

/** Fold/structure-prediction tool nodes that consume a FASTA sequence. */
const FOLD_TOOLS = new Set(["alphafold", "esmfold", "rf3", "colabfold"]);

/** Parse the ##OUTPUTS## ["…"] trailer from a node's logs → file paths. */
function parseOutputsTrailer(logs: string): string[] {
  const m = logs.match(/##OUTPUTS## (\[[\s\S]*?\])/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Collect output-file paths declared by upstream nodes (##OUTPUTS##). */
async function collectUpstreamFiles(
  nodeId: string,
  workflowId: string,
): Promise<string[]> {
  const wf = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { nodes: true, edges: true },
  });
  if (!wf) return [];
  const incomingIds = new Set(
    wf.edges.filter((e) => e.toNodeId === nodeId).map((e) => e.fromNodeId),
  );
  const files: string[] = [];
  for (const src of wf.nodes) {
    if (incomingIds.has(src.id) && src.logs) {
      files.push(...parseOutputsTrailer(src.logs));
    }
  }
  return files;
}

/** True when the `sequence` param is absent, empty, or not a valid protein
 * sequence (e.g. the PI Copilot's ">design\nMKT…" placeholder). */
function sequenceMissingOrInvalid(seq: unknown): boolean {
  if (typeof seq !== "string" || !seq.trim()) return true;
  return parseFastaInput(seq) === null;
}

/**
 * Auto-wire a tool node's file params from upstream ##OUTPUTS## artifacts.
 * Mutates `filtered` in place; returns human-readable chain notes to prepend
 * to the node's logs. Explicit user input always wins:
 *   - pdb_path  ← first upstream .pdb  (only when pdb_path is empty)
 *   - fasta_path ← first upstream .fasta (only when the fold node has no
 *     valid sequence, no fasta_path, and no feature_file; an invalid
 *     placeholder sequence is deleted so fasta_path takes effect — the fold
 *     engine prefers `sequence` over `fasta_path`)
 */
export async function autoWireToolInputs(
  toolKey: string,
  nodeId: string,
  workflowId: string,
  filtered: Record<string, unknown>,
): Promise<string[]> {
  const notes: string[] = [];
  let files: string[];
  try {
    files = await collectUpstreamFiles(nodeId, workflowId);
  } catch {
    return notes;
  }
  if (files.length === 0) return notes;

  if (PDB_INPUT_TOOLS.has(toolKey)) {
    const pdb = files.find((f) => /\.pdb$/i.test(f));
    if (pdb) {
      // RFantibody's backbone input param is target_pdb (not pdb_path) —
      // wire the upstream PDB there so the engine actually sees it.
      if (toolKey === "rfantibody") {
        if (!String(filtered.target_pdb ?? "").trim()) {
          filtered.target_pdb = pdb;
          notes.push(`[chain] auto-wired target_pdb from upstream output: ${pdb}`);
        }
      } else if (!String(filtered.pdb_path ?? "").trim()) {
        filtered.pdb_path = pdb;
        notes.push(`[chain] auto-wired pdb_path from upstream output: ${pdb}`);
      }
    }
  }

  if (FOLD_TOOLS.has(toolKey)) {
    const fasta = files.find((f) => /\.(fasta|fa|aln)$/i.test(f));
    const hasFastaPath = String(filtered.fasta_path ?? "").trim() !== "";
    const hasFeature = String(filtered.feature_file ?? "").trim() !== "";
    if (
      fasta &&
      !hasFastaPath &&
      !hasFeature &&
      sequenceMissingOrInvalid(filtered.sequence)
    ) {
      // Delete the invalid/absent sequence so fasta_path is honored (the
      // fold engine checks `sequence` FIRST, then fasta_path).
      delete filtered.sequence;
      filtered.fasta_path = fasta;
      notes.push(
        `[chain] auto-wired fasta_path from upstream output: ${fasta}`,
      );
    }
  }
  return notes;
}

/** Helper: fetch connected agent DTOs for a meeting/research node. */
async function fetchConnectedAgents(
  nodeId: string,
  workflowId: string,
): Promise<{ ok: true; lead: ReturnType<typeof toAgentDTO>; members: ReturnType<typeof toAgentDTO>[] } | { ok: false; reason: string }> {
  const wf = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { nodes: true, edges: true },
  });
  if (!wf) return { ok: false, reason: "Workflow not found" };

  const allNodes = wf.nodes.map(toNodeDTO);
  const allEdges = wf.edges.map(toEdgeDTO);
  const incomingAgentNodeIds = allEdges
    .filter((e) => e.toNodeId === nodeId)
    .map((e) => e.fromNodeId);
  const agentNodes = allNodes.filter(
    (n) => n.type === "agent" && incomingAgentNodeIds.includes(n.id) && n.refId,
  );
  if (agentNodes.length === 0) {
    return { ok: false, reason: "No agent nodes connected to this node" };
  }
  const rows = await Promise.all(
    agentNodes.map((an) => db.agent.findUnique({ where: { id: an.refId! } })),
  );
  const dtos: ReturnType<typeof toAgentDTO>[] = [];
  for (const row of rows) {
    if (row) dtos.push(toAgentDTO(row));
  }
  if (dtos.length === 0) {
    return { ok: false, reason: "Connected agents no longer exist" };
  }
  const [lead, ...members] = dtos;
  return { ok: true, lead, members };
}

/**
 * Execute a single node given its type + params + inputs.
 * Returns { result, logs, status }.
 * On error: returns { result: "Error: ...", logs: err.message, status: "failed" }.
 */
export async function executeNode(
  node: NodeDTO,
  inputs: string,
  workflowId: string,
): Promise<NodeExecResult> {
  try {
    switch (node.type) {
      case "agent": {
        if (!node.refId) {
          return {
            result: "Error: Agent node has no refId",
            logs: "Agent node missing refId",
            status: "failed",
          };
        }
        const row = await db.agent.findUnique({ where: { id: node.refId } });
        if (!row) {
          return {
            result: `Error: Agent ${node.refId} not found`,
            logs: `Agent ${node.refId} not found`,
            status: "failed",
          };
        }
        const agent = toAgentDTO(row);
        const fallbackPrompt =
          (node.params.prompt as string | undefined) ||
          `Hello, ${agent.title}. Please respond to the task.`;
        const history = inputs
          ? [{ role: "user" as const, content: inputs }]
          : [{ role: "user" as const, content: fallbackPrompt }];
        // No explicit temperature — the agent's saved runtime config
        // (fine-tune dialog) supplies the default inside runAgentTurn.
        // J lane: workflow attribution — skill invocations from this turn
        // land in the audit log with source "workflow" + node/workflow ids.
        const { text, toolCalls } = await runAgentTurn(agent, history, {
          source: "workflow",
          skillCtx: { workflowId, nodeId: node.id },
        });
        const verbose = agent.runtime?.verbose;
        const logs = toolCalls.length > 0
          ? (verbose
              ? toolCalls
                  .map(
                    (t) =>
                      `[${t.kind}] ${t.tool} → ${t.status ?? "completed"}\n` +
                      `params: ${JSON.stringify(t.params)}\n` +
                      `result: ${(t.result ?? "").slice(0, 400)}`,
                  )
                  .join("\n") + `\n\nFinal reply (${text.length} chars)`
              : `Tool calls: ${toolCalls.map((t) => t.tool).join(", ")}\n\nFinal reply (${text.length} chars)`)
          : `Agent replied (${text.length} chars)`;
        return { result: text, logs, status: "completed" };
      }

      case "task": {
        const prompt = String(node.params.prompt ?? "");
        return {
          result: prompt,
          logs: `Task submitted: ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`,
          status: "completed",
        };
      }

      case "meeting": {
        const fetched = await fetchConnectedAgents(node.id, workflowId);
        if (!fetched.ok) {
          return {
            result: `Error: ${fetched.reason}`,
            logs: fetched.reason,
            status: "failed",
          };
        }
        const agenda =
          (node.params.agenda as string | undefined) || inputs || "(no agenda)";
        const numRounds = Number(node.params.numRounds ?? 3);
        const temperature = Number(node.params.temperature ?? 0.7);
        const { messages, summary } = await runTeamMeeting(
          fetched.lead,
          fetched.members,
          agenda,
          { numRounds, temperature },
        );
        const transcript = messages
          .map((m) => `**${m.agentName} (R${m.roundIndex + 1})**: ${m.message}`)
          .join("\n\n");
        return { result: summary, logs: transcript, status: "completed" };
      }

      case "research": {
        const fetched = await fetchConnectedAgents(node.id, workflowId);
        if (!fetched.ok) {
          return {
            result: `Error: ${fetched.reason}`,
            logs: fetched.reason,
            status: "failed",
          };
        }
        const topic =
          (node.params.topic as string | undefined) || inputs || "(no topic)";
        const description = node.params.description
          ? String(node.params.description)
          : null;
        const numRounds = Number(node.params.numRounds ?? 2);
        const temperature = Number(node.params.temperature ?? 0.6);
        const { messages, report } = await runResearch(
          fetched.lead,
          fetched.members,
          topic,
          description,
          { numRounds, temperature },
        );
        const transcript = messages
          .map(
            (m) =>
              `**${m.agentName}** [${m.phase ?? "research"}]: ${m.message}`,
          )
          .join("\n\n");
        return { result: report, logs: transcript, status: "completed" };
      }

      case "alphafold": {
        // The AlphaFold prediction tool node (the cluster tutorial flow:
        // mgt → salloc → gpu05 → module alphafold2 → run_alphafold.py).
        const toolKey = "alphafold";
        // Cluster target (inspector-managed): a raw `_cluster` param (JSON
        // string or object) routes this run to an SSH cluster.
        // It is stripped from the filtered params so it never reaches
        // buildCommand.
        const clusterTarget = extractClusterTarget(
          (node.params as Record<string, unknown>)._cluster,
        );
        const filtered: Record<string, unknown> = { ...node.params };
        delete filtered._cluster;
        delete filtered.toolKey;
        if (inputs) {
          // Pass upstream context as an "inputs" hint — executeCompTool ignores unknown keys.
          filtered.__inputs = inputs;
        }
        // Chained pipelines: auto-wire pdb_path/fasta_path from upstream
        // ##OUTPUTS## artifacts when the node's own params left them empty.
        const chainNotes = await autoWireToolInputs(
          toolKey,
          node.id,
          workflowId,
          filtered,
        );
        const t0 = Date.now();
        const { summary, stdout, files, exitCode, pollCeiling } =
          await executeCompTool(
            toolKey,
            filtered,
            clusterTarget ? { cluster: clusterTarget } : {},
          );
        // J lane: unified audit — comp nodes keep their specialized executor
        // (cluster routing + auto-wiring + ##OUTPUTS## protocol) but every
        // run lands in the SAME SkillInvocation table as chat-lane calls.
        // __inputs is stripped from the audited params (can be huge).
        const { __inputs: _ai, ...auditParams } = filtered;
        await recordSkillInvocation({
          skillId: `comp.${toolKey}`,
          source: "workflow",
          status: pollCeiling ? "ok" : exitCode !== 0 ? "error" : "ok",
          params: auditParams,
          summary: pollCeiling ? `${summary} (remote job still running)` : summary,
          ...(exitCode !== 0 && !pollCeiling
            ? { error: `Tool failed (exit ${exitCode})` }
            : {}),
          durationMs: Date.now() - t0,
          workflowId,
          nodeId: node.id,
        });
        // ##OUTPUTS## trailer: the built-in engines print it themselves, native
        // upstream tools do not — append it from the executor's file list so
        // the inspector's Outputs button works for BOTH executors.
        const body = files.length
          ? `${stdout}\n##OUTPUTS## ${JSON.stringify(files)}\n`
          : stdout;
        const logs = chainNotes.length
          ? `${chainNotes.join("\n")}\n${body}`
          : body;
        // Poll-ceiling outcome: the remote cluster job is STILL RUNNING —
        // neither completed nor failed. Return status "running" so the
        // runner leaves the node in the running state (no completedAt, no
        // progress-100 lie, no downstream cascade); the node's SSE stream
        // route reconciles it against the ToolJob row the cluster sweep
        // keeps updating.
        if (pollCeiling) {
          return { result: summary, logs, status: "running" };
        }
        // Honest status: a non-zero exit (native tool error, cluster dispatch
        // failure, invalid input) fails the node instead of a silent
        // "completed" with a failure buried in the logs.
        const failed = exitCode !== 0;
        return {
          result: failed
            ? `Tool failed (exit ${exitCode}) — see Logs. ${summary}`
            : summary,
          logs,
          status: failed ? "failed" : "completed",
        };
      }

      // Per-tool node types — dispatch on node.type which IS the toolKey.
      // (The old generic "comptool" node was removed — each tool is its own
      // standalone command/node now.)
      case "rfdiffusion":
      case "rfantibody":
      case "proteinmpnn":
      case "ligandmpnn":
      case "solublempnn":
      case "rosetta":
      case "pyrosetta":
      case "rf3":
      case "esmfold":
      case "colabfold": {
        const toolKey = node.type;
        // Same cluster routing as the alphafold case (raw `_cluster` param).
        const clusterTarget = extractClusterTarget(
          (node.params as Record<string, unknown>)._cluster,
        );
        // node.params are already the tool's own params (no prefixing needed).
        const filtered: Record<string, unknown> = { ...node.params };
        delete filtered._cluster;
        if (inputs) (filtered as Record<string, unknown>).__inputs = inputs;
        // Chained pipelines: auto-wire pdb_path/fasta_path from upstream
        // ##OUTPUTS## artifacts when the node's own params left them empty.
        const chainNotes = await autoWireToolInputs(
          toolKey,
          node.id,
          workflowId,
          filtered,
        );
        const t0 = Date.now();
        const { summary, stdout, files, exitCode, pollCeiling } =
          await executeCompTool(
            toolKey,
            filtered,
            clusterTarget ? { cluster: clusterTarget } : {},
          );
        // J lane: unified audit — same rule as the alphafold branch above.
        const { __inputs: _ai, ...auditParams } = filtered;
        await recordSkillInvocation({
          skillId: `comp.${toolKey}`,
          source: "workflow",
          status: pollCeiling ? "ok" : exitCode !== 0 ? "error" : "ok",
          params: auditParams,
          summary: pollCeiling ? `${summary} (remote job still running)` : summary,
          ...(exitCode !== 0 && !pollCeiling
            ? { error: `Tool failed (exit ${exitCode})` }
            : {}),
          durationMs: Date.now() - t0,
          workflowId,
          nodeId: node.id,
        });
        // Same ##OUTPUTS## trailer + honest status as the alphafold branch above.
        const body = files.length
          ? `${stdout}\n##OUTPUTS## ${JSON.stringify(files)}\n`
          : stdout;
        const logs = chainNotes.length
          ? `${chainNotes.join("\n")}\n${body}`
          : body;
        // Same poll-ceiling honesty as the alphafold branch: remote job still
        // running → node stays running, nothing cascades, stream reconciles.
        if (pollCeiling) {
          return { result: summary, logs, status: "running" };
        }
        const failed = exitCode !== 0;
        return {
          result: failed
            ? `Tool failed (exit ${exitCode}) — see Logs. ${summary}`
            : summary,
          logs,
          status: failed ? "failed" : "completed",
        };
      }

      case "biotool": {
        const bioKey = String(node.params.bioKey ?? "pdb") as
          | "blast"
          | "pdb"
          | "pubmed"
          | "uniprot";
        const query =
          (node.params.query as string | undefined) || inputs || "";
        const maxResults = Number(node.params.maxResults ?? 5);
        // J lane: biotool nodes execute through the skill pipeline — same
        // validation + audit as every other skill invocation in the system.
        const skillRes = await runSkill(`bio.${bioKey}`, { query, maxResults }, {
          source: "workflow",
          workflowId,
          nodeId: node.id,
        });
        const summary = skillRes.status === "ok" ? skillRes.summary : (skillRes.error ?? skillRes.summary);
        return {
          result: JSON.stringify(
            skillRes.status === "ok" ? (skillRes.data as { hits: unknown[] }).hits : [],
            null,
            2,
          ),
          // Keep the error text in logs, but don't paint the node green —
          // an API failure is a failed node (the NodeStatus union's error
          // state is "failed"), not a completed one.
          logs: summary,
          status: skillRes.status === "ok" ? "completed" : "failed",
        };
      }

      case "input": {
        const text = String(node.params.text ?? "");
        return { result: text, logs: "Input node", status: "completed" };
      }

      case "output": {
        return {
          result: inputs,
          logs: "Output rendered",
          status: "completed",
        };
      }

      default:
        return {
          result: `Error: Unknown node type ${node.type}`,
          logs: `Unknown node type: ${node.type}`,
          status: "failed",
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      result: `Error: ${msg}`,
      logs: msg,
      status: "failed",
    };
  }
}

// ── E1: per-node execution watchdog ──────────────────────────────────────────

/**
 * Per-node execution ceiling (E1). One wedged engine (child process that never
 * exits, an LLM call that hangs on a dead socket, …) must never occupy a
 * worker lane forever — the bounded pool (MAX_CONCURRENCY) would drain and the
 * whole workflow run would hang with nodes stuck in "running".
 *
 * 15 minutes comfortably exceeds every legitimate execution path (built-in
 * numpy engines: seconds; LLM agent turns: ≤2 min; poll-ceiling cluster
 * submissions return "running" on their own, they don't hold the lane).
 * Override for exotic environments: FOUNDRY_NODE_TIMEOUT_MS.
 */
export const NODE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FOUNDRY_NODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
})();

function fmtTimeoutLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `${min}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * Node types whose comptool execution can be routed to an SSH/Slurm cluster
 * via the inspector-managed `_cluster` param (see executeNode's alphafold +
 * comp-tool branches). Used by the watchdog exemption below.
 */
const CLUSTER_ROUTED_TYPES = new Set([
  "alphafold",
  "rfdiffusion",
  "rfantibody",
  "proteinmpnn",
  "ligandmpnn",
  "solublempnn",
  "rosetta",
  "pyrosetta",
  "rf3",
  "esmfold",
  "colabfold",
]);

/**
 * executeNode with a watchdog (E1): races the execution against
 * NODE_TIMEOUT_MS. On timeout the node resolves as FAILED with an explicit
 * watchdog banner, which (a) frees the worker lane, (b) unlocks downstream
 * nodes with the normal failure semantics, and (c) leaves an honest trace in
 * logs/result instead of an eternal spinner.
 *
 * CLUSTER-RUNNING NODES ARE EXEMPT (QA 23-a P0 fix): the cluster lane polls
 * inline for up to 30/120 minutes BY DESIGN (real AF2 predictions take
 * hours) and its loop is self-bounded by that deadline — it then reports the
 * honest "running" poll-ceiling outcome and the SSE stream's reconcile owns
 * the rest of the lifecycle. A 15-minute watchdog would deterministically
 * fail every legitimate long cluster run. Their wedge risk is covered by the
 * poll ceiling itself + the job-stop lane (POST /api/tools/jobs/:id/stop)
 * + the stream's 2h hard cap.
 *
 * For LOCAL lanes the watchdog bounds exactly the wedge risk it was built
 * for: a child process that never exits, an LLM call on a dead socket. The
 * losing execution promise keeps running in the background (JavaScript
 * cannot cancel it); its eventual resolution is consumed by nobody. Callers
 * persist outcomes CONDITIONALLY on the node still being "running" (see the
 * runner / single-node run lane), so a late resolution can never resurrect a
 * node the watchdog (or a user Stop) already settled.
 */
export async function executeNodeGuarded(
  node: NodeDTO,
  inputs: string,
  workflowId: string,
): Promise<NodeExecResult> {
  // Cluster-routed tool node → no watchdog race (see docblock).
  if (
    CLUSTER_ROUTED_TYPES.has(node.type) &&
    extractClusterTarget((node.params as Record<string, unknown>)._cluster)
  ) {
    return executeNode(node, inputs, workflowId);
  }

  const execution = executeNode(node, inputs, workflowId);
  // executeNode maps internal errors to { status: "failed" } results, but a
  // defensive catch keeps a throwing helper from surfacing as an unhandled
  // rejection after the race is decided.
  void execution.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<NodeExecResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            result:
              `Error: execution timed out after ${fmtTimeoutLabel(NODE_TIMEOUT_MS)} (watchdog) — ` +
              "the node was marked failed and downstream nodes were unlocked.",
            logs:
              `[watchdog] No terminal state within ${fmtTimeoutLabel(NODE_TIMEOUT_MS)} — ` +
              "node marked failed by the execution watchdog (E1). The underlying " +
              "engine may still be finishing in the background; its late result " +
              "is discarded.",
            status: "failed",
          });
        }, NODE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
