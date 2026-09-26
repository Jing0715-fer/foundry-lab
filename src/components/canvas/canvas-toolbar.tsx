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
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { ZOOM_MIN, ZOOM_MAX, CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { autoLayout } from "@/lib/canvas-utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

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

/** Floating canvas toolbar: zoom, reset view, fit, auto-arrange, run-all. */
export function CanvasToolbar() {
  const viewport = useAppStore((s) => s.viewport);
  const setViewport = useAppStore((s) => s.setViewport);
  const zoomTo = useAppStore((s) => s.zoomTo);
  const workflow = useAppStore((s) => s.workflow);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const toast = useAppStore((s) => s.toast);

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

        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          nodes: {nodes.length}
        </span>
      </div>
    </TooltipProvider>
  );
}
