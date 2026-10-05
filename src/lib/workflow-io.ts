// Pure helpers for exporting / importing a workflow as JSON.
// No React — safe to call from client components or non-React modules.
//
// Export format (foundry-lab-1.0):
//   {
//     "version": "foundry-lab-1.0",
//     "name": "My Workflow",
//     "exportedAt": "2025-01-15T12:34:56.789Z",
//     "nodes": [
//       { "id": 0, "type": "input", "name": "Start", "x": 80, "y": 120, "params": {...}, "refId": null },
//       { "id": 1, "type": "agent", "name": "PI", "x": 420, "y": 120, "refId": "cuid..." }
//     ],
//     "edges": [
//       { "fromId": 0, "toId": 1, "fromPort": "default", "toPort": "context" }
//     ]
//   }
//
// `nodes[].id` is a LOCAL index (0,1,2…) used only inside the file so that
// edges can reference nodes positionally. On import, new backend IDs are
// allocated by POST /api/workflow/nodes and remapped via this index.
//
// POST /api/workflow/nodes accepts an optional `workflowId` in the body: when
// present the node is created in THAT workflow, otherwise it falls back to
// the FIRST workflow (oldest by createdAt asc). importWorkflow takes an
// optional `workflowId` and forwards it on every node create so the imported
// graph lands on the caller's CURRENT workflow (multi-workflow switcher);
// when omitted, the legacy clear+rebuild-the-first-workflow behavior is kept.

import type { WorkflowDTO, NodeDTO, EdgeDTO } from "./types";

export const WORKFLOW_EXPORT_VERSION = "foundry-lab-1.0";

export interface ExportedNode {
  id: number;
  type: string;
  name: string;
  x: number;
  y: number;
  params?: Record<string, string | number | boolean>;
  refId?: string | null;
}

export interface ExportedEdge {
  fromId: number;
  toId: number;
  fromPort?: string | null;
  toPort?: string | null;
}

export interface ExportedWorkflow {
  version: string;
  name: string;
  exportedAt: string;
  nodes: ExportedNode[];
  edges: ExportedEdge[];
}

export interface ImportedNode {
  type: string;
  name: string;
  x: number;
  y: number;
  params?: Record<string, unknown>;
  refId?: string | null;
}

export interface ImportedEdge {
  fromId: number;
  toId: number;
  fromPort?: string | null;
  toPort?: string | null;
}

export interface ImportedWorkflow {
  name?: string;
  nodes: ImportedNode[];
  edges: ImportedEdge[];
}

/** Export the current workflow as a JSON string. */
export function exportWorkflowJSON(workflow: WorkflowDTO): string {
  const exported: ExportedWorkflow = {
    version: WORKFLOW_EXPORT_VERSION,
    name: workflow.name,
    exportedAt: new Date().toISOString(),
    nodes: workflow.nodes.map((n, i) => ({
      id: i,
      type: n.type,
      name: n.name,
      x: n.x,
      y: n.y,
      params: n.params,
      refId: n.refId,
    })),
    edges: workflow.edges.map((e) => {
      const fromId = workflow.nodes.findIndex((n) => n.id === e.fromNodeId);
      const toId = workflow.nodes.findIndex((n) => n.id === e.toNodeId);
      return {
        fromId,
        toId,
        fromPort: e.fromPort,
        toPort: e.toPort,
      };
    }),
  };
  return JSON.stringify(exported, null, 2);
}

