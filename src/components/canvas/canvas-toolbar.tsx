"use client";

import * as React from "react";
import {
  Minus,
  Plus,
  Maximize,
  LayoutGrid,
  Play,
  Loader2,
  Crosshair,
  Undo2,
  Redo2,
  Map as MapIcon,
  Download,
  FileImage,
  PanelLeft,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import { ZOOM_MIN, ZOOM_MAX, CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { autoLayout } from "@/lib/canvas-utils";
import type { NodeDTO, EdgeDTO } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useMinimapStore } from "./canvas-minimap";
import { exportCanvasToPNG, exportCanvasToSVG } from "./canvas-export";

/** Compute a fit viewport for the given nodes & available canvas size. */
function computeFit(
  nodes: { x: number; y: number }[],
  canvasW: number,
  canvasH: number,
): { x: number; y: number; zoom: number } {
  if (nodes.length === 0) {
    return { x: 120, y: 80, zoom: 1 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + CARD_W);
    maxY = Math.max(maxY, n.y + CARD_H);
  }
  const pad = 60;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const availW = Math.max(100, canvasW - pad * 2);
  const availH = Math.max(100, canvasH - pad * 2);
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(availW / contentW, availH / contentH)));
  // Center the content bbox in the canvas viewport.
  // The viewport transform maps world (x,y) → screen (x,y) via: screen = world * zoom + viewport.
  // We want the center of the content bbox to map to the center of the canvas.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x = Math.round(canvasW / 2 - cx * zoom);
  const y = Math.round(canvasH / 2 - cy * zoom);
  return { x, y, zoom: Number(zoom.toFixed(2)) };
}

