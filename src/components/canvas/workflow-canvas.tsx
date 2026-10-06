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
  Trash2,
  X,
  Group as GroupIcon,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import type { NodeDTO, NodeType, NodeSpec, WorkflowDTO } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { dropAvoiding } from "@/lib/canvas-utils";
import {
  deriveSweepGroups,
  SweepGroupCard,
} from "@/components/canvas/sweep-group-card";
import { useHistoryStore } from "@/lib/history-store";
import {
  applyHistorySnapshot,
  captureCurrentSnapshot,
  isApplyingHistory,
  withHistorySuppressed,
} from "@/lib/history-apply";
import { Button } from "@/components/ui/button";
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
import { NodeGroupLayer, createGroupFromSelection } from "./node-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  const selectedIds = useAppStore((s) => s.selectedIds);

  const setViewport = useAppStore((s) => s.setViewport);
  const panBy = useAppStore((s) => s.panBy);
  const selectMany = useAppStore((s) => s.selectMany);
  const select = useAppStore((s) => s.select);
  const setBand = useAppStore((s) => s.setBand);
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

  const [createMenu, setCreateMenu] = React.useState<CreateMenuState | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [groupPromptOpen, setGroupPromptOpen] = React.useState(false);
  const [groupLabel, setGroupLabel] = React.useState("");

  // Floating action bar after rubber-band selection (2+ nodes).
  // Position is in canvas-section-local screen coords (matches bandRect).
  const [selectionBar, setSelectionBar] = React.useState<{ x: number; y: number } | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);

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

  // --- Keyboard shortcut: Ctrl+G opens the "group selection" prompt. ---
  // Skip when typing in an input / textarea / contenteditable so the
  // browser's text-editing shortcuts (and our own group prompt input)
  // don't conflict with this global listener.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() !== "g") return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      e.preventDefault();
      setGroupLabel("");
      setGroupPromptOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- Submit / cancel the group prompt. ------------------------------
  const submitGroupPrompt = React.useCallback(() => {
    const label = groupLabel.trim() || "Group";
    createGroupFromSelection(label, "teal");
    setGroupLabel("");
    setGroupPromptOpen(false);
  }, [groupLabel]);

  const cancelGroupPrompt = React.useCallback(() => {
    setGroupLabel("");
    setGroupPromptOpen(false);
  }, []);

  // --- Hide the floating selection action bar whenever the multi-selection
  // drops below 2 nodes (e.g. user clicks a single node, clicks empty space,
  // or uses the bar's Cancel button). The bar position is anchored to where
  // the rubber-band was drawn, so it's only meaningful while that selection
  // is still active.
  React.useEffect(() => {
    if (selectedIds.length < 2) {
      setSelectionBar(null);
    }
  }, [selectedIds]);

  // --- Bulk-delete every node in the current selection. ------------------
  // Pushes a history snapshot BEFORE the removal (so Ctrl+Z restores the
  // whole batch in one step), optimistically strips the nodes + their edges
  // in ONE store transition (suppressed — the inline snapshot above is the
  // single capture), fires every DELETE in parallel, and RESTORES the nodes
  // whose DELETE actually failed (HTTP failures used to leave them deleted
  // locally while they still existed server-side).
  const handleBulkDelete = React.useCallback(async () => {
    const s = useAppStore.getState();
    const ids = s.selectedIds;
    if (ids.length === 0) return;
    const removed = new Set(ids);
    const before = s.workflow;
    if (before) {
      useHistoryStore.getState().push({
        nodes: before.nodes,
        edges: before.edges,
        viewport: s.viewport,
      });
      // One transition, capture-suppressed: the inline push above already
      // recorded the pre-delete state — a second (subscription) capture
      // would make undo restore the same state twice in a row.
      withHistorySuppressed(() => {
        s.setWorkflow({
          ...before,
          nodes: before.nodes.filter((n) => !removed.has(n.id)),
          edges: before.edges.filter(
            (e) => !removed.has(e.fromNodeId) && !removed.has(e.toNodeId),
          ),
        });
      });
    }
    s.select(null);
    setSelectionBar(null);
    setBulkDeleteOpen(false);
    // allSettled + per-request res.ok counting (Promise.all resolves even
    // on HTTP 500 — it only rejects on network errors, so a failed DELETE
    // used to count as success).
    const results = await Promise.allSettled(
      ids.map((id) => fetch(`/api/workflow/nodes/${id}`, { method: "DELETE" })),
    );
    let okCount = 0;
    const failedIds = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.ok) okCount++;
      else failedIds.add(ids[i]);
    });
    if (failedIds.size === 0) {
      toast({
        title: `Deleted ${okCount} node${okCount > 1 ? "s" : ""}`,
        variant: "success",
      });
      return;
    }
    // Rollback: re-add the nodes whose DELETE failed (they still exist
    // server-side) plus the edges that connected them to surviving nodes.
    const cur = useAppStore.getState().workflow;
    if (cur && before) {
      const failedNodes = before.nodes.filter((n) => failedIds.has(n.id));
      const restoredEdges = before.edges.filter(
        (e) =>
          (failedIds.has(e.fromNodeId) || failedIds.has(e.toNodeId)) &&
          !cur.edges.some((x) => x.id === e.id),
      );
      withHistorySuppressed(() => {
        useAppStore.getState().setWorkflow({
          ...cur,
          nodes: [...cur.nodes, ...failedNodes],
          edges: [...cur.edges, ...restoredEdges],
        });
      });
    }
    toast({
      title: "Some deletes failed",
      description: `${okCount} deleted · ${failedIds.size} kept (restored)`,
      variant: "destructive",
    });
  }, [toast]);

  // --- Group the current selection (from the floating action bar). ------
  const handleGroupFromBar = React.useCallback(() => {
    createGroupFromSelection("Group", "teal");
    setSelectionBar(null);
  }, []);

  // --- Cancel the floating action bar (= deselect everything). ----------
  const handleCancelSelectionBar = React.useCallback(() => {
    useAppStore.getState().select(null);
    setSelectionBar(null);
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
  // Boot failures surface through store.setError so the canvas can swap its
  // loading overlay for an error + Retry card (the page-level catch does the
  // same). loadWorkflow is shared with the Retry button.
  const loadWorkflow = React.useCallback(async () => {
    const s = useAppStore.getState();
    s.setLoading(true);
    s.setError(null);
    try {
      const res = await fetch("/api/workflow");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const w: WorkflowDTO = await res.json();
      useAppStore.getState().setWorkflow(w);
    } catch (e) {
      useAppStore.getState().setError(
        e instanceof Error ? e.message : "Could not load the workflow.",
      );
    } finally {
      useAppStore.getState().setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    if (workflow) return;
    void loadWorkflow();
  }, [workflow, loadWorkflow]);

  // --- History: subscribe to workflow changes — push the PREVIOUS state
  // whenever an edge is removed (covers edges-layer delete chip, which has
  // no inline push). Node delete / edge connect / bulk delete / node-create
  // sites push their own inline snapshot and write under
  // withHistorySuppressed, so they never reach this subscription — it only
  // captures the paths without an inline push (edges-layer chip, palette
  // click, empty-state chips, double-click create, HTML5 drop).
  React.useEffect(() => {
    const unsub = useAppStore.subscribe((state, prevState) => {
      // Undo/redo restorations and suppressed inline mutations must not
      // re-capture themselves as new history entries.
      if (isApplyingHistory()) return;
      const prevWf = prevState.workflow;
      const curWf = state.workflow;
      if (!prevWf || !curWf) return;
      // A workflow SWITCH is not an undoable mutation — the node/edge count
      // delta comes from swapping the whole graph, and capturing the OLD
      // workflow's snapshot here would let a later Ctrl+Z replay it against
      // the NEW workflow (cross-workflow contamination, seen in e2e QA).
      if (prevWf.id !== curWf.id) return;
      // At most ONE snapshot per subscription tick: a single transition can
      // change both node and edge counts (bulk delete, cascade) — the old
      // if-chain pushed the same pre-state twice, making undo "sticky"
      // (two presses restored the same snapshot).
      const prevSnap = {
        nodes: prevWf.nodes,
        edges: prevWf.edges,
        viewport: prevState.viewport,
      };
      if (curWf.edges.length < prevWf.edges.length) {
        // Edge removed? (covers edges-layer delete chip)
        useHistoryStore.getState().push(prevSnap);
      } else if (curWf.nodes.length < prevWf.nodes.length) {
        // Node removed? (covers paths without an inline push)
        useHistoryStore.getState().push(prevSnap);
      } else if (curWf.nodes.length > prevWf.nodes.length) {
        // Node added? (covers palette click / empty-state chips / drop)
        useHistoryStore.getState().push(prevSnap);
      } else if (curWf.edges.length > prevWf.edges.length) {
        // Edge added? (covers port-connect failures without inline push)
        useHistoryStore.getState().push(prevSnap);
      }
    });
    return unsub;
  }, []);

  // --- Undo/redo application is shared (src/lib/history-apply.ts). --------
  // The old local copy re-POSTed restored nodes but kept the OLD local ids
  // (the server mints new ones) so later PATCHes 404'd; the shared helper
  // remaps ids for both nodes and edges and keeps DB + store consistent.

  // --- Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z (or Ctrl+Y) redo. ---
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // The CURRENT state is captured at call time and pushed onto the
      // opposite stack (undo→future, redo→past) — the store's undo/redo no
      // longer re-push the snapshot being RESTORED (that made undo a
      // toggle: redo re-restored the same pre-op state forever).
      const current = captureCurrentSnapshot();
      if (!current) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        const snap = useHistoryStore.getState().undo(current);
        if (snap) void applyHistorySnapshot(snap);
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        const snap = useHistoryStore.getState().redo(current);
        if (snap) void applyHistorySnapshot(snap);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- Wheel: zoom-to-cursor (passive:false so we can preventDefault). -----
  // The ref'd <section> below is ALWAYS mounted — including while the
  // workflow is still loading or failed (the loading/error states render as
  // overlays INSIDE the section instead of replacing it). This effect used
  // to run once on first mount while an early-returned loading branch —
  // WITHOUT the ref — was rendered, so rootRef.current was null and the
  // wheel listener never attached; the [setViewport] deps never re-ran once
  // the workflow arrived, leaving zoom dead until a panel switch remounted
  // the whole canvas. With a stable ref'd section the listener attaches on
  // the first mount and survives every state change.
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
        // B3 consistency: band-select hits VISIBLE nodes only — a band over a
        // collapsed group card area must not silently select the hidden
        // members (which would float a delete-bar over invisible targets).
        const hitIds =
          visibleNodes
            .filter((n) => {
              const nx = n.x * vp.zoom + vp.x;
              const ny = n.y * vp.zoom + vp.y;
              const nw = CARD_W * vp.zoom;
              const nh = CARD_H * vp.zoom;
              return !(nx + nw < x0 || nx > x1 || ny + nh < y0 || ny > y1);
            })
            .map((n) => n.id) ?? [];
        selectMany(hitIds);
        // Anchor the floating action bar at the CENTER of the rubber-band
        // rect (screen coords, relative to the canvas section). Only show it
        // when the drag actually enclosed 2+ nodes — otherwise the bar would
        // be a useless stub for single-node selections.
        if (hitIds.length >= 2) {
          setSelectionBar({
            x: (x0 + x1) / 2,
            y: (y0 + y1) / 2,
          });
        } else {
          setSelectionBar(null);
        }
      } else {
        select(null);
        setSelectionBar(null);
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
      // B1 anti-overlap: clamp to world bounds, then spiral away from any
      // existing card (two quick-starts in a row no longer stack).
      const pos = dropAvoiding(
        (useAppStore.getState().workflow?.nodes ?? []).map((n) => ({ x: n.x, y: n.y })),
        worldCenterX,
        worldCenterY,
      );
      try {
        const res = await fetch("/api/workflow/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Contract (task 3-a): create the node in the CURRENT workflow —
            // omitting workflowId makes the server fall back to its first-
            // workflow default, which breaks the multi-workflow switcher.
            workflowId: useAppStore.getState().workflow?.id,
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
      // B1 anti-overlap: menu position + spiral away from existing cards.
      const pos = dropAvoiding(
        (useAppStore.getState().workflow?.nodes ?? []).map((n) => ({ x: n.x, y: n.y })),
        worldX,
        worldY,
      );
      setCreateMenu(null);
      try {
        const res = await fetch("/api/workflow/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Target the CURRENT workflow (multi-workflow contract).
            workflowId: useAppStore.getState().workflow?.id,
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
    // B1 anti-overlap: drop point + spiral away from existing cards (a drop
    // onto an occupied spot lands beside it, not on top of it).
    const pos = dropAvoiding(
      (useAppStore.getState().workflow?.nodes ?? []).map((n) => ({ x: n.x, y: n.y })),
      wx,
      wy,
    );
    const spec = nodeSpec(type);
    try {
      const res = await fetch("/api/workflow/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Target the CURRENT workflow (multi-workflow contract).
          workflowId: useAppStore.getState().workflow?.id,
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

  // --- Loading / error states. --------------------------------------------
  // IMPORTANT: these render as OVERLAYS inside the ALWAYS-MOUNTED, ref'd
  // <section> below — never as an early-return replacement branch (see the
  // wheel effect comment: a replacement branch without the ref left the
  // wheel listener unattached forever). Boot errors (store.error, set by
  // page.tsx / loadWorkflow) swap the spinner for an honest error card with
  // a Retry button instead of spinning forever.
  const bootError = useAppStore((s) => s.error);

  const nodes = workflow?.nodes ?? [];
  const edges = workflow?.edges ?? [];
  const zoom = viewport.zoom;

  // ── B3: sweep aggregate groups ─────────────────────────────────────
  // Collapsed groups render ONE aggregate card instead of their members;
  // wires (EdgesLayer/LiveWire) see members mapped onto the card position.
  const collapsedSweepGroups = useAppStore((s) => s.collapsedSweepGroups);
  const sweepGroups = React.useMemo(() => deriveSweepGroups(nodes), [nodes]);
  const collapsedGroups = React.useMemo(
    () =>
      [...sweepGroups.values()].filter((g) =>
        collapsedSweepGroups.includes(g.groupId),
      ),
    [sweepGroups, collapsedSweepGroups],
  );
  const collapsedMemberIds = React.useMemo(
    () => new Set(collapsedGroups.flatMap((g) => g.members.map((m) => m.id))),
    [collapsedGroups],
  );
  const visibleNodes = React.useMemo(
    () => nodes.filter((n) => !collapsedMemberIds.has(n.id)),
    [nodes, collapsedMemberIds],
  );
  const layoutNodes = React.useMemo(() => {
    if (collapsedGroups.length === 0) return nodes;
    const posById = new Map<string, { x: number; y: number }>();
    for (const g of collapsedGroups) {
      for (const m of g.members) posById.set(m.id, { x: g.x, y: g.y });
    }
    return nodes.map((n) => {
      const p = posById.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
  }, [nodes, collapsedGroups]);

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
        {/* Node-group overlays (behind nodes, above grid). */}
        <NodeGroupLayer />
        <EdgesLayer edges={edges} nodes={layoutNodes} />
        {/* B3: collapsed sweep groups — one aggregate card per group. */}
        {collapsedGroups.map((g) => (
          <SweepGroupCard key={g.groupId} group={g} />
        ))}
        {visibleNodes.map((n) => (
          <div key={n.id} data-node-card>
            <NodeCard node={n} />
          </div>
        ))}
      </div>

      {/* LiveWire overlay (screen-relative). */}
      <LiveWire nodes={layoutNodes} />

      {/* Loading / boot-error overlays — while the workflow itself hasn't
          loaded. Fully opaque (bg-background) so they also block canvas
          pointer interactions until there is something to interact with. */}
      {!workflow && bootError && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <AlertTriangle className="size-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium">Couldn&apos;t load the workflow</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {bootError}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadWorkflow()}
            className="mt-1 gap-1.5"
          >
            Retry
          </Button>
        </div>
      )}
      {!workflow && !bootError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-sm">Loading workflow…</p>
          </div>
        </div>
      )}

      {/* Band selection overlay.
          • items-start on the wrapper so any future inline children align
            to the band's top-left rather than centering.
          • More visible than the prior 6%-alpha ghost: a 14%-alpha primary
            fill + 1.5px dashed primary stroke (70% alpha) — clearly readable
            over both light and dark grids. */}
      {bandRect && (
        <svg
          className="pointer-events-none absolute inset-0 z-20 flex items-start"
          width="100%"
          height="100%"
        >
          <rect
            x={bandRect.x}
            y={bandRect.y}
            width={bandRect.w}
            height={bandRect.h}
            className="band-ants"
            fill="hsl(var(--primary) / 0.14)"
            stroke="hsl(var(--primary) / 0.7)"
            strokeWidth={1.5}
            strokeDasharray="6 3"
            rx={2}
            ry={2}
          />
        </svg>
      )}

      {/* Empty state. */}
      {workflow && nodes.length === 0 && (
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
                onClick={() => void createNodeAtViewportCenter("alphafold")}
                className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 transition-colors hover:bg-cyan-500/20 dark:text-cyan-300"
              >
                <Cpu className="size-3.5" />
                Add AlphaFold
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

      {/* Group prompt (Ctrl+G) — floating label input at the viewport center. */}
      {groupPromptOpen && (
        <>
          {/* Click-away catcher. */}
          <div
            className="fixed inset-0 z-30"
            onPointerDown={(e) => {
              e.stopPropagation();
              cancelGroupPrompt();
            }}
          />
          <div className="absolute left-1/2 top-1/2 z-40 w-[19rem] -translate-x-1/2 -translate-y-1/2">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Box className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Create group</span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">Ctrl</kbd>
                  <kbd className="ml-0.5 rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">G</kbd>
                </span>
              </div>
              <input
                autoFocus
                value={groupLabel}
                onChange={(e) => setGroupLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitGroupPrompt();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelGroupPrompt();
                  }
                }}
                placeholder="Group label…"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">Enter</kbd>{" "}
                  create · {" "}
                  <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">Esc</kbd>{" "}
                  cancel
                </span>
                <button
                  type="button"
                  onClick={submitGroupPrompt}
                  className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Floating action bar — appears after a rubber-band select of 2+ nodes.
          Anchored at the center of the just-drawn band rect (screen coords).
          Offers: Group (Ctrl+G), Delete (with confirm), Cancel (deselect). */}
      {selectionBar && selectedIds.length >= 2 && (
        <div
          role="toolbar"
          aria-label="Selection actions"
          className="absolute z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-1 shadow-lg"
          style={{ left: selectionBar.x, top: selectionBar.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="px-1.5 text-[11px] font-medium text-muted-foreground">
            {selectedIds.length} selected
          </span>
          <div className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={handleGroupFromBar}
            title="Group selection (Ctrl+G)"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <GroupIcon className="size-3.5 text-teal-500" />
            Group
            <span className="hidden items-center gap-0.5 sm:inline-flex">
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono">Ctrl</kbd>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono">G</kbd>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setBulkDeleteOpen(true)}
            title="Delete selected nodes"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
          <button
            type="button"
            onClick={handleCancelSelectionBar}
            title="Clear selection"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
          >
            <X className="size-3.5" />
            Cancel
          </button>
        </div>
      )}

      {/* Bulk-delete confirm. */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.length} node{selectedIds.length > 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove all selected nodes and any edges
              connected to them. This action cannot be undone (except via
              Ctrl+Z undo).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleBulkDelete()}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete {selectedIds.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// Tiny local cn helper to avoid pulling extra deps if not needed elsewhere here.
function cnCanvas(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Re-export NodeType as a hint for consumers; keeps the file self-documenting.
export type { NodeType };
