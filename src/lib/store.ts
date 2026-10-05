// Zustand store — workflow canvas state + UI state. Client-only.
import { create } from "zustand";
import type { NodeDTO, EdgeDTO, WorkflowDTO, AgentDTO } from "./types";
import { ZOOM_MIN, ZOOM_MAX, WORLD_MIN, WORLD_MAX, CARD_W, CARD_H } from "./workflow-catalog";
import { wouldCreateCycle, clamp } from "./canvas-utils";
import { useHistoryStore } from "./history-store";

export interface Viewport { x: number; y: number; zoom: number; }
export interface PendingFrom { nodeId: string; port: string; dir: "out" | "in"; }

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive" | "success";
}

// --- Polling-merge bookkeeping (module-level — see mergeNodes) --------------

/**
 * Timestamps (ms) of node ids that entered the local store recently, keyed
 * by id. mergeNodes-with-edges refuses to REAP a local id that is missing
 * from an incoming poll while its entry is younger than
 * LOCAL_NODE_GRACE_MS — this covers the race where a create POST resolves
 * while an older poll request was already in flight (that poll's response
 * predates the new node and would otherwise delete it locally the very
 * moment it appears). Entries are dropped as soon as an incoming poll
 * echoes the id back (the server knows about it).
 */
const localNodeArrivedAt = new Map<string, number>();
const LOCAL_NODE_GRACE_MS = 5000;

/** Optimistic edges are tagged with a "tmp_" id prefix until the server
 *  confirms the real row (see attemptConnect in node-card.tsx). */
const TEMP_EDGE_PREFIX = "tmp_";

function isTempEdge(e: EdgeDTO): boolean {
  return e.id.startsWith(TEMP_EDGE_PREFIX);
}