/** Trigger a browser download of the workflow JSON. */
export function downloadWorkflowJSON(workflow: WorkflowDTO): void {
  const json = exportWorkflowJSON(workflow);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(workflow.name || "workflow").replace(/\s+/g, "-").toLowerCase()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse an imported JSON file. Returns {nodes, edges} or throws on invalid.
 *
 * Accepts both the canonical format (edges with `fromId`/`toId` as numbers)
 * and a legacy format (edges with `fromNodeId`/`toNodeId` as numbers — used
 * by an earlier draft). String-encoded indices like "node-0" are also tolerated.
 */
export function parseWorkflowJSON(text: string): ImportedWorkflow {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON: ${msg}`);
  }
  if (!isObject(obj)) {
    throw new Error("Invalid workflow file: root must be a JSON object");
  }
  if (!Array.isArray(obj.nodes)) {
    throw new Error("Invalid workflow file: missing nodes array");
  }
  if (!Array.isArray(obj.edges)) {
    throw new Error("Invalid workflow file: missing edges array");
  }

  const nodes: ImportedNode[] = obj.nodes.map((raw, i) => {
    if (!isObject(raw)) {
      throw new Error(`Node ${i}: not an object`);
    }
    const type = asString(raw.type);
    const name = asString(raw.name);
    const x = asNumber(raw.x);
    const y = asNumber(raw.y);
    if (!type) throw new Error(`Node ${i}: missing or invalid "type"`);
    if (!name) throw new Error(`Node ${i}: missing or invalid "name"`);
    if (x === undefined) throw new Error(`Node ${i}: missing or invalid "x"`);
    if (y === undefined) throw new Error(`Node ${i}: missing or invalid "y"`);
    const paramsRaw = raw.params;
    const params =
      paramsRaw && isObject(paramsRaw)
        ? (paramsRaw as Record<string, unknown>)
        : undefined;
    const refIdRaw = raw.refId;
    const refId =
      refIdRaw === null || refIdRaw === undefined
        ? null
        : asString(refIdRaw) ?? null;
    return { type, name, x, y, params, refId };
  });

  const resolveLocalIndex = (v: unknown, label: string, i: number): number => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const m = v.match(/(?:^node-)?(\d+)$/i);
      if (m) return parseInt(m[1], 10);
    }
    throw new Error(`Edge ${i}: missing or invalid "${label}"`);
  };

  const edges: ImportedEdge[] = obj.edges.map((raw, i) => {
    if (!isObject(raw)) {
      throw new Error(`Edge ${i}: not an object`);
    }
    const fromId = resolveLocalIndex(
      raw.fromId ?? raw.fromNodeId,
      "fromId",
      i,
    );
    const toId = resolveLocalIndex(raw.toId ?? raw.toNodeId, "toId", i);
    const fromPort =
      raw.fromPort === null || raw.fromPort === undefined
        ? null
        : asString(raw.fromPort) ?? null;
    const toPort =
      raw.toPort === null || raw.toPort === undefined
        ? null
        : asString(raw.toPort) ?? null;
    return { fromId, toId, fromPort, toPort };
  });

  return {
    name: asString(obj.name),
    nodes,
    edges,
  };
}

/**
 * Import a workflow into the backend. Replaces the contents of the target
 * workflow: deletes all existing nodes (cascade-cleans edges), then creates
 * the imported nodes + edges. Returns the updated WorkflowDTO so callers can
 * push it into their store.
 *
 * `workflowId` (optional) — the workflow to clear + rebuild. Callers pass the
 * CURRENT workflow from the store (multi-workflow switcher); when omitted the
 * legacy target is used (GET /api/workflow = the first workflow). The imported
 * `data.name` is reflected in the returned DTO but is NOT persisted —
 * persist it separately via PATCH /api/workflows/:id when needed.
 */
export async function importWorkflow(
  data: ImportedWorkflow,
  workflowId?: string,
): Promise<WorkflowDTO> {
  // 1. Fetch the target workflow — the caller's workflowId when given
  //    (multi-workflow switcher), else the legacy /api/workflow default.
  const wfUrl = workflowId ? `/api/workflows/${workflowId}` : "/api/workflow";
  const wfRes = await fetch(wfUrl);
  if (!wfRes.ok) {
    throw new Error(
      `Failed to fetch target workflow (${wfUrl}, HTTP ${wfRes.status})`,
    );
  }
  const wf: WorkflowDTO = await wfRes.json();

  // 2. Delete all existing nodes (DELETE /api/workflow/nodes/[id] also
  //    removes edges that reference the node — see the route implementation).
  for (const n of wf.nodes) {
    try {
      await fetch(`/api/workflow/nodes/${n.id}`, { method: "DELETE" });
    } catch {
      /* node may already be gone — continue */
    }
  }

  // 3. Create new nodes, mapping local index → new backend ID.
  const idMap = new Map<number, string>();
  const newNodes: NodeDTO[] = [];
  for (let i = 0; i < data.nodes.length; i++) {
    const n = data.nodes[i];
    const res = await fetch("/api/workflow/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: n.type,
        name: n.name,
        x: n.x,
        y: n.y,
        params: n.params,
        refId: n.refId,
        // Target workflow (multi-workflow switcher). Omitted when the caller
        // didn't pass one — the backend then uses its legacy first-workflow
        // fallback, keeping old call sites working unchanged.
        ...(workflowId ? { workflowId } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err =
        (errBody as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new Error(`Failed to create node "${n.name}": ${err}`);
    }
    const node: NodeDTO = await res.json();
    idMap.set(i, node.id);
    newNodes.push(node);
  }

  // 4. Create edges using the local-index → new-id mapping.
  const newEdges: EdgeDTO[] = [];
  for (let i = 0; i < data.edges.length; i++) {
    const e = data.edges[i];
    const fromNodeId = idMap.get(e.fromId);
    const toNodeId = idMap.get(e.toId);
    if (!fromNodeId || !toNodeId) {
      // Skip edges that reference a node that wasn't created (out-of-range idx).
      continue;
    }
    try {
      const res = await fetch("/api/workflow/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromNodeId,
          toNodeId,
          fromPort: e.fromPort ?? undefined,
          toPort: e.toPort ?? undefined,
        }),
      });
      if (!res.ok) {
        // Skip edge creation errors (e.g. duplicate / cycle) but keep going.
        continue;
      }
      const edge: EdgeDTO = await res.json();
      newEdges.push(edge);
    } catch {
      /* swallow — keep going on partial edge failures */
    }
  }

  // 5. Return the updated workflow DTO so the caller can set it in their store.
  return {
    ...wf,
    name: data.name ?? wf.name,
    nodes: newNodes,
    edges: newEdges,
    updatedAt: new Date().toISOString(),
  };
}
