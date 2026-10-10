"use client";

// Sweep aggregate group card (B3, node-group extension + E3 draggable).
//
// A collapsed sweep group renders ONE card instead of N variant cards:
//   - header: sweep badge + source name + "N variants" count
//   - body: live progress (completed/total) with a mini progress bar and a
//     status pill (running / failed / done / idle)
//   - actions: Compare (opens the sweep-compare dialog for the group) and
//     Expand (chevron)
//
// E3 group drag: pointer-down on the card body (outside its buttons) starts a
// drag that visually translates the aggregate; on release every MEMBER node
// is committed to its shifted position (store merge + per-node PATCH). A
// click without movement still expands the group. Edges follow the drag
// LIVE via the shared edge-drag-patch module (F-lane liveDrag group
// extension): every edge attached to any member is re-geometried each rAF
// frame with the whole-group offset, so connections visually track the
// aggregate instead of snapping on release.
//
// A11y: the root is a labeled GROUP region (not a fake button with focusable
// descendants — nested interactive elements are illegal HTML in a button);
// keyboard users reach Expand/Compare through the real buttons.
//
// Pure UI state: collapsing never touches the DB — members stay in the
// workflow and the undo/redo chain is unaffected. Position moves, like
// single-card drags, are not captured as history entries.

import * as React from "react";
import {
  ChevronsUpDown,
  FlaskConical,
  Table2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { clamp, setLiveDrag } from "@/lib/canvas-utils";
import {
  collectEdgeGroups,
  patchEdgeGroups,
} from "@/components/canvas/edge-drag-patch";
import { CARD_W, CARD_H, WORLD_MIN, WORLD_MAX } from "@/lib/workflow-catalog";
import { useAppStore } from "@/lib/store";
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
  const setDragActive = useAppStore((s) => s.setDragActive);
  const mergeNodes = useAppStore((s) => s.mergeNodes);
  const toast = useAppStore((s) => s.toast);
  const [compareOpen, setCompareOpen] = React.useState(false);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const edgeDomRef = React.useRef<Map<string, SVGGElement> | null>(null);
  const dragState = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    raf: number | null;
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

  // ── E3 drag handlers ─────────────────────────────────────────────────────
  // Same contract as NodeCard: left-button only, interactive descendants
  // (Compare/Expand buttons) are excluded so their clicks survive
  // setPointerCapture, ≥4px movement distinguishes drag from click.
  const onGroupPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Same exclusion list as node-card (buttons, links, inputs, contenteditable,
    // [role=button] descendants): setPointerCapture would otherwise hijack
    // their clicks. The card root itself is role="group" — it must NOT match
    // this selector, or the whole drag would be dead (checked: closest() from
    // a body target never climbs into role="group").
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

  const onGroupPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      st.moved = true;
      setDragActive(true);
      // First significant move: cache the edge `<g>` groups attached to ANY
      // member (F-lane liveDrag group extension) — live-follow during drag.
      edgeDomRef.current = collectEdgeGroups(members.map((m) => m.id));
    }
    st.latestDx = dx;
    st.latestDy = dy;
    // rAF throttle (node-card pattern): pointermove can fire faster than a
    // frame; only one style write per frame.
    if (st.raf !== null) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = null;
      const zoom = useAppStore.getState().viewport.zoom || 1;
      const cdx = st.latestDx / zoom;
      const cdy = st.latestDy / zoom;
      // Visual-only translation in WORLD units (the card lives inside the
      // scaled workspace, so screen px / zoom = world units).
      if (cardRef.current) {
        cardRef.current.style.transform = `translate(${cdx.toFixed(2)}px, ${cdy.toFixed(2)}px)`;
      }
      // P1-2 fix (QA 38-a): setLiveDrag is the SOLE writer of the shared
      // drag state — the ghost-frame follow (H3b) must not depend on "this
      // aggregate has edges to patch". An edgeless aggregate previously
      // skipped setLiveDrag entirely, leaving its ghosts standing still
      // while the card slid away (the exact bug H3b set out to fix).
      setLiveDrag({
        ids: members.map((m) => m.id),
        dx: cdx,
        dy: cdy,
      });
      // LIVE edge follow (F-lane): patch every connected edge's geometry for
      // the whole-group offset.
      if (edgeDomRef.current) {
        // P1-1 fix: geometry must run in RENDER space. Collapsed members
        // render at the AGGREGATE's top-left (workflow-canvas layoutNodes) —
        // patching against raw store positions made every connected edge
        // jump to the invisible scattered members on the first frame.
        const memberIds = new Set(members.map((m) => m.id));
        const renderNodes = (useAppStore.getState().workflow?.nodes ?? []).map(
          (n) => (memberIds.has(n.id) ? { ...n, x: group.x, y: group.y } : n),
        );
        patchEdgeGroups(
          edgeDomRef.current,
          members.map((m) => m.id),
          cdx,
          cdy,
          renderNodes,
        );
      }
    });
  };

  const onGroupPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    if (cardRef.current) cardRef.current.style.transform = "";
    // Clear live edge-follow state — the upcoming mergeNodes commit triggers
    // a React re-render that recomputes edges at their final positions.
    setLiveDrag(null);
    edgeDomRef.current = null;
    if (!st.moved) {
      // Click on the card body → expand (same affordance as before E3).
      toggleSweepCollapse(group.groupId);
    } else {
      const zoom = useAppStore.getState().viewport.zoom || 1;
      const wdx = st.latestDx / zoom;
      const wdy = st.latestDy / zoom;
      setDragActive(false);
      // Commit against the FRESHEST member rows (QA 23-a P2-③ fix): the
      // render-time `members` snapshot can be minutes stale — a run may have
      // flipped statuses meanwhile, and merging a stale full-DTO would clobber
      // those server writes back into the local store.
      const liveNodes = useAppStore.getState().workflow?.nodes ?? [];
      const liveMembers = members
        .map((m) => liveNodes.find((n) => n.id === m.id) ?? m)
        .map((m) => ({ ...m, x: Math.round(m.x), y: Math.round(m.y) }));
      // Clamp the WHOLE member bounding box into world bounds so no member
      // lands outside the canvas (the aggregate can't be split apart).
      const minX = Math.min(...liveMembers.map((m) => m.x));
      const maxX = Math.max(...liveMembers.map((m) => m.x)) + CARD_W;
      const minY = Math.min(...liveMembers.map((m) => m.y));
      const maxY = Math.max(...liveMembers.map((m) => m.y)) + CARD_H;
      const cdx = Math.round(clamp(wdx, WORLD_MIN - minX, WORLD_MAX - maxX));
      const cdy = Math.round(clamp(wdy, WORLD_MIN - minY, WORLD_MAX - maxY));
      if (cdx !== 0 || cdy !== 0) {
        const moved = liveMembers.map((m) => ({
          ...m,
          x: m.x + cdx,
          y: m.y + cdy,
        }));
        // mergeNodes (not upsertNode): no selection side effects, no history
        // capture (position moves are not undoable, matching single drags).
        mergeNodes(moved);
        // Persist each member; failures self-heal on the next 3s status poll
        // (the server truth reverts the local position).
        void (async () => {
          const results = await Promise.allSettled(
            moved.map((m) =>
              fetch(`/api/workflow/nodes/${m.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ x: m.x, y: m.y }),
              }).then((r) =>
                r.ok ? null : Promise.reject(new Error(`HTTP ${r.status}`)),
              ),
            ),
          );
          const failures = results.filter((r) => r.status === "rejected").length;
          if (failures > 0) {
            toast({
              title: `Failed to save position for ${failures} node${failures === 1 ? "" : "s"}`,
              description: "The canvas will revert to the saved positions on the next refresh.",
              variant: "destructive",
            });
          }
        })();
      }
    }
    dragState.current = null;
  };

  const onGroupPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    if (cardRef.current) cardRef.current.style.transform = "";
    setLiveDrag(null);
    edgeDomRef.current = null;
    if (st.moved) setDragActive(false);
    dragState.current = null;
  };

  return (
    <>
      <div
        role="group"
        aria-label={`Sweep group "${sourceName}" — ${total} variants, ${completed} completed. Drag to move the whole group; use Expand to see the variants.`}
        data-node-card
        ref={cardRef}
        className={cn(
          "group-card absolute w-[248px] cursor-grab touch-none rounded-xl border bg-card text-card-foreground shadow-md transition-shadow active:cursor-grabbing",
          "hover:shadow-lg",
          running && "node-pulse-running",
        )}
        style={{ left: x, top: y, width: CARD_W }}
        onPointerDown={onGroupPointerDown}
        onPointerMove={onGroupPointerMove}
        onPointerUp={onGroupPointerUp}
        onPointerCancel={onGroupPointerCancel}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <FlaskConical className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">
              {sourceName}
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