/** Shallow params equality — params values are primitives by DTO contract. */
function paramsEqual(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

interface AppState {
  // workflow
  workflow: WorkflowDTO | null;
  loading: boolean;
  error: string | null;

  // canvas interaction
  selectedId: string | null;
  selectedIds: string[];
  inspectId: string | null;
  pendingFrom: PendingFrom | null;
  viewport: Viewport;
  dragActive: boolean;
  band: { x0: number; y0: number; x1: number; y1: number } | null;

  // agents cache
  agents: AgentDTO[];
  agentsLoading: boolean;

  /** Node ids with local, not-yet-persisted name/param edits (the debounced
   *  PATCH is still in its 350ms window or in flight). mergeNodes protects
   *  these fields from being clobbered by the 3s status poll; ids are
   *  cleared when the PATCH resolves or the server echoes the edit back. */
  dirtyNodeIds: string[];

  // ui
  activePanel: "canvas" | "agents" | "tasks" | "meetings" | "research" | "alphafold" | "screening" | "dashboard";
  paletteQuery: string;
  /** Mobile-only: node palette shown as an overlay over the canvas (<md). */
  mobilePaletteOpen: boolean;
  inspectorTab: string;
  toasts: ToastItem[];
  sidebarCollapsed: boolean;
  /** Environment sheet (tool lifecycle management) open state — global so
   * any component (e.g. the AlphaFold workbench header) can deep-link into
   * the management layer from the usage layer. */
  environmentSheetOpen: boolean;
  /** Cluster sheet (SSH/HPC lane) open state — same cross-link rationale. */
  clusterSheetOpen: boolean;

  // actions: workflow
  setWorkflow: (w: WorkflowDTO | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  upsertNode: (n: NodeDTO) => void;
  removeNode: (id: string) => void;
  addEdgeOptimistic: (e: EdgeDTO) => void;
  confirmEdge: (tempId: string, real: EdgeDTO) => void;
  rollbackEdge: (tempId: string) => void;
  removeEdge: (id: string) => void;
  setNodeStatus: (id: string, status: NodeDTO["status"], progress?: number, result?: string, logs?: string) => void;
  /** Merge polled node rows into the store. Pass the incoming EDGES array
   *  as the second argument when the caller polled a whole workflow: the
   *  merge then also (a) reaps local nodes whose ids are absent from the
   *  incoming set (server-side delete) and (b) replaces edges wholesale —
   *  except optimistic "tmp_" edges whose server confirmation is pending. */
  mergeNodes: (incoming: NodeDTO[], incomingEdges?: EdgeDTO[]) => void;
  /** Mark a node as having local, unsaved name/param edits. */
  markNodeDirty: (id: string) => void;
  /** Clear the dirty mark (PATCH resolved / server echoed the edit). */
  clearNodeDirty: (id: string) => void;

  // actions: canvas
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;
  inspect: (id: string | null) => void;
  setPendingFrom: (p: PendingFrom | null) => void;
  cancelConnect: () => void;
  setViewport: (patch: Partial<Viewport>) => void;
  panBy: (dx: number, dy: number) => void;
  zoomTo: (z: number) => void;
  setDragActive: (b: boolean) => void;
  setBand: (b: AppState["band"]) => void;

  // actions: agents
  setAgents: (a: AgentDTO[]) => void;
  setAgentsLoading: (b: boolean) => void;

  // actions: ui
  setActivePanel: (p: AppState["activePanel"]) => void;
  setPaletteQuery: (q: string) => void;
  setMobilePaletteOpen: (b: boolean) => void;
  setInspectorTab: (t: string) => void;
  setSidebarCollapsed: (b: boolean) => void;
  setEnvironmentSheetOpen: (b: boolean) => void;
  setClusterSheetOpen: (b: boolean) => void;
  toast: (t: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  workflow: null,
  loading: true,
  error: null,

  selectedId: null,
  selectedIds: [],
  inspectId: null,
  pendingFrom: null,
  viewport: { x: 120, y: 80, zoom: 1 },
  dragActive: false,
  band: null,

  agents: [],
  agentsLoading: false,
  dirtyNodeIds: [],

  activePanel: "canvas",
  paletteQuery: "",
  mobilePaletteOpen: false,
  inspectorTab: "params",
  toasts: [],
  sidebarCollapsed: false,
  environmentSheetOpen: false,
  clusterSheetOpen: false,

  setWorkflow: (w) => {
    const switching = !!w && !!get().workflow && w.id !== get().workflow!.id;
    if (switching) {
      // A workflow SWITCH must drop the old graph's undo/redo stack — the
      // snapshots reference the PREVIOUS workflow's nodes, and replaying
      // them against the new graph would create/delete nodes across
      // workflows (cross-contamination observed in e2e QA).
      useHistoryStore.getState().clear();
    }
    set((s) => ({
      workflow: w,
      loading: false,
      error: null,
      // A workflow SWITCH invalidates the pending-edit marks of the old
      // graph (their debounced PATCHes targeted the old nodes).
      ...(switching ? { dirtyNodeIds: [] } : {}),
    }));
  },
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e, loading: false }),

  upsertNode: (n) =>
    set((s) => {
      if (!s.workflow) return {};
      const exists = s.workflow.nodes.some((x) => x.id === n.id);
      // Track when an id first enters the local store so mergeNodes can
      // distinguish "server deleted it" from "an in-flight poll predates
      // this node" (see localNodeArrivedAt above).
      if (!exists) localNodeArrivedAt.set(n.id, Date.now());
      else localNodeArrivedAt.delete(n.id);
      const nodes = exists
        ? s.workflow.nodes.map((x) => (x.id === n.id ? n : x))
        : [...s.workflow.nodes, n];
      return { workflow: { ...s.workflow, nodes }, selectedId: n.id, selectedIds: [n.id] };
    }),

  removeNode: (id) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: {
          ...s.workflow,
          nodes: s.workflow.nodes.filter((n) => n.id !== id),
          edges: s.workflow.edges.filter((e) => e.fromNodeId !== id && e.toNodeId !== id),
        },
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => x !== id),
      };
    }),

  addEdgeOptimistic: (e) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: { ...s.workflow, edges: [...s.workflow.edges, e] },
        pendingFrom: null,
      };
    }),

  confirmEdge: (tempId, real) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: {
          ...s.workflow,
          edges: s.workflow.edges.map((e) => (e.id === tempId ? real : e)),
        },
      };
    }),

  rollbackEdge: (tempId) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: { ...s.workflow, edges: s.workflow.edges.filter((e) => e.id !== tempId) },
      };
    }),

  removeEdge: (id) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: { ...s.workflow, edges: s.workflow.edges.filter((e) => e.id !== id) },
      };
    }),

  setNodeStatus: (id, status, progress, result, logs) =>
    set((s) => {
      if (!s.workflow) return {};
      return {
        workflow: {
          ...s.workflow,
          nodes: s.workflow.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  status,
                  progress: progress ?? n.progress,
                  result: result ?? n.result,
                  logs: logs ?? n.logs,
                  completedAt: status === "completed" || status === "failed" ? new Date().toISOString() : n.completedAt,
                  startedAt: status === "running" && !n.startedAt ? new Date().toISOString() : n.startedAt,
                }
              : n,
          ),
        },
      };
    }),

  mergeNodes: (incoming, incomingEdges) =>
    set((s) => {
      if (!s.workflow) return {};
      const dirty = new Set(s.dirtyNodeIds);
      const now = Date.now();
      const byId = new Map(s.workflow.nodes.map((n) => [n.id, n]));
      let nextDirty = s.dirtyNodeIds;
      for (const n of incoming) {
        // The server now knows about this id — future polls may reap it if
        // it ever disappears again.
        localNodeArrivedAt.delete(n.id);
        const cur = byId.get(n.id);
        if (cur && dirty.has(n.id)) {
          // Protect locally-edited fields while the debounced PATCH is still
          // pending: keep the user's name/params/position and take only the
          // live run state (status/progress/logs/result/timestamps) from the
          // server — otherwise the 3s poll visually reverts the edit mid-
          // keystroke.
          byId.set(n.id, {
            ...cur,
            status: n.status,
            progress: n.progress,
            result: n.result,
            logs: n.logs,
            startedAt: n.startedAt,
            completedAt: n.completedAt,
            updatedAt: n.updatedAt,
          });
          // The edit landed when the server row mirrors the local edits —
          // then the dirty mark (and the protection) can be dropped.
          const landed = n.name === cur.name && paramsEqual(n.params, cur.params);
          if (landed && nextDirty.includes(n.id)) {
            nextDirty = nextDirty.filter((x) => x !== n.id);
          }
        } else {
          byId.set(n.id, { ...cur, ...n });
        }
      }
      let nodes = [...byId.values()];
      // Whole-workflow polls: also drop local nodes the server no longer
      // has (someone else / another tab deleted them). Optimistic creations
      // inside the grace window are exempt — see localNodeArrivedAt.
      if (incomingEdges) {
        const incomingIds = new Set(incoming.map((n) => n.id));
        nodes = nodes.filter((n) => {
          if (incomingIds.has(n.id)) return true;
          const arrivedAt = localNodeArrivedAt.get(n.id);
          if (arrivedAt !== undefined && now - arrivedAt < LOCAL_NODE_GRACE_MS) {
            return true;
          }
          localNodeArrivedAt.delete(n.id);
          return false;
        });
      }
      // Edges: replace wholesale with the incoming set when the caller
      // polled a whole workflow, EXCEPT optimistic "tmp_" edges whose
      // server confirmation (confirmEdge) is still in flight — dropping
      // those would lose the pending connection locally even though the
      // server row exists.
      const edges = incomingEdges
        ? [
            ...incomingEdges,
            ...s.workflow.edges.filter((e) => isTempEdge(e)),
          ]
        : s.workflow.edges;
      return {
        workflow: { ...s.workflow, nodes, edges },
        ...(nextDirty !== s.dirtyNodeIds ? { dirtyNodeIds: nextDirty } : {}),
      };
    }),

  markNodeDirty: (id) =>
    set((s) =>
      s.dirtyNodeIds.includes(id) ? {} : { dirtyNodeIds: [...s.dirtyNodeIds, id] },
    ),
  clearNodeDirty: (id) =>
    set((s) => ({ dirtyNodeIds: s.dirtyNodeIds.filter((x) => x !== id) })),

  select: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  toggleSelect: (id) =>
    set((s) => ({
      selectedId: id,
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  selectMany: (ids) => set({ selectedIds: ids, selectedId: ids[0] ?? null }),
  inspect: (id) => set({ inspectId: id }),
  setPendingFrom: (p) => set({ pendingFrom: p }),
  cancelConnect: () => set({ pendingFrom: null }),
  setViewport: (patch) =>
    set((s) => ({
      viewport: {
        x: patch.x ?? s.viewport.x,
        y: patch.y ?? s.viewport.y,
        zoom: clamp(patch.zoom ?? s.viewport.zoom, ZOOM_MIN, ZOOM_MAX),
      },
    })),
  panBy: (dx, dy) =>
    set((s) => ({ viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy } })),
  zoomTo: (z) => set((s) => ({ viewport: { ...s.viewport, zoom: clamp(z, ZOOM_MIN, ZOOM_MAX) } })),
  setDragActive: (b) => set({ dragActive: b }),
  setBand: (b) => set({ band: b }),

  setAgents: (a) => set({ agents: a }),
  setAgentsLoading: (b) => set({ agentsLoading: b }),

  setActivePanel: (p) => set({ activePanel: p }),
  setPaletteQuery: (q) => set({ paletteQuery: q }),
  setMobilePaletteOpen: (b) => set({ mobilePaletteOpen: b }),
  setInspectorTab: (t) => set({ inspectorTab: t }),
  setSidebarCollapsed: (b) => set({ sidebarCollapsed: b }),
  setEnvironmentSheetOpen: (b) => set({ environmentSheetOpen: b }),
  setClusterSheetOpen: (b) => set({ clusterSheetOpen: b }),

  toast: (t) => {
    const id = Math.random().toString(36).slice(2, 9);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Client-side guard: would connecting from→to create a cycle or be invalid? */
export function canConnect(
  edges: EdgeDTO[],
  fromId: string,
  toId: string,
): { ok: true } | { ok: false; reason: string } {
  if (fromId === toId) return { ok: false, reason: "Cannot connect a node to itself." };
  const dup = edges.some(
    (e) => e.fromNodeId === fromId && e.toNodeId === toId,
  );
  if (dup) return { ok: false, reason: "Connection already exists." };
  if (wouldCreateCycle(edges, fromId, toId))
    return { ok: false, reason: "Connection would create a cycle." };
  return { ok: true };
}

/** Clamp a node drop position so the card stays in-bounds. */
export function clampDrop(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(x - CARD_W / 2), WORLD_MIN, WORLD_MAX - CARD_W),
    y: clamp(Math.round(y - CARD_H / 2), WORLD_MIN, WORLD_MAX - CARD_H),
  };
}
