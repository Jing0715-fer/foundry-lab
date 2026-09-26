// Zustand store — workflow canvas state + UI state. Client-only.
import { create } from "zustand";
import type { NodeDTO, EdgeDTO, WorkflowDTO, AgentDTO } from "./types";
import { ZOOM_MIN, ZOOM_MAX, WORLD_MIN, WORLD_MAX, CARD_W, CARD_H } from "./workflow-catalog";
import { wouldCreateCycle, clamp } from "./canvas-utils";

export interface Viewport { x: number; y: number; zoom: number; }
export interface PendingFrom { nodeId: string; port: string; dir: "out" | "in"; }

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive" | "success";
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

  // ui
  activePanel: "canvas" | "agents" | "tasks" | "meetings" | "research" | "tools" | "dashboard";
  paletteQuery: string;
  inspectorTab: string;
  toasts: ToastItem[];
  sidebarCollapsed: boolean;

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
  mergeNodes: (incoming: NodeDTO[]) => void;

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
  setInspectorTab: (t: string) => void;
  setSidebarCollapsed: (b: boolean) => void;
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

  activePanel: "canvas",
  paletteQuery: "",
  inspectorTab: "params",
  toasts: [],
  sidebarCollapsed: false,

  setWorkflow: (w) => set({ workflow: w, loading: false, error: null }),
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e, loading: false }),

  upsertNode: (n) =>
    set((s) => {
      if (!s.workflow) return {};
      const exists = s.workflow.nodes.some((x) => x.id === n.id);
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

  mergeNodes: (incoming) =>
    set((s) => {
      if (!s.workflow) return {};
      const byId = new Map(s.workflow.nodes.map((n) => [n.id, n]));
      for (const n of incoming) byId.set(n.id, { ...byId.get(n.id), ...n });
      return { workflow: { ...s.workflow, nodes: [...byId.values()] } };
    }),

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
  setInspectorTab: (t) => set({ inspectorTab: t }),
  setSidebarCollapsed: (b) => set({ sidebarCollapsed: b }),

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
