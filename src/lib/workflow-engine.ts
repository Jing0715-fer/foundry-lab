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
import { runBio } from "@/lib/bio-tools";
import type {
  NodeDTO,
  EdgeDTO,
  NodeStatus,
  NodeType,
} from "@/lib/types";

export type NodeExecResult = {
  result: string;
  logs: string;
  status: "completed" | "failed";
};

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
        const { text, toolCalls } = await runAgentTurn(agent, history, {
          temperature: 0.7,
        });
        const logs =
          toolCalls.length > 0
            ? `Tool calls: ${toolCalls.map((t) => t.tool).join(", ")}\n\nFinal reply (${text.length} chars)`
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
        const { summary, stdout, files } = await executeCompTool(
          toolKey,
          filtered,
          clusterTarget ? { cluster: clusterTarget } : {},
        );
        // ##OUTPUTS## trailer: the built-in engines print it themselves, native
        // upstream tools do not — append it from the executor's file list so
        // the inspector's Outputs button works for BOTH executors.
        const logs = files.length
          ? `${stdout}\n##OUTPUTS## ${JSON.stringify(files)}\n`
          : stdout;
        return { result: summary, logs, status: "completed" };
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
        const { summary, stdout, files } = await executeCompTool(
          toolKey,
          filtered,
          clusterTarget ? { cluster: clusterTarget } : {},
        );
        // Same ##OUTPUTS## trailer as the alphafold branch above.
        const logs = files.length
          ? `${stdout}\n##OUTPUTS## ${JSON.stringify(files)}\n`
          : stdout;
        return { result: summary, logs, status: "completed" };
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
        const res = await runBio(bioKey, { query, maxResults });
        const summary =
          `${res.count} hits from ${bioKey.toUpperCase()}` +
          `${res.error ? ` — ${res.error}` : ""}:\n` +
          res.hits.map((h) => `- ${h.id}: ${h.title}`).join("\n");
        return {
          result: JSON.stringify(res.hits, null, 2),
          logs: summary,
          status: "completed",
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
