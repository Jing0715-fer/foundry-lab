"use client";

import React from "react";
import {
  Bot,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Database,
  ArrowRightToLine,
  Flag,
  Box,
  Loader2,
  Workflow,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { NodeDTO, NodeType, NodeSpec } from "@/lib/types";
import { useAppStore, clampDrop } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import {
  NODE_SPECS,
  CARD_W,
  CARD_H,
  ZOOM_MIN,
  ZOOM_MAX,
  nodeSpec,
} from "@/lib/workflow-catalog";
import { EdgesLayer } from "./edges-layer";
import { NodeCard } from "./node-card";
import { LiveWire } from "./live-wire";
import { CanvasMinimap, useMinimapStore } from "./canvas-minimap";
import { NodeSearch } from "./node-search";

const ICON_MAP: Record<string, LucideIcon> = {
  bot: Bot,
  "square-pen": SquarePen,
  users: Users,
  "book-open": BookOpen,
  cpu: Cpu,
  database: Database,
  "arrow-right-to-line": ArrowRightToLine,
  flag: Flag,
};

interface CreateMenuState {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
}

/**
 * WorkflowCanvas — the main cryoflow-style canvas.
 * Owns: pan, wheel-zoom-to-cursor, rubber-band selection, double-click create,
 * HTML5 drop from the palette. Does NOT render zoom controls (owned by 6-b).
 */
export function WorkflowCanvas() {
  const workflow = useAppStore((s) => s.workflow);
  const viewport = useAppStore((s) => s.viewport);
  const band = useAppStore((s) => s.band);
  const pendingFrom = useAppStore((s) => s.pendingFrom);
  const dragActive = useAppStore((s) => s.dragActive);

  const setViewport = useAppStore((s) => s.setViewport);
  const panBy = useAppStore((s) => s.panBy);
  const selectMany = useAppStore((s) => s.selectMany);
  const select = useAppStore((s) => s.select);
  const setBand = useAppStore((s) => s.setBand);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const cancelConnect = useAppStore((s) => s.cancelConnect);
  const toast = useAppStore((s) => s.toast);

  // Minimap open/closed — shared with CanvasToolbar via the tiny zustand store
  // in canvas-minimap.tsx. Default open.
  const minimapOpen = useMinimapStore((s) => s.open);
  const closeMinimap = useMinimapStore((s) => s.close);

  const rootRef = React.useRef<HTMLElement | null>(null);
  const panState = React.useRef<{ startX: number; startY: number; vx: number; vy: number } | null>(null);
  const fetchedRef = React.useRef(false);

  // Guard ref so undo/redo (which mutates the store) doesn't itself push history.
  const isApplyingHistoryRef = React.useRef(false);

  const [createMenu, setCreateMenu] = React.useState<CreateMenuState | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);

  // --- Keyboard shortcut: Ctrl+F opens the canvas node search. --------
  // Skip when typing in an input / textarea / contenteditable / dialog
  // so browser-native find never gets hijacked inside forms.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() !== "f") return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      e.preventDefault();
      setSearchOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Group specs for the create menu (constant; safe to memoize once).
  const grouped = React.useMemo(() => {
    const m = new Map<string, NodeSpec[]>();
    for (const s of NODE_SPECS) {
      if (!m.has(s.category)) m.set(s.category, []);
      m.get(s.category)!.push(s);
    }
    return [...m.entries()];
  }, []);

  // --- Initial workflow fetch (defensive; the page may also fetch). --------
  React.useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    if (workflow) return;
    void (async () => {
      try {
        const res = await fetch("/api/workflow");
        if (!res.ok) throw new Error("fetch failed");
        const w = await res.json();
        setWorkflow(w);
      } catch {
        // Stay in loading state; other agents may retry.
      }
    })();
  }, [workflow, setWorkflow]);

  // --- History: subscribe to workflow changes — push the PREVIOUS state
  // whenever an edge is removed (covers edges-layer delete chip, which is
  // not in our owned file list). Node delete / edge connect / auto-arrange
  // are handled by direct inline pushes in node-card.tsx and
  // canvas-toolbar.tsx (the files that own those operations).
  React.useEffect(() => {
    const unsub = useAppStore.subscribe((state, prevState) => {
      if (isApplyingHistoryRef.current) return;
      const prevWf = prevState.workflow;
      const curWf = state.workflow;
      if (!prevWf || !curWf) return;
      // Edge removed? (covers edges-layer delete chip)
      if (curWf.edges.length < prevWf.edges.length) {
        useHistoryStore.getState().push({
          nodes: prevWf.nodes,
          edges: prevWf.edges,
          viewport: prevState.viewport,
        });
      }
      // Node removed? (covers inspector/node-card delete)
      if (curWf.nodes.length < prevWf.nodes.length) {
        useHistoryStore.getState().push({
          nodes: prevWf.nodes,
          edges: prevWf.edges,
          viewport: prevState.viewport,
        });
      }
      // Node added? (covers palette click / empty-state chips / double-click create)
      if (curWf.nodes.length > prevWf.nodes.length) {
        useHistoryStore.getState().push({
          nodes: prevWf.nodes,
          edges: prevWf.edges,
          viewport: prevState.viewport,
        });
      }
      // Edge added? (covers port-connect)
      if (curWf.edges.length > prevWf.edges.length) {
        useHistoryStore.getState().push({
          nodes: prevWf.nodes,
          edges: prevWf.edges,
          viewport: prevState.viewport,
        });
      }
    });
    return unsub;
  }, []);

  // --- Apply an undo/redo snapshot to the app store. --------------------
  const applySnapshot = React.useCallback((snap: {
    nodes: NodeDTO[];
    edges: import("@/lib/types").EdgeDTO[];
    viewport: { x: number; y: number; zoom: number };
  }) => {
    isApplyingHistoryRef.current = true;
    const s = useAppStore.getState();
    if (s.workflow) {
      const curNodes = s.workflow.nodes;
      const snapIds = new Set(snap.nodes.map((n) => n.id));
      const curIds = new Set(curNodes.map((n) => n.id));
      // Delete nodes in current but not in snapshot.
      for (const n of curNodes) {
        if (!snapIds.has(n.id)) {
          void fetch(`/api/workflow/nodes/${n.id}`, { method: "DELETE" }).catch(() => {});
        }
      }
      // Re-create nodes in snapshot but not in current.
      for (const n of snap.nodes) {
        if (!curIds.has(n.id)) {
          void fetch("/api/workflow/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: n.type, name: n.name, x: n.x, y: n.y, refId: n.refId ?? undefined, params: n.params }),
          }).catch(() => {});
        }
      }
      // Sync edges.
      const snapEdgeKeys = new Set(snap.edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`));
      const curEdgeKeys = new Set(s.workflow.edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`));
      for (const e of s.workflow.edges) {
        if (!snapEdgeKeys.has(`${e.fromNodeId}->${e.toNodeId}`)) {
          void fetch(`/api/workflow/edges/${e.id}`, { method: "DELETE" }).catch(() => {});
        }
      }
      for (const e of snap.edges) {
        if (!curEdgeKeys.has(`${e.fromNodeId}->${e.toNodeId}`)) {
          void fetch("/api/workflow/edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, fromPort: e.fromPort, toPort: e.toPort }),
          }).catch(() => {});
        }
      }
      s.setWorkflow({ ...s.workflow, nodes: snap.nodes, edges: snap.edges });
    }
    s.setViewport(snap.viewport);
    window.setTimeout(() => {
      isApplyingHistoryRef.current = false;
    }, 0);
  }, []);

  // --- Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z (or Ctrl+Y) redo. ---
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        const snap = useHistoryStore.getState().undo();
        if (snap) applySnapshot(snap);
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        const snap = useHistoryStore.getState().redo();
        if (snap) applySnapshot(snap);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applySnapshot]);

  // --- Wheel: zoom-to-cursor (passive:false so we can preventDefault). -----
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const curZoom = useAppStore.getState().viewport.zoom;
      const factor = Math.pow(1.0015, -e.deltaY);
      let next = curZoom * factor;
      if (next < ZOOM_MIN) next = ZOOM_MIN;
      if (next > ZOOM_MAX) next = ZOOM_MAX;
      if (next === curZoom) return;
      const vp = useAppStore.getState().viewport;
      // Keep the workspace point under the cursor fixed.
      const nx = sx - (sx - vp.x) * (next / curZoom);
      const ny = sy - (sy - vp.y) * (next / curZoom);
      setViewport({ x: nx, y: ny, zoom: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setViewport]);

  // --- Background detection (pan / band start only on empty area). ---------
  const isBackground = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el) return false;
    // Reject anything that is a node card or port.
    if (el.closest("[data-node-card]")) return false;
    if (el.closest("[data-port]")) return false;
    if (el.closest("[data-create-menu]")) return false;
    return true;
  };

  // --- Pointer handlers: pan + rubber-band. -------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!isBackground(e.target)) return;
    if (e.button !== 0 && e.button !== 1) return;
    // Double-click creates — ignore the 2nd pointerdown of a dblclick.
    if (e.detail >= 2) return;
    // Cancel any pending connection on background click.
    if (pendingFrom) {
      cancelConnect();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.shiftKey) {
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setBand({ x0: x, y0: y, x1: x, y1: y });
    } else {
      panState.current = {
        startX: e.clientX,
        startY: e.clientY,
        vx: viewport.x,
        vy: viewport.y,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (panState.current) {
      const dx = e.clientX - panState.current.startX;
      const dy = e.clientY - panState.current.startY;
      panBy(dx, dy);
      panState.current.startX = e.clientX;
      panState.current.startY = e.clientY;
      return;
    }
    if (band) {
      const rect = e.currentTarget.getBoundingClientRect();
      setBand({ ...band, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (panState.current) {
      panState.current = null;
      return;
    }
    if (band) {
      const x0 = Math.min(band.x0, band.x1);
      const y0 = Math.min(band.y0, band.y1);
      const x1 = Math.max(band.x0, band.x1);
      const y1 = Math.max(band.y0, band.y1);
      const vp = viewport;
      const tiny = (x1 - x0) < 4 && (y1 - y0) < 4;
      if (!tiny) {
        const hitIds =
          workflow?.nodes
            .filter((n) => {
              const nx = n.x * vp.zoom + vp.x;
              const ny = n.y * vp.zoom + vp.y;
              const nw = CARD_W * vp.zoom;
              const nh = CARD_H * vp.zoom;
              return !(nx + nw < x0 || nx > x1 || ny + nh < y0 || ny > y1);
            })
            .map((n) => n.id) ?? [];
        selectMany(hitIds);
      } else {
        select(null);
      }
      setBand(null);
    }
  };

  // --- Double-click empty area → create menu. -----------------------------
  const onDoubleClick = (e: React.PointerEvent<HTMLElement>) => {
    if (!isBackground(e.target)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const vp = viewport;
    const wx = (sx - vp.x) / vp.zoom;
    const wy = (sy - vp.y) / vp.zoom;
    setCreateMenu({ screenX: sx, screenY: sy, worldX: wx, worldY: wy });
  };

  // --- Empty-state quick-start: drop a node at the visible viewport center. --
  const createNodeAtViewportCenter = React.useCallback(
    async (type: NodeType) => {
      const spec = nodeSpec(type);
      if (!spec) return;
      const el = rootRef.current;
      const w = el?.clientWidth && el.clientWidth > 0 ? el.clientWidth : 900;
      const h = el?.clientHeight && el.clientHeight > 0 ? el.clientHeight : 600;
      const vp = useAppStore.getState().viewport;
      const worldCenterX = (vp.x + w / 2) / vp.zoom - 124;
      const worldCenterY = (vp.y + h / 2) / vp.zoom - 58;
      // For agent nodes, pre-select the first available agent as refId.
      const extra: Record<string, unknown> = {};
      if (type === "agent") {
        const agents = useAppStore.getState().agents;
        if (agents.length > 0) {
          extra.refId = agents[0].id;
          extra.name = agents[0].title;
        }
      }
      const pos = clampDrop(worldCenterX, worldCenterY);
      try {
        const res = await fetch("/api/workflow/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: spec.type,
            name: extra.name ?? spec.label,
            x: pos.x,
            y: pos.y,
            ...extra,
          }),
        });
        if (!res.ok) throw new Error("create failed");
        const created: NodeDTO = await res.json();
        upsertNode(created);
        useAppStore.getState().select(created.id);
        useAppStore.getState().inspect(created.id);
        toast({ title: `${created.name} added`, variant: "success" });
      } catch {
        toast({ title: "Failed to add node", variant: "destructive" });
      }
    },
    [upsertNode, toast],
  );

  // --- Create node from menu. ---------------------------------------------
  const createNode = React.useCallback(
    async (spec: NodeSpec) => {
      if (!createMenu) return;
      const { worldX, worldY } = createMenu;
      const pos = clampDrop(worldX, worldY);
      setCreateMenu(null);
      try {
        const res = await fetch("/api/workflow/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: spec.type,
            name: spec.label,
            x: pos.x,
            y: pos.y,
          }),
        });
        if (!res.ok) throw new Error("create failed");
        const created: NodeDTO = await res.json();
        upsertNode(created);
        toast({ title: `${spec.label} added` });
      } catch {
        toast({ title: "Failed to add node", variant: "destructive" });
      }
    },
    [createMenu, upsertNode, toast],
  );

  // --- HTML5 drop from palette. -------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/node-type")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    const type = e.dataTransfer.getData("application/node-type");
    if (!type) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const vp = viewport;
    const wx = (sx - vp.x) / vp.zoom;
    const wy = (sy - vp.y) / vp.zoom;
    const pos = clampDrop(wx, wy);
    const spec = nodeSpec(type);
    try {
      const res = await fetch("/api/workflow/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          name: spec?.label ?? type,
          x: pos.x,
          y: pos.y,
        }),
      });
      if (!res.ok) throw new Error("create failed");
      const created: NodeDTO = await res.json();
      upsertNode(created);
      toast({ title: `${spec?.label ?? type} added` });
    } catch {
      toast({ title: "Failed to add node", variant: "destructive" });
    }
  };

  // --- Loading state. -----------------------------------------------------
  if (!workflow) {
    return (
      <section className="canvas-grid relative flex-1 overflow-hidden bg-background">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-sm">Loading workflow…</p>
          </div>
        </div>
      </section>
    );
  }

  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const zoom = viewport.zoom;

  // Band rect for rendering (normalized).
  const bandRect = band
    ? {
        x: Math.min(band.x0, band.x1),
        y: Math.min(band.y0, band.y1),
        w: Math.abs(band.x1 - band.x0),
        h: Math.abs(band.y1 - band.y0),
      }
    : null;

  return (
    <section
      ref={rootRef}
      data-canvas="viewport"
      className={cnCanvas(
        "canvas-grid relative flex-1 overflow-hidden touch-none bg-background select-none",
        dragActive ? "cursor-grabbing" : "cursor-grab",
      )}
      style={{
        backgroundSize: `${22 / zoom}px ${22 / zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Workspace (transformed). */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          width: 0,
          height: 0,
        }}
      >
        <EdgesLayer edges={edges} nodes={nodes} />
        {nodes.map((n) => (
          <div key={n.id} data-node-card>
            <NodeCard node={n} />
          </div>
        ))}
      </div>

      {/* LiveWire overlay (screen-relative). */}
      <LiveWire nodes={nodes} />

      {/* Band selection overlay. */}
      {bandRect && (
        <svg className="pointer-events-none absolute inset-0 z-20" width="100%" height="100%">
          <rect
            x={bandRect.x}
            y={bandRect.y}
            width={bandRect.w}
            height={bandRect.h}
            className="band-ants"
            fill="hsl(var(--primary) / 0.06)"
            stroke="hsl(var(--primary))"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        </svg>
      )}

      {/* Empty state. */}
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="pointer-events-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card/70 px-8 py-8 text-center shadow-sm backdrop-blur-sm">
            {/* Large icon in a muted circle */}
            <div className="empty-state-icon flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Workflow className="size-8" />
            </div>

            <div className="flex flex-col gap-1">
              <h3 className="text-lg font-medium">Start building your workflow</h3>
              <p className="text-sm text-muted-foreground">
                Drag nodes from the left palette, or double-click anywhere to add one.
              </p>
            </div>

            {/* Quick-start hint chips */}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void createNodeAtViewportCenter("agent")}
                className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
              >
                <Bot className="size-3.5" />
                Add an Agent
              </button>
              <button
                type="button"
                onClick={() => void createNodeAtViewportCenter("task")}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-500/30 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-500/20 dark:text-slate-300"
              >
                <SquarePen className="size-3.5" />
                Add a Task
              </button>
              <button
                type="button"
                onClick={() => void createNodeAtViewportCenter("comptool")}
                className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 transition-colors hover:bg-cyan-500/20 dark:text-cyan-300"
              >
                <Cpu className="size-3.5" />
                Add a Comp Tool
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create-node popover. */}
      {createMenu && (
        <>
          {/* Click-away catcher. */}
          <div
            data-create-menu
            className="fixed inset-0 z-30"
            onPointerDown={(e) => {
              e.stopPropagation();
              setCreateMenu(null);
            }}
          />
          <div
            data-create-menu
            className="absolute z-40 max-h-[60vh] w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ left: createMenu.screenX, top: createMenu.screenY }}
          >
            {grouped.map(([cat, specs]) => (
              <div key={cat} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {cat}
                </div>
                {specs.map((spec) => {
                  const Icon = ICON_MAP[spec.icon] ?? Box;
                  return (
                    <button
                      key={spec.type}
                      onClick={() => void createNode(spec)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{spec.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Bird's-eye minimap (toggled from the canvas toolbar). */}
      {minimapOpen && <CanvasMinimap onClose={closeMinimap} />}

      {/* Floating Find button — opens the node search bar (also Ctrl+F). */}
      {!searchOpen && (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Find node on canvas"
          title="Find node on canvas (Ctrl+F)"
          className="absolute left-1/2 top-3 z-20 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-lg border bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-accent hover:text-foreground"
        >
          <Search className="size-3.5" />
          Find
          <span className="ml-1 hidden items-center gap-0.5 sm:inline-flex">
            <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">Ctrl</kbd>
            <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">F</kbd>
          </span>
        </button>
      )}

      {/* Node search bar (toggled by Ctrl+F or the Find button). */}
      {searchOpen && <NodeSearch onClose={() => setSearchOpen(false)} />}
    </section>
  );
}

// Tiny local cn helper to avoid pulling extra deps if not needed elsewhere here.
function cnCanvas(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Re-export NodeType as a hint for consumers; keeps the file self-documenting.
export type { NodeType };
