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
  Check,
  X,
  Loader2,
  Play,
  Copy,
  Trash2,
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
import { cn } from "@/lib/utils";
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

  // ─── Drag state (refs, no React state) ──────────────────────────────────
  const dragState = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    raf: number | null;
    latestDx: number;
    latestDy: number;
  } | null>(null);

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore right-click (handled by ContextMenu) and any button but primary.
    if (e.button !== 0) return;
    // Ignore if the target is a port button (ports stop propagation).
    if ((e.target as HTMLElement).closest("[data-port]")) return;
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
    }
    st.latestDx = dx;
    st.latestDy = dy;
    if (st.raf !== null) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = null;
      const zoom = useAppStore.getState().viewport.zoom || 1;
      const tx = (st.latestDx / zoom).toFixed(2);
      const ty = (st.latestDy / zoom).toFixed(2);
      if (cardRef.current) {
        cardRef.current.style.transform = `translate(${tx}px, ${ty}px)`;
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

  // ─── Ports ──────────────────────────────────────────────────────────────
  const attemptConnect = React.useCallback(
    async (from: PendingFrom, toNodeId: string, toPort: string) => {
      const edges = useAppStore.getState().workflow?.edges ?? [];
      const guard = canConnect(edges, from.nodeId, toNodeId);
      if (!guard.ok) {
        toast({ title: "Cannot connect", description: guard.reason, variant: "destructive" });
        setPendingFrom(null);
        return;
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
      addEdgeOptimistic(optimistic);
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
        rollbackEdge(tempId);
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

  // ─── Context menu actions ──────────────────────────────────────────────
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
    removeNode(node.id);
    try {
      const res = await fetch(`/api/workflow/nodes/${node.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      toast({ title: "Node deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  }, [node.id, removeNode, toast]);

  const Icon = spec ? ICON_MAP[spec.icon] ?? Box : Box;
  const status = node.status;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={cardRef}
            className={cn(
              "absolute select-none",
              status === "running" && "job-running",
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
            <div
              className={cn(
                "relative h-full w-full overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow",
                isSelected ? "border-primary ring-2 ring-primary/40" : "border-border",
              )}
            >
              {/* Left color bar */}
              <div className={cn("absolute left-0 top-0 bottom-0 w-1", color.bg)} />

              {/* Top row */}
              <div className="flex items-center gap-2 pl-3 pr-2 pt-2.5">
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                    color.soft,
                    color.text,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 truncate text-sm font-semibold leading-tight">
                  {node.name || spec?.label || node.type}
                </div>
                {status === "completed" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                {status === "failed" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white">
                    <X className="h-3 w-3" />
                  </span>
                )}
                {status === "running" && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-500" />
                )}
              </div>

              {/* Second row: status pill + spec label */}
              <div className="flex items-center gap-1.5 px-3 pt-1">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide",
                    STATUS_PILL[status] ?? STATUS_PILL.idle,
                  )}
                >
                  {status}
                </span>
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
                      className="h-full bg-teal-500 transition-[width] duration-200"
                      style={{ width: `${Math.max(4, Math.min(100, node.progress || 0))}%` }}
                    />
                  </div>
                )}
                {status === "completed" && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {node.result ? node.result.slice(0, 80) : "Done"}
                  </div>
                )}
                {status === "failed" && (
                  <div className="truncate text-[11px] text-rose-500">
                    {node.result ? node.result.slice(0, 80) : "Error"}
                  </div>
                )}
                {(status === "idle" || status === "pending") && (
                  <div className="text-[11px] text-muted-foreground">
                    {status === "pending" ? "Queued" : "Ready"}
                  </div>
                )}
              </div>

              {/* Bottom status strip */}
              <div
                className={cn(
                  "absolute bottom-0 left-0 right-0 h-[3px]",
                  STATUS_STRIP[status] ?? STATUS_STRIP.idle,
                )}
              />
            </div>

            {/* Input ports */}
            {inputs.map((port, i) => {
              const compatible = isInputCompatible(port);
              return (
                <button
                  key={`in-${port.name}`}
                  data-port="in"
                  title={port.label}
                  onPointerDown={onInputPortPointerDown(port)}
                  className={cn(
                    "absolute flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background bg-card shadow-sm transition",
                    "hover:scale-125 hover:z-10",
                    compatible && "animate-pulse ring-2 ring-primary",
                  )}
                  style={{
                    left: -7,
                    top: portY(i, inputs.length) - 7,
                  }}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      PORT_COLORS[(port.kind ?? "*") as PortKind]?.dot ?? "bg-slate-500",
                    )}
                  />
                </button>
              );
            })}

            {/* Output ports */}
            {outputs.map((port, i) => {
              const compatible = isOutputCompatible(port);
              const dotColor = PORT_COLORS[(port.kind ?? "*") as PortKind]?.dot ?? "bg-slate-500";
              return (
                <button
                  key={`out-${port.name}`}
                  data-port="out"
                  title={port.label}
                  onPointerDown={onOutputPortPointerDown(port)}
                  className={cn(
                    "absolute flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background shadow-sm transition",
                    "hover:scale-125 hover:z-10",
                    compatible && "animate-pulse ring-2 ring-primary",
                  )}
                  style={{
                    right: -7,
                    top: portY(i, outputs.length) - 7,
                  }}
                >
                  <span className={cn("h-2 w-2 rounded-full", dotColor)} />
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
