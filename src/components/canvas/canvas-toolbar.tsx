"use client";

import * as React from "react";
import {
  Minus,
  Plus,
  Maximize,
  LayoutGrid,
  Play,
  Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { ZOOM_MIN, ZOOM_MAX, CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { autoLayout } from "@/lib/canvas-utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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
  const pad = 80;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(canvasW / w, canvasH / h)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: Math.round(cx - canvasW / (2 * zoom)),
    y: Math.round(cy - canvasH / (2 * zoom)),
    zoom: Number(zoom.toFixed(2)),
  };
}

/** Floating canvas toolbar: zoom, fit, auto-arrange, run-all. */
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
    const parent = ref.current?.parentElement;
    const w = parent?.clientWidth && parent.clientWidth > 0
      ? parent.clientWidth
      : Math.max(400, window.innerWidth - 576);
    const h = parent?.clientHeight && parent.clientHeight > 0
      ? parent.clientHeight
      : Math.max(300, window.innerHeight - 100);
    return { w, h };
  }, []);

  const onZoomOut = () => zoomTo(viewport.zoom - 0.1);
  const onZoomIn = () => zoomTo(viewport.zoom + 0.1);
  const onReset = () => setViewport({ x: 120, y: 80, zoom: 1 });

  const onFit = () => {
    if (nodes.length === 0) {
      onReset();
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

  const pct = Math.round(viewport.zoom * 100);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute bottom-3 left-3 z-20",
        "flex items-center gap-1 rounded-lg border bg-card p-1 shadow-sm",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onZoomOut}
        disabled={viewport.zoom <= ZOOM_MIN}
        title="Zoom out"
      >
        <Minus className="size-4" />
      </Button>

      <button
        type="button"
        onClick={onReset}
        className="h-8 min-w-[3.5rem] rounded-md px-2 text-center text-xs font-medium tabular-nums hover:bg-accent"
        title="Reset zoom to 100%"
      >
        {pct}%
      </button>

      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onZoomIn}
        disabled={viewport.zoom >= ZOOM_MAX}
        title="Zoom in"
      >
        <Plus className="size-4" />
      </Button>

      <Separator orientation="vertical" className="mx-0.5 h-6" />

      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onFit}
        disabled={nodes.length === 0}
        title="Fit to content"
      >
        <Maximize className="size-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onAutoArrange}
        disabled={arranging || nodes.length === 0}
        title="Auto-arrange layout"
      >
        {arranging ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <LayoutGrid className="size-4" />
        )}
      </Button>

      <Separator orientation="vertical" className="mx-0.5 h-6" />

      <Button
        variant="default"
        size="sm"
        onClick={onRunAll}
        disabled={runningAll || nodes.length === 0}
        className="h-8 gap-1.5"
        title="Run whole workflow"
      >
        {runningAll ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Run All
      </Button>

      <Separator orientation="vertical" className="mx-0.5 h-6" />

      <span className="px-2 text-xs tabular-nums text-muted-foreground">
        nodes: {nodes.length}
      </span>
    </div>
  );
}
