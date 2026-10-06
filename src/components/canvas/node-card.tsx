"use client";

import React from "react";
import {
  Bot,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Boxes,
  Database,
  ArrowRightToLine,
  Flag,
  Box,
  Check,
  Loader2,
  Play,
  Copy,
  Trash2,
  Grid3X3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EdgeDTO, NodeDTO, PortKind, PortSpec } from "@/lib/types";
import {
  CARD_W,
  CARD_H,
  NODE_COLORS,
  PORT_COLORS,
  nodeSpec,
  portY,
  portsCompatible,
} from "@/lib/workflow-catalog";
import { canConnect, useAppStore, type PendingFrom } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import { withHistorySuppressed } from "@/lib/history-apply";
import { computeAllEdgeGeoms, setLiveDrag } from "@/lib/canvas-utils";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  boxes: Boxes,
  database: Database,
  "arrow-right-to-line": ArrowRightToLine,
  flag: Flag,
};

const STATUS_STRIP: Record<string, string> = {
  idle: "bg-slate-400",
  pending: "bg-amber-400",
  running: "bg-teal-500",
  completed: "bg-emerald-500",
  failed: "bg-rose-500",
};

const STATUS_PILL: Record<string, string> = {
  idle: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  running: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

// --- Edge DOM patching (cryoflow pattern) ----------------------------------
// During a card drag, the SVG edge layer is NOT re-rendered via React (that
// would be far too expensive per frame). Instead, on the first significant
// pointermove we collect references to the per-edge `<g>` SVG groups connected
// to this node, and each rAF frame we patch their attributes directly via
// setAttribute. No React state writes, no zustand writes — just direct DOM
// mutations on cached elements.

/**
 * Collect the per-edge `<g data-edge-id="…">` groups connected to `nodeId`.
 * Returns null if the SVG layer isn't found or the node has no edges.
 */
function collectEdgeGroups(nodeId: string): Map<string, SVGGElement> | null {
  const svg = document.querySelector("svg[data-edges-layer]");
  if (!svg) return null;
  const state = useAppStore.getState();
  const workflow = state.workflow;
  if (!workflow) return null;
  let any = false;
  const map = new Map<string, SVGGElement>();
  for (const e of workflow.edges) {
    if (e.fromNodeId !== nodeId && e.toNodeId !== nodeId) continue;
    const g = svg.querySelector(`g[data-edge-id="${e.id}"]`);
    if (g) {
      map.set(e.id, g as SVGGElement);
      any = true;
    }
  }
  return any ? map : null;
}

/**
 * Patch the cached edge `<g>` groups in place for the live drag offset
 * `(dx, dy)` (world coordinates). Computes the new geometry for ALL edges
 * (cheap) and updates only the ones connected to `nodeId`.
 */
function patchEdgeGroups(
  groups: Map<string, SVGGElement>,
  nodeId: string,
  dx: number,
  dy: number,
): void {
  const state = useAppStore.getState();
  const workflow = state.workflow;
  if (!workflow) return;
  const geoms = computeAllEdgeGeoms(workflow.edges, workflow.nodes, {
    id: nodeId,
    dx,
    dy,
  });
  for (const g of geoms) {
    const edge = workflow.edges.find((e) => e.id === g.id);
    if (!edge) continue;
    if (edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId) continue;
    const el = groups.get(g.id);
    if (!el) continue;
    // Patch all edge-geometry paths (hit area + visible stroke).
    const paths = el.querySelectorAll('[data-e="d"]');
    paths.forEach((p) => {
      (p as SVGPathElement).setAttribute("d", g.d);
    });
    // Patch every animateMotion (running-edge traveling dots).
    const motions = el.querySelectorAll('[data-e="motion"]');
    motions.forEach((m) => {
      (m as SVGElement).setAttribute("path", g.d);
    });
    // Patch source dot.
    const src = el.querySelector('[data-e="src"]');
    if (src) {
      src.setAttribute("cx", String(g.src.x));
      src.setAttribute("cy", String(g.src.y));
    }
    // Patch target dot(s).
    const tgts = el.querySelectorAll('[data-e="tgt"]');
    tgts.forEach((t) => {
      t.setAttribute("cx", String(g.tgt.x));
      t.setAttribute("cy", String(g.tgt.y));
    });
    // Patch running-gradient endpoints (only present on running edges).
    const grad = el.querySelector('[data-e="grad"]');
    if (grad) {
      grad.setAttribute("x1", String(g.src.x));
      grad.setAttribute("y1", String(g.src.y));
      grad.setAttribute("x2", String(g.tgt.x));
      grad.setAttribute("y2", String(g.tgt.y));
    }
  }
}

interface NodeCardProps {
  node: NodeDTO;
}

function NodeCardImpl({ node }: NodeCardProps) {
  const spec = nodeSpec(node.type);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // Store hooks — selectors return primitives so cards only re-render on real changes.
  const isSelected = useAppStore((s) => s.selectedIds.includes(node.id));
  const pendingFrom = useAppStore((s) => s.pendingFrom);

  // Actions (stable references)
  const select = useAppStore((s) => s.select);
  const inspect = useAppStore((s) => s.inspect);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const removeNode = useAppStore((s) => s.removeNode);
  const setNodeStatus = useAppStore((s) => s.setNodeStatus);
  const mergeNodes = useAppStore((s) => s.mergeNodes);
  const setPendingFrom = useAppStore((s) => s.setPendingFrom);
  const setDragActive = useAppStore((s) => s.setDragActive);
  const addEdgeOptimistic = useAppStore((s) => s.addEdgeOptimistic);
  const confirmEdge = useAppStore((s) => s.confirmEdge);
  const rollbackEdge = useAppStore((s) => s.rollbackEdge);
  const toast = useAppStore((s) => s.toast);

  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const colorKey = (spec?.color ?? "slate") as keyof typeof NODE_COLORS;
  const color = NODE_COLORS[colorKey] ?? NODE_COLORS.slate;
  const inputs: PortSpec[] = spec?.inputs ?? [];
  const outputs: PortSpec[] = spec?.outputs ?? [];

  // --- Drag state (refs, no React state) ----------------------------------
  const dragState = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    raf: number | null;
    latestDx: number;
    latestDy: number;
  } | null>(null);

  // Cached references to the per-edge `<g>` SVG groups connected to this node.
  // Populated on the first significant pointermove; cleared on pointerup.
  // Null when no drag is in progress OR when the node has no edges.
  const edgeDomRef = React.useRef<Map<string, SVGGElement> | null>(null);

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore right-click (handled by ContextMenu) and any button but primary.
    if (e.button !== 0) return;
    // Ignore if the target is a port button (ports stop propagation).
    if ((e.target as HTMLElement).closest("[data-port]")) return;
    // Ignore interactive descendants (the sweep-collapse badge, port labels,
    // future buttons): setPointerCapture here would hijack their click —
    // pointer events (and the derived click) would retarget to the card and
    // the button's onClick would never fire.
    if (
      (e.target as HTMLElement).closest(
        "button, a, input, textarea, select, [contenteditable='true'], [role='button']",
      )
    ) {
      return;
    }
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      raf: null,
      latestDx: 0,
      latestDy: 0,
    };
  };

  const onCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      st.moved = true;
      setDragActive(true);
      // First significant move: cache the connected edge `<g>` SVG groups so
      // subsequent frames can patch their attributes directly without
      // querySelectorAll-ing the document every frame.
      edgeDomRef.current = collectEdgeGroups(node.id);
    }
    st.latestDx = dx;
    st.latestDy = dy;
    if (st.raf !== null) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = null;
      const zoom = useAppStore.getState().viewport.zoom || 1;
      // cdx/cdy are WORLD-space deltas (the SVG edge layer + the card's
      // parent are both inside the scaled workspace container, so we divide
      // screen px by zoom to get world units).
      const cdx = st.latestDx / zoom;
      const cdy = st.latestDy / zoom;
      if (cardRef.current) {
        cardRef.current.style.transform = `translate(${cdx.toFixed(2)}px, ${cdy.toFixed(2)}px)`;
      }
      // Live-patch edge geometry directly on the cached SVG groups.
      // This is the cryoflow pattern: NO React state writes per frame.
      if (edgeDomRef.current) {
        patchEdgeGroups(edgeDomRef.current, node.id, cdx, cdy);
        // Defensive read for any other consumer (polling layers, etc.).
        setLiveDrag({ id: node.id, dx: cdx, dy: cdy });
      }
    });
  };

  const onCardPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    if (cardRef.current) cardRef.current.style.transform = "";
    // Clear the live-drag state — the upcoming store commit will trigger a
    // React re-render that recomputes edges to their final positions.
    setLiveDrag(null);
    edgeDomRef.current = null;
    if (!st.moved) {
      // click — select
      select(node.id);
    } else {
      const zoom = useAppStore.getState().viewport.zoom || 1;
      const nx = Math.round(node.x + st.latestDx / zoom);
      const ny = Math.round(node.y + st.latestDy / zoom);
      const updated: NodeDTO = { ...node, x: nx, y: ny };
      upsertNode(updated);
      setDragActive(false);
      // Persist
      void (async () => {
        try {
          const res = await fetch(`/api/workflow/nodes/${node.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: nx, y: ny }),
          });
          if (!res.ok) throw new Error("patch failed");
        } catch {
          toast({ title: "Failed to save position", variant: "destructive" });
          // Rollback to original position.
          upsertNode({ ...node });
        }
      })();
    }
    dragState.current = null;
  };

  // --- Ports --------------------------------------------------------------
  const attemptConnect = React.useCallback(
    async (from: PendingFrom, toNodeId: string, toPort: string) => {
      const edges = useAppStore.getState().workflow?.edges ?? [];
      const guard = canConnect(edges, from.nodeId, toNodeId);
      if (!guard.ok) {
        toast({ title: "Cannot connect", description: guard.reason, variant: "destructive" });
        setPendingFrom(null);
        return;
      }
      // Push history before creating the edge.
      const s = useAppStore.getState();
      if (s.workflow) {
        useHistoryStore.getState().push({
          nodes: s.workflow.nodes,
          edges: s.workflow.edges,
          viewport: s.viewport,
        });
      }
      const tempId = `tmp_${Math.random().toString(36).slice(2, 10)}`;
      const optimistic: EdgeDTO = {
        id: tempId,
        workflowId: node.workflowId,
        fromNodeId: from.nodeId,
        toNodeId,
        fromPort: from.port,
        toPort,
        createdAt: new Date().toISOString(),
      };
      // The store write is capture-suppressed: the inline push above is the
      // single history entry for this operation (without the guard, the
      // canvas subscription would capture the same pre-connect state again
      // and undo would need two presses to leave the spot).
      withHistorySuppressed(() => addEdgeOptimistic(optimistic));
      try {
        const res = await fetch("/api/workflow/edges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromNodeId: from.nodeId,
            toNodeId,
            fromPort: from.port,
            toPort,
            id: tempId,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || "edge create failed");
        }
        const real: EdgeDTO = await res.json();
        confirmEdge(tempId, real);
      } catch (err) {
        // Rollback is suppressed too: capturing the broken mid-state (with
        // the doomed temp edge) as history would let Ctrl+Z re-create an
        // edge the server just refused.
        withHistorySuppressed(() => rollbackEdge(tempId));
        toast({
          title: "Connection failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    },
    [
      addEdgeOptimistic,
      confirmEdge,
      node.workflowId,
      rollbackEdge,
      setPendingFrom,
      toast,
    ],
  );

  const onInputPortPointerDown = (port: PortSpec) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pendingFrom && pendingFrom.dir === "out") {
      void attemptConnect(pendingFrom, node.id, port.name);
    } else {
      setPendingFrom({ nodeId: node.id, port: port.name, dir: "in" });
    }
  };

  const onOutputPortPointerDown = (port: PortSpec) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPendingFrom({ nodeId: node.id, port: port.name, dir: "out" });
  };

  // Highlight compatible ports.
  const isInputCompatible = (port: PortSpec): boolean => {
    if (!pendingFrom || pendingFrom.dir !== "out") return false;
    const fromSpec = nodeSpec(
      useAppStore.getState().workflow?.nodes.find((n) => n.id === pendingFrom.nodeId)?.type ?? "",
    );
    const fromPort = fromSpec?.outputs.find((p) => p.name === pendingFrom.port);
    return portsCompatible(fromPort?.kind, port.accepts);
  };
  const isOutputCompatible = (port: PortSpec): boolean => {
    if (!pendingFrom || pendingFrom.dir !== "in") return false;
    const toSpec = nodeSpec(
      useAppStore.getState().workflow?.nodes.find((n) => n.id === pendingFrom.nodeId)?.type ?? "",
    );
    const toPort = toSpec?.inputs.find((p) => p.name === pendingFrom.port);
    return portsCompatible(port.kind, toPort?.accepts);
  };

  // --- Context menu actions ----------------------------------------------
  const handleRun = React.useCallback(async () => {
    setNodeStatus(node.id, "running", 0);
    try {
      const res = await fetch(`/api/workflow/nodes/${node.id}/run`, { method: "POST" });
      if (!res.ok) throw new Error("run failed");
      const updated: NodeDTO = await res.json();
      mergeNodes([updated]);
      toast({ title: "Node finished", description: updated.status === "completed" ? "OK" : updated.status });
    } catch (err) {
      setNodeStatus(node.id, "failed", undefined, err instanceof Error ? err.message : String(err));
      toast({ title: "Run failed", variant: "destructive" });
    }
  }, [mergeNodes, node.id, setNodeStatus, toast]);

  const handleDuplicate = React.useCallback(async () => {
    try {
      const res = await fetch("/api/workflow/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Target the node's own workflow (multi-workflow contract).
          workflowId: node.workflowId,
          type: node.type,
          name: `${node.name} copy`,
          x: node.x + 40,
          y: node.y + 40,
          refId: node.refId ?? undefined,
          params: node.params,
        }),
      });
      if (!res.ok) throw new Error("duplicate failed");
      const created: NodeDTO = await res.json();
      upsertNode(created);
      toast({ title: "Duplicated" });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    }
  }, [node, upsertNode, toast]);

  const handleDelete = React.useCallback(async () => {
    // Push history + remove optimistically — and RESTORE the node if the
    // server DELETE actually fails (an HTTP failure used to leave the node
    // deleted locally while it still existed server-side, with only a toast
    // to explain the lie).
    const s = useAppStore.getState();
    const before = s.workflow;
    if (before) {
      useHistoryStore.getState().push({
        nodes: before.nodes,
        edges: before.edges,
        viewport: s.viewport,
      });
    }
    // Suppressed: the inline push above is the single capture for this op.
    withHistorySuppressed(() => removeNode(node.id));
    try {
      const res = await fetch(`/api/workflow/nodes/${node.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Node deleted" });
    } catch {
      // Rollback: put the node (and its edges) back exactly as they were.
      const cur = useAppStore.getState().workflow;
      if (cur && before) {
        const nodeRow = before.nodes.find((n) => n.id === node.id);
        const lostEdges = before.edges.filter(
          (e) =>
            (e.fromNodeId === node.id || e.toNodeId === node.id) &&
            !cur.edges.some((x) => x.id === e.id),
        );
        if (nodeRow) {
          withHistorySuppressed(() => {
            useAppStore.getState().setWorkflow({
              ...cur,
              nodes: [...cur.nodes, nodeRow],
              edges: [...cur.edges, ...lostEdges],
            });
          });
        }
      }
      toast({
        title: "Delete failed",
        description: "The node is still on the server — restored locally.",
        variant: "destructive",
      });
    }
  }, [node.id, removeNode, toast]);

  const Icon = spec ? ICON_MAP[spec.icon] ?? Box : Box;
  const status = node.status;

  // Native browser tooltip — works correctly with absolutely-positioned elements
  // (a Radix HoverCard would clip or mis-position when the node is dragged
  // outside the visible canvas area). Multi-line via "\n".
  const tooltipText = [
    node.name || spec?.label || node.type,
    `${spec?.label ?? node.type} · ${status}`,
    node.result ? node.result.slice(0, 100) : "",
    "Click to select · Double-click to inspect",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={cardRef}
            title={tooltipText}
            className={cn(
              "absolute select-none",
              status === "running" && "job-running",
              status === "running" && "node-pulse-running",
            )}
            style={{
              left: node.x,
              top: node.y,
              width: CARD_W,
              height: CARD_H,
              cursor: "grab",
              touchAction: "none",
            }}
            onPointerDown={onCardPointerDown}
            onPointerMove={onCardPointerMove}
            onPointerUp={onCardPointerUp}
            onPointerCancel={onCardPointerUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              inspect(node.id);
            }}
          >
            {/* Card body */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "card-hover card-lift-glow node-shadow node-glow-hover relative h-full w-full overflow-hidden rounded-xl border bg-card shadow-sm transition-all duration-200 hover:shadow-md hover:ring-2 hover:ring-primary/20",
                isSelected ? "border-primary ring-2 ring-primary/40" : "border-border",
                // Running pulse: border color pulses in addition to job-running glow.
                status === "running" &&
                  "border-teal-500/60 animate-pulse",
                // Subtle green glow for completed nodes.
                status === "completed" && "ring-1 ring-emerald-500/30",
                // Subtle red glow for failed nodes.
                status === "failed" && "ring-1 ring-rose-500/30",
              )}
            >
              {/* Left color bar */}
              <div className={cn("absolute left-0 top-0 bottom-0 w-1", color.bg)} />

              {/* Status badge (top-right corner) */}
              {status === "completed" && (
                <span
                  className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
                  title="Completed"
                >
                  <Check className="size-3.5" />
                </span>
              )}
              {status === "failed" && (
                <span
                  className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-rose-500 text-white font-bold shadow-sm"
                  title="Failed"
                >
                  !
                </span>
              )}
              {status === "running" && (
                <Loader2 className="absolute right-2 top-2 size-3.5 animate-spin text-teal-500" />
              )}

              {/* Top row */}
              <div className="flex min-w-0 items-center gap-2 pl-3 pr-7 pt-2.5">
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                    color.soft,
                    color.text,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div
                  className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight"
                  title={node.name || spec?.label || node.type}
                >
                  {node.name || spec?.label || node.type}
                </div>
              </div>

              {/* Second row: status pill + spec label */}
              <div className="flex min-w-0 items-center gap-1.5 px-3 pt-1">
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    STATUS_PILL[status] ?? STATUS_PILL.idle,
                  )}
                >
                  {status}
                </span>
                {node.sweepGroup && (
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-medium text-primary transition-colors hover:bg-primary/20"
                    title="Parameter-sweep variant — click to collapse the whole group into one aggregate card"
                    data-sweep-variant-badge
                    onClick={(e) => {
                      // B3: collapse entry on the expanded variant card.
                      e.stopPropagation();
                      if (node.sweepGroup) {
                        useAppStore.getState().toggleSweepCollapse(node.sweepGroup);
                      }
                    }}
                  >
                    <Grid3X3 className="size-2.5" />
                    sweep
                  </button>
                )}
                {spec && (
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {spec.label}
                  </span>
                )}
              </div>

              {/* Third row: progress / result / ready */}
              <div className="px-3 pt-1.5">
                {status === "running" && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-teal-500 shimmer transition-[width] duration-200"
                      style={{ width: `${Math.max(4, Math.min(100, node.progress || 0))}%` }}
                    />
                  </div>
                )}
                {status === "completed" && (
                  <div
                    className="max-w-full truncate text-[11px] text-muted-foreground"
                    title={node.result || undefined}
                  >
                    {node.result ? node.result.slice(0, 80) : "Done"}
                  </div>
                )}
                {status === "failed" && (
                  <div
                    className="max-w-full truncate text-[11px] text-rose-500"
                    title={node.result || undefined}
                  >
                    {node.result ? node.result.slice(0, 80) : "Error"}
                  </div>
                )}
                {(status === "idle" || status === "pending") && (
                  <div className="text-[11px] text-muted-foreground">
                    {status === "pending" ? "Queued" : "Ready"}
                  </div>
                )}
              </div>

              {/* Bottom status strip (4px for better visibility) */}
              <div
                className={cn(
                  "absolute bottom-0 left-0 right-0 h-1",
                  STATUS_STRIP[status] ?? STATUS_STRIP.idle,
                )}
              />
            </motion.div>

            {/* Input ports — 28px transparent hit pads centered on the port
                point (the visible dot stays 14px). The old 14px button was a
                title-only mouse target; the pad quadruples the clickable area
                and carries an aria-label for screen readers. The pads stay
                smaller than the minimum vertical port spacing (29px for 3
                ports on a 116px card) so adjacent ports can't shadow each
                other. */}
            {inputs.map((port, i) => {
              const compatible = isInputCompatible(port);
              return (
                <button
                  key={`in-${port.name}`}
                  data-port="in"
                  title={port.label}
                  aria-label={`Connect ${port.label} input`}
                  onPointerDown={onInputPortPointerDown(port)}
                  className="absolute flex h-7 w-7 items-center justify-center hover:z-10"
                  style={{
                    left: -14,
                    top: portY(i, inputs.length) - 14,
                  }}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background bg-card shadow-sm transition hover:scale-125",
                      compatible && "animate-pulse ring-2 ring-primary",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        PORT_COLORS[(port.kind ?? "*") as PortKind]?.dot ?? "bg-slate-500",
                      )}
                    />
                  </span>
                </button>
              );
            })}

            {/* Output ports — same 28px hit-pad treatment as the inputs. */}
            {outputs.map((port, i) => {
              const compatible = isOutputCompatible(port);
              const dotColor = PORT_COLORS[(port.kind ?? "*") as PortKind]?.dot ?? "bg-slate-500";
              return (
                <button
                  key={`out-${port.name}`}
                  data-port="out"
                  title={port.label}
                  aria-label={`Connect ${port.label} output`}
                  onPointerDown={onOutputPortPointerDown(port)}
                  className="absolute flex h-7 w-7 items-center justify-center hover:z-10"
                  style={{
                    right: -14,
                    top: portY(i, outputs.length) - 14,
                  }}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background shadow-sm transition hover:scale-125",
                      compatible && "animate-pulse ring-2 ring-primary",
                    )}
                  >
                    <span className={cn("h-2 w-2 rounded-full", dotColor)} />
                  </span>
                </button>
              );
            })}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem onClick={() => void handleRun()}>
            <Play className="mr-2 h-4 w-4" /> Run
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handleDuplicate()}>
            <Copy className="mr-2 h-4 w-4" /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-2 h-4 w-4" /> Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete node?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove &ldquo;{node.name || node.type}&rdquo; and all of its connections.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDelete(false);
                void handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Custom comparator — only re-render on parent updates when node fields change.
function nodeEqual(a: NodeDTO, b: NodeDTO): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.x === b.x &&
    a.y === b.y &&
    a.name === b.name &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.result === b.result &&
    a.logs === b.logs &&
    a.refId === b.refId &&
    a.type === b.type &&
    a.params === b.params
  );
}

export const NodeCard = React.memo(NodeCardImpl, (prev, next) =>
  nodeEqual(prev.node, next.node),
);