/** A button wrapped with a Tooltip. */
function ToolButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: React.ReactNode;
} & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} {...props}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Floating canvas toolbar: undo/redo, zoom, reset view, fit, auto-arrange, run-all. */
export function CanvasToolbar() {
  const viewport = useAppStore((s) => s.viewport);
  const setViewport = useAppStore((s) => s.setViewport);
  const zoomTo = useAppStore((s) => s.zoomTo);
  const workflow = useAppStore((s) => s.workflow);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const toast = useAppStore((s) => s.toast);

  // Minimap open/closed — shared with WorkflowCanvas via the tiny zustand store
  // (so this toolbar and the canvas, which are siblings in page.tsx, can both
  // react to the same toggle without lifting state up).
  const minimapOpen = useMinimapStore((s) => s.open);
  const toggleMinimap = useMinimapStore((s) => s.toggle);

  // Mobile node palette overlay (shared with NodePalette via the app store).
  const mobilePaletteOpen = useAppStore((s) => s.mobilePaletteOpen);
  const setMobilePaletteOpen = useAppStore((s) => s.setMobilePaletteOpen);

  // Reactive subscriptions for undo/redo availability.
  const pastCount = useHistoryStore((s) => s.past.length);
  const futureCount = useHistoryStore((s) => s.future.length);
  const canUndo = pastCount > 0;
  const canRedo = futureCount > 0;

  const ref = React.useRef<HTMLDivElement>(null);
  const [arranging, setArranging] = React.useState(false);
  const [runningAll, setRunningAll] = React.useState(false);

  const nodes = workflow?.nodes ?? [];
  const edges = workflow?.edges ?? [];

  /** Best-effort canvas size — use the toolbar's parent if available. */
  const canvasSize = React.useCallback(() => {
    // Prefer the actual canvas viewport element (data-canvas="viewport").
    const canvasEl = document.querySelector('[data-canvas="viewport"]') as HTMLElement | null;
    const w = canvasEl?.clientWidth && canvasEl.clientWidth > 0
      ? canvasEl.clientWidth
      : ref.current?.parentElement?.clientWidth && ref.current.parentElement.clientWidth > 0
        ? ref.current.parentElement.clientWidth
        : Math.max(400, window.innerWidth - 576);
    const h = canvasEl?.clientHeight && canvasEl.clientHeight > 0
      ? canvasEl.clientHeight
      : ref.current?.parentElement?.clientHeight && ref.current.parentElement.clientHeight > 0
        ? ref.current.parentElement.clientHeight
        : Math.max(300, window.innerHeight - 100);
    return { w, h };
  }, []);

  const onZoomOut = () => zoomTo(viewport.zoom - 0.1);
  const onZoomIn = () => zoomTo(viewport.zoom + 0.1);
  const onResetZoom = () => setViewport({ zoom: 1 });
  const onResetView = () => setViewport({ x: 120, y: 80, zoom: 1 });

  // --- Undo / Redo --------------------------------------------------------
  const applySnapshot = (snap: {
    nodes: NodeDTO[];
    edges: EdgeDTO[];
    viewport: { x: number; y: number; zoom: number };
  }) => {
    const s = useAppStore.getState();
    if (s.workflow) {
      const curNodes = s.workflow.nodes;
      const snapIds = new Set(snap.nodes.map((n) => n.id));
      const curIds = new Set(curNodes.map((n) => n.id));
      // Delete nodes that are in current but not in snapshot (undo of a create).
      for (const n of curNodes) {
        if (!snapIds.has(n.id)) {
          void fetch(`/api/workflow/nodes/${n.id}`, { method: "DELETE" }).catch(() => {});
        }
      }
      // Re-create nodes that are in snapshot but not in current (undo of a delete).
      for (const n of snap.nodes) {
        if (!curIds.has(n.id)) {
          void fetch("/api/workflow/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: n.type, name: n.name, x: n.x, y: n.y, refId: n.refId ?? undefined, params: n.params }),
          }).catch(() => {});
        }
      }
      // Sync edges: delete edges in current but not in snapshot, create edges in snapshot but not in current.
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
  };

  const onUndo = () => {
    const snap = useHistoryStore.getState().undo();
    if (!snap) return;
    applySnapshot(snap);
    toast({ title: "Undo" });
  };

  const onRedo = () => {
    const snap = useHistoryStore.getState().redo();
    if (!snap) return;
    applySnapshot(snap);
    toast({ title: "Redo" });
  };

  const onFit = () => {
    if (nodes.length === 0) {
      onResetView();
      return;
    }
    const { w, h } = canvasSize();
    const fit = computeFit(nodes, w, h);
    setViewport(fit);
  };

  const onAutoArrange = async () => {
    if (nodes.length === 0 || arranging) return;
    // Push history before reflowing nodes.
    const s = useAppStore.getState();
    if (s.workflow) {
      useHistoryStore.getState().push({
        nodes: s.workflow.nodes,
        edges: s.workflow.edges,
        viewport: s.viewport,
      });
    }
    setArranging(true);
    try {
      const positions = autoLayout(nodes, edges);
      // Optimistically update local state for every node.
      for (const n of nodes) {
        const pos = positions.get(n.id);
        if (!pos) continue;
        upsertNode({ ...n, x: pos.x, y: pos.y });
      }
      // Fire all PATCHes in parallel (best-effort).
      await Promise.all(
        Array.from(positions.entries()).map(([id, pos]) =>
          fetch(`/api/workflow/nodes/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: pos.x, y: pos.y }),
          }).catch(() => undefined),
        ),
      );
      // Refit to bring everything into view.
      const { w, h } = canvasSize();
      const updated = nodes
        .map((n) => {
          const pos = positions.get(n.id);
          return pos ? { ...n, x: pos.x, y: pos.y } : n;
        });
      const fit = computeFit(updated, w, h);
      setViewport(fit);
      toast({
        title: "Auto-arranged",
        description: `${positions.size} node${positions.size === 1 ? "" : "s"} repositioned.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Auto-arrange failed", description: msg, variant: "destructive" });
    } finally {
      setArranging(false);
    }
  };

  const onRunAll = async () => {
    if (runningAll) return;
    setRunningAll(true);
    try {
      const res = await fetch("/api/workflow/run", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // Refetch the workflow to pull fresh node statuses.
      const wfRes = await fetch("/api/workflow");
      if (wfRes.ok) {
        const wf = await wfRes.json();
        useAppStore.getState().setWorkflow(wf);
      }
      toast({ title: "Workflow run complete", variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Workflow run failed", description: msg, variant: "destructive" });
    } finally {
      setRunningAll(false);
    }
  };

  // Round to nearest integer percent — fits the "85%" example.
  const pct = Math.round(viewport.zoom * 100);

  return (
    <TooltipProvider delayDuration={250}>
      <div
        ref={ref}
        className={cn(
          "absolute bottom-3 left-3 z-20",
          "flex items-center gap-1 rounded-lg border bg-card p-1 shadow-sm",
        )}
      >
        {/* Mobile-only: toggle the node palette overlay. On phones the
            palette no longer eats the canvas — it slides in on demand. */}
        <ToolButton
          label={mobilePaletteOpen ? "Hide node palette" : "Show node palette"}
          variant="ghost"
          size="icon"
          className="size-8 md:hidden"
          onClick={() => setMobilePaletteOpen(!mobilePaletteOpen)}
          aria-expanded={mobilePaletteOpen}
        >
          <PanelLeft className="size-4" />
        </ToolButton>

        {/* Undo */}
        <ToolButton
          label="Undo (Ctrl+Z)"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onUndo}
          disabled={!canUndo}
        >
          <Undo2 className="size-4" />
        </ToolButton>

        {/* Redo */}
        <ToolButton
          label="Redo (Ctrl+Shift+Z)"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onRedo}
          disabled={!canRedo}
        >
          <Redo2 className="size-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6 bg-border/70" />

        {/* Zoom-out */}
        <ToolButton
          label="Zoom out"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onZoomOut}
          disabled={viewport.zoom <= ZOOM_MIN}
        >
          <Minus className="size-4" />
        </ToolButton>

        {/* Zoom percentage — click resets zoom to 100% */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onResetZoom}
              className="h-8 min-w-[3.5rem] rounded-md px-2 text-center text-xs font-medium tabular-nums hover:bg-accent"
            >
              {pct}%
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Reset zoom to 100%</TooltipContent>
        </Tooltip>

        {/* Zoom-in */}
        <ToolButton
          label="Zoom in"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onZoomIn}
          disabled={viewport.zoom >= ZOOM_MAX}
        >
          <Plus className="size-4" />
        </ToolButton>

        {/* Reset view (full viewport) */}
        <ToolButton
          label="Reset view"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onResetView}
        >
          <Crosshair className="size-4" />
        </ToolButton>

        {/* Subtle separator between zoom controls and layout controls */}
        <Separator orientation="vertical" className="mx-1 h-6 bg-border/70" />

        {/* Fit */}
        <ToolButton
          label="Fit to content"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onFit}
          disabled={nodes.length === 0}
        >
          <Maximize className="size-4" />
        </ToolButton>

        {/* Auto-arrange */}
        <ToolButton
          label="Auto-arrange layout"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onAutoArrange}
          disabled={arranging || nodes.length === 0}
        >
          {arranging ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <LayoutGrid className="size-4" />
          )}
        </ToolButton>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Run all */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="sm"
              onClick={onRunAll}
              disabled={runningAll || nodes.length === 0}
              className="h-8 gap-1.5"
            >
              {runningAll ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Run All
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Run whole workflow</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Toggle minimap */}
        <ToolButton
          label="Toggle minimap"
          variant={minimapOpen ? "default" : "ghost"}
          size="icon"
          className="size-8"
          onClick={toggleMinimap}
          aria-pressed={minimapOpen}
        >
          <MapIcon className="size-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Export PNG */}
        <ToolButton
          label="Export PNG"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => void exportCanvasToPNG()}
          disabled={nodes.length === 0}
        >
          <Download className="size-4" />
        </ToolButton>

        {/* Export SVG */}
        <ToolButton
          label="Export SVG"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => exportCanvasToSVG()}
          disabled={nodes.length === 0}
        >
          <FileImage className="size-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          nodes: {nodes.length}
        </span>
      </div>
    </TooltipProvider>
  );
}
