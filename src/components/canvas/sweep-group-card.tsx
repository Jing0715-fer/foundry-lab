"use client";

// Sweep aggregate group card (B3, node-group extension).
//
// A collapsed sweep group renders ONE card instead of N variant cards:
//   - header: sweep badge + source name + "N variants" count
//   - body: live progress (completed/total) with a mini progress bar and a
//     status pill (running / failed / done / idle)
//   - actions: Compare (opens the sweep-compare dialog for the group) and
//     Expand (chevron) — clicking the card body also expands.
//
// The card occupies the top-left of the member bounding box; while the group
// is collapsed, the canvas maps every member's position to THIS card's
// position for edge rendering, so wires visually attach to the aggregate.
//
// E3: the card is DRAGGABLE — dragging moves the whole group. During the
// drag only this card's transform follows the pointer (world-space delta =
// screen px / zoom); on release every member is moved by the same delta in
// the store (one history snapshot first) and persisted with one PATCH per
// member. A click without movement still toggles expand.
//
// Pure UI state: collapsing never touches the DB — members stay in the
// workflow and the undo/redo chain is unaffected.

import * as React from "react";
import {
  ChevronsUpDown,
  FlaskConical,
  GripVertical,
  Table2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { CARD_W } from "@/lib/workflow-catalog";
import { useAppStore } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import type { NodeDTO } from "@/lib/types";
import { SweepCompareDialog } from "@/components/canvas/sweep-compare-dialog";
import { Button } from "@/components/ui/button";

export interface SweepGroupCardData {
  groupId: string;
  members: NodeDTO[];
  /** Top-left of the member bounding box (where the card renders). */
  x: number;
  y: number;
}

/** Derive sweep groups (≥2 members) from the live node list. */
export function deriveSweepGroups(
  nodes: NodeDTO[],
): Map<string, SweepGroupCardData> {
  const byGroup = new Map<string, NodeDTO[]>();
  for (const n of nodes) {
    if (!n.sweepGroup) continue;
    const list = byGroup.get(n.sweepGroup);
    if (list) list.push(n);
    else byGroup.set(n.sweepGroup, [n]);
  }
  const out = new Map<string, SweepGroupCardData>();
  for (const [groupId, members] of byGroup) {
    if (members.length < 2) continue; // a lone variant isn't worth a card
    const x = Math.min(...members.map((m) => m.x));
    const y = Math.min(...members.map((m) => m.y));
    out.set(groupId, { groupId, members, x, y });
  }
  return out;
}

export function SweepGroupCard({ group }: { group: SweepGroupCardData }) {
  const toggleSweepCollapse = useAppStore((s) => s.toggleSweepCollapse);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const toast = useAppStore((s) => s.toast);
  const [compareOpen, setCompareOpen] = React.useState(false);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const dragState = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    latestDx: number;
    latestDy: number;
  } | null>(null);

  const { members, x, y } = group;
  const total = members.length;
  const completed = members.filter((m) => m.status === "completed").length;
  const running = members.some((m) => m.status === "running");
  const failed = members.filter((m) => m.status === "failed").length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Group label: variants are named "<source> · k=v, …" — the shared prefix
  // before the " · " separator is the source node's name.
  const sourceName =
    members[0]?.name.split(" · ")[0]?.replace(/…$/, "") ?? "Sweep";

  // Any completed member unlocks Compare (the API resolves the whole group
  // from one member id; it needs at least one finished variant to be useful).
  const compareNode = members.find((m) => m.status === "completed") ?? null;

  const statusPill = running
    ? { label: "running", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" }
    : failed > 0
      ? { label: `${failed} failed`, cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" }
      : completed === total
        ? { label: "done", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" }
        : { label: "idle", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-400" };

  // ── E3: group drag (moves every member by the same delta) ─────────────
  // Same contract as node-card: pointer capture on the card body, rAF-
  // throttled transform during the drag, one history snapshot + N upserts +
  // N PATCHes on release. Interactive descendants (Compare/Expand buttons)
  // are excluded at pointerdown so their clicks still fire.
  const onGroupPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Exclude real interactive descendants. NOTE: the card root itself is
    // [role=button] — closest("[role=button]") would match the root and kill
    // all dragging, so only HTML interactive elements are excluded here.
    if (
      (e.target as HTMLElement).closest(
        "button, a, input, textarea, select, [contenteditable='true']",
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
      latestDx: 0,
      latestDy: 0,
    };
  };

  const onGroupPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      st.moved = true;
    }
    st.latestDx = dx;
    st.latestDy = dy;
    const zoom = useAppStore.getState().viewport.zoom || 1;
    // World-space delta (the card lives inside the scaled workspace).
    const wdx = dx / zoom;
    const wdy = dy / zoom;
    if (cardRef.current) {
      cardRef.current.style.transform = `translate(${wdx.toFixed(2)}px, ${wdy.toFixed(2)}px)`;
    }
  };

  const onGroupPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (cardRef.current) cardRef.current.style.transform = "";
    dragState.current = null;
    if (!st.moved) {
      // Click without movement — expand (same as the keyboard activation).
      toggleSweepCollapse(group.groupId);
      return;
    }

    const zoom = useAppStore.getState().viewport.zoom || 1;
    const wdx = Math.round(st.latestDx / zoom);
    const wdy = Math.round(st.latestDy / zoom);
    if (wdx === 0 && wdy === 0) return;

    // One snapshot BEFORE the move so a single Ctrl+Z restores the whole
    // group (history-apply PATCHes the drifted positions back).
    const s = useAppStore.getState();
    if (s.workflow) {
      useHistoryStore.getState().push({
        nodes: s.workflow.nodes,
        edges: s.workflow.edges,
        viewport: s.viewport,
      });
    }

    const before = members.map((m) => ({ ...m }));
    for (const m of members) {
      upsertNode({ ...m, x: m.x + wdx, y: m.y + wdy });
    }
    // Persist each member (best-effort; rollback to the pre-drag layout on
    // total failure so the canvas doesn't drift from the DB).
    void (async () => {
      const failed: NodeDTO[] = [];
      await Promise.all(
        before.map(async (m) => {
          try {
            const res = await fetch(`/api/workflow/nodes/${m.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ x: m.x + wdx, y: m.y + wdy }),
            });
            if (!res.ok) failed.push(m);
          } catch {
            failed.push(m);
          }
        }),
      );
      if (failed.length > 0) {
        toast({
          title: "Couldn't save some group positions",
          description: `${failed.length}/${before.length} nodes kept their pre-drag positions.`,
          variant: "destructive",
        });
        for (const m of failed) upsertNode(m);
      }
    })();
  };

  return (
    <>
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-label={`Sweep group "${sourceName}" — ${total} variants, ${completed} completed. Drag to move the group; activate to expand.`}
        data-node-card
        className={cn(
          "group-card absolute w-[248px] cursor-grab rounded-xl border bg-card text-card-foreground shadow-md transition-shadow",
          "hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:cursor-grabbing",
          running && "node-pulse-running",
        )}
        style={{ left: x, top: y, width: CARD_W }}
        onPointerDown={onGroupPointerDown}
        onPointerMove={onGroupPointerMove}
        onPointerUp={onGroupPointerUp}
        onPointerCancel={onGroupPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleSweepCollapse(group.groupId);
          }
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <FlaskConical className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 truncate text-sm font-medium leading-tight">
              <GripVertical className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              <span className="truncate">{sourceName}</span>
            </div>
            <div className="text-[10px] leading-tight text-muted-foreground">
              Parameter sweep · {total} variants
            </div>
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              statusPill.cls,
            )}
          >
            {statusPill.label}
          </span>
        </div>

        {/* Progress */}
        <div className="px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {completed}/{total} completed
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Sweep progress"
          >
            <div
              className={cn(
                "h-full rounded-full transition-all",
                failed > 0 && completed < total
                  ? "bg-gradient-to-r from-amber-500 to-rose-500"
                  : "bg-gradient-to-r from-teal-500 to-emerald-500",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={!compareNode}
            title={
              compareNode
                ? "Compare all variants of this sweep"
                : "Available once at least one variant completes"
            }
            onClick={(e) => {
              e.stopPropagation();
              if (!compareNode) {
                toast({
                  title: "Nothing to compare yet",
                  description: "Run the sweep first — Compare needs completed variants.",
                });
                return;
              }
              setCompareOpen(true);
            }}
          >
            <Table2 className="size-3.5" />
            Compare
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2.5 text-xs text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggleSweepCollapse(group.groupId);
            }}
          >
            <ChevronsUpDown className="size-3.5" />
            Expand
          </Button>
        </div>
      </div>

      {/* Compare dialog anchored to any completed member of the group. */}
      {compareNode && (
        <SweepCompareDialog
          node={compareNode}
          open={compareOpen}
          onOpenChange={setCompareOpen}
        />
      )}
    </>
  );
}
