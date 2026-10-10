"use client";

import * as React from "react";
import { create } from "zustand";
import { Pencil } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { subscribeLiveDrag } from "@/lib/canvas-utils";
import { CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { cn } from "@/lib/utils";
import type { CanvasGroupDTO, NodeDTO } from "@/lib/types";

type Group = CanvasGroupDTO;

interface GroupColor {
  name: string;
  bg: string;
  border: string;
  label: string;
  /** Faded variants (bg 0.04 / border 0.15 alpha) for G2b ghost frames. */
  ghostBg: string;
  ghostBorder: string;
}

// ── F-lane persistence (groups → Workflow.groups column) ────────────────────
// The group layer used to be memory-only (lost on refresh). Mutations now
// schedule a debounced best-effort PATCH /api/workflows/:id { groups } with
// stale node ids pruned against the live workflow. Hydration happens on
// workflow load/switch (NodeGroupLayer effect below); while a persist is
// pending, hydration is suppressed so a concurrent refetch can't clobber
// unsaved local edits.

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending = false;
// P1-2 fix (QA 30-a): the debounce CAPTURES the target workflowId, the group
// snapshot, and the prune basis (live node ids) at SCHEDULE time. Firing
// after a workflow switch therefore still PATCHes the ORIGINAL workflow —
// the old code resolved the id at fire time and wrote A's groups into B
// (nodeIds pruned to [] → B's saved groups wiped, A's never persisted).
interface PendingPersist {
  workflowId: string;
  groups: CanvasGroupDTO[];
  liveIds: Set<string>;
}
let pendingPersist: PendingPersist | null = null;

function scheduleGroupPersist() {
  const workflow = useAppStore.getState().workflow;
  if (!workflow?.id) {
    pendingPersist = null;
    return;
  }
  // Capture NOW — a later workflow switch must not redirect this write.
  pendingPersist = {
    workflowId: workflow.id,
    groups: useGroupStore.getState().groups.map((g) => ({ ...g, nodeIds: [...g.nodeIds] })),
    liveIds: new Set((workflow.nodes ?? []).map((n) => n.id)),
  };
  persistPending = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const job = pendingPersist;
    pendingPersist = null;
    if (!job) return;
    // Prune node ids that no longer exist in the CAPTURED workflow (deleted
    // nodes keep the persisted layer honest).
    const payload = job.groups
      .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => job.liveIds.has(id)) }))
      .filter((g) => g.nodeIds.length > 0);
    void fetch(`/api/workflows/${job.workflowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: payload }),
    })
      .then((res) => {
        if (!res.ok) {
          // Surface non-2xx (e.g. validation 400) — a silent drop would let
          // the next hydrate revert local edits to the stale server state.
          console.warn(`[groups] persist failed (HTTP ${res.status}) — edits not saved.`);
        }
      })
      .catch(() => {
        // best-effort: transient network failure — the next mutation retries.
      })
      .finally(() => {
        // Only clear the flag when NO newer debounce is in flight (a second
        // edit during the fetch would otherwise lose its hydrate shield).
        if (persistTimer === null) persistPending = false;
      });
  }, 600);
}

// Tiny store for groups (don't modify the foundation useAppStore)
interface GroupState {
  groups: Group[];
  activeGroupId: string | null;
  addGroup: (g: Group) => void;
  removeGroup: (id: string) => void;
  updateGroup: (id: string, patch: Partial<Group>) => void;
  setActiveGroup: (id: string | null) => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  groups: [],
  activeGroupId: null,
  addGroup: (g) => {
    set((s) => ({ groups: [...s.groups, g] }));
    scheduleGroupPersist();
  },
  removeGroup: (id) => {
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      activeGroupId: s.activeGroupId === id ? null : s.activeGroupId,
    }));
    scheduleGroupPersist();
  },
  updateGroup: (id, patch) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }));
    scheduleGroupPersist();
  },
  setActiveGroup: (id) => set({ activeGroupId: id }),
}));

const GROUP_COLORS: GroupColor[] = [
  {
    name: "teal",
    bg: "rgba(20, 184, 166, 0.08)",
    border: "rgba(20, 184, 166, 0.3)",
    label: "bg-teal-500",
    ghostBg: "rgba(20, 184, 166, 0.04)",
    ghostBorder: "rgba(20, 184, 166, 0.15)",
  },
  {
    name: "violet",
    bg: "rgba(139, 92, 246, 0.08)",
    border: "rgba(139, 92, 246, 0.3)",
    label: "bg-violet-500",
    ghostBg: "rgba(139, 92, 246, 0.04)",
    ghostBorder: "rgba(139, 92, 246, 0.15)",
  },
  {
    name: "amber",
    bg: "rgba(245, 158, 11, 0.08)",
    border: "rgba(245, 158, 11, 0.3)",
    label: "bg-amber-500",
    ghostBg: "rgba(245, 158, 11, 0.04)",
    ghostBorder: "rgba(245, 158, 11, 0.15)",
  },
  {
    name: "rose",
    bg: "rgba(244, 63, 94, 0.08)",
    border: "rgba(244, 63, 94, 0.3)",
    label: "bg-rose-500",
    ghostBg: "rgba(244, 63, 94, 0.04)",
    ghostBorder: "rgba(244, 63, 94, 0.15)",
  },
];

// The collapsed sweep aggregate card (sweep-group-card.tsx) renders CARD_W
// wide and stacks header + progress + actions ≈ 150px tall.
const AGGREGATE_CARD_H = 150;

interface GroupBox extends Omit<Group, "color"> {
  box: { x: number; y: number; w: number; h: number };
  color: GroupColor;
  /** G2b: every member is folded into a sweep aggregate card (roadmap #22). */
  ghost: boolean;
}

/**
 * NodeGroupLayer — renders colored, dashed-rectangle overlays around
 * groups of nodes. Sits behind the node cards (rendered before them in
 * the workspace) but above the dot-grid background.
 *
 * Click a group to select it (shows the edit "✎" and delete "×" buttons).
 * Click again (or click outside) to deselect. The edit button opens the
 * inline rename/recolor editor (G2a); a group whose every member is folded
 * into a sweep aggregate card renders as a faded GHOST frame at the
 * aggregate's position instead of vanishing silently (G2b, roadmap #22).
 *
 * H2 (keyboard): frames are focusable (tabIndex 0, role="group") — Enter/Space
 * toggle selection, Escape deselects; once selected, the edit/delete buttons
 * are real <button>s reachable with Tab. Handled keys stopPropagation() so the
 * window-level global handlers (the Escape clear-selection lane) don't also
 * fire; modifier combos pass through (see the render-site comment for the
 * full matrix). Labeled-group conventions follow the sweep-group-card.
 *
 * H3a (ghost geometry): ghost frames bound the UNION of the aggregate boxes
 * the folded members actually render at (per-sweep origins — min over ALL of
 * each sweep's members, mirroring deriveSweepGroups), so a group spanning two
 * sweeps covers exactly the ground its aggregates occupy, and a partial group
 * hugs its sweep's aggregate card instead of floating at its own member min.
 *
 * H3b (ghost drag follow): while an aggregate card is being dragged, the
 * affected ghosts translate along live (DOM transform through the
 * subscribeLiveDrag subscription — no React re-render per frame, the same
 * cost class as the live edge patches; cleared on drop before the position
 * commit re-renders).
 */
export function NodeGroupLayer() {
  const workflow = useAppStore((s) => s.workflow);
  const collapsedSweepGroups = useAppStore((s) => s.collapsedSweepGroups);
  const { groups, activeGroupId, removeGroup, setActiveGroup } = useGroupStore();
  const nodes = workflow?.nodes ?? [];
  // G2a: which group's inline rename/recolor editor is open (null = none).
  const [editingGroupId, setEditingGroupId] = React.useState<string | null>(null);

  // ── Hydration (F-lane persistence) ─────────────────────────────────────
  // When the ACTIVE workflow changes (load / switch / restore) or its
  // server-side groups reference changes, sync the persisted groups into
  // the group store. A workflow SWITCH always hydrates (local groups belong
  // to the PREVIOUS workflow — the persistPending shield must not keep them
  // stuck on the new canvas, P1-2); same-workflow refetches are suppressed
  // while a local persist is pending so they can't clobber unsaved edits.
  const wfGroups = workflow?.groups;
  const hydratedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!workflow?.id) {
      hydratedFor.current = null;
      return;
    }
    const idChanged = hydratedFor.current !== workflow.id;
    if (idChanged) hydratedFor.current = workflow.id;
    if (!idChanged && persistPending) return;
    const incoming = wfGroups ?? [];
    const local = useGroupStore.getState().groups;
    const same =
      incoming.length === local.length &&
      incoming.every(
        (g, i) =>
          g.id === local[i]?.id &&
          g.label === local[i]?.label &&
          g.color === local[i]?.color &&
          g.nodeIds.length === local[i]?.nodeIds.length &&
          g.nodeIds.every((id, j) => id === local[i]?.nodeIds[j]),
      );
    if (!same) {
      useGroupStore.setState({ groups: incoming.map((g) => ({ ...g })), activeGroupId: null });
    }
  }, [workflow?.id, wfGroups]);

  // ── Editor lifecycle (G2a) ────────────────────────────────────────────
  // The inline editor must not outlive its group's selection: an outside
  // click (deselect), delete, or workflow switch clears activeGroupId, so
  // following it here closes the panel. The input's blur commit runs FIRST
  // (focus moves before the click lands), so a label typed right before an
  // outside click is still committed on the way out.
  React.useEffect(() => {
    if (editingGroupId !== null && editingGroupId !== activeGroupId) {
      setEditingGroupId(null);
    }
  }, [editingGroupId, activeGroupId]);

  // Compute each group's bounding box from its member nodes.
  // E3 collapse consistency: members folded into a sweep aggregate card are
  // rendered at the AGGREGATE's position, not their own — a dashed rectangle
  // around their raw coordinates would float over nothing. Collapsed members
  // are excluded from the normal box; a group whose EVERY member is collapsed
  // renders a GHOST frame at the aggregate's position instead (G2b).
  const groupBoxes = React.useMemo<GroupBox[]>(() => {
    const collapsed = new Set(collapsedSweepGroups);
    // P2-3c (QA 34-a): mirror deriveSweepGroups' ≥2-members rule — a sweep
    // group that shrinks to ONE live member renders that member as a normal
    // card (no aggregate), so counting it as "folded" here would draw a
    // ghost BEHIND a real card with a lying "N folded" label.
    const sweepCount = new Map<string, number>();
    for (const n of nodes) {
      if (n.sweepGroup) sweepCount.set(n.sweepGroup, (sweepCount.get(n.sweepGroup) ?? 0) + 1);
    }
    const folded = (n: NodeDTO): boolean =>
      !!n.sweepGroup && collapsed.has(n.sweepGroup) && (sweepCount.get(n.sweepGroup) ?? 0) >= 2;
    // H3a: aggregate origin per sweep = min over ALL of that sweep's member
    // nodes (deriveSweepGroups semantics) — the ghost bounds what the
    // aggregates ACTUALLY render at, not the group's own member subset.
    const sweepOrigin = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      if (!n.sweepGroup) continue;
      const cur = sweepOrigin.get(n.sweepGroup);
      if (!cur) sweepOrigin.set(n.sweepGroup, { x: n.x, y: n.y });
      else sweepOrigin.set(n.sweepGroup, { x: Math.min(cur.x, n.x), y: Math.min(cur.y, n.y) });
    }
    const visible = nodes.filter((n) => !folded(n));
    const out: GroupBox[] = [];
    for (const g of groups) {
      // All LIVE nodes in the group (ids of deleted nodes drop out here).
      const storedMembers = nodes.filter((n) => g.nodeIds.includes(n.id));
      // …of those, the ones actually rendered as cards right now.
      const members = visible.filter((n) => g.nodeIds.includes(n.id));
      const color = GROUP_COLORS.find((c) => c.name === g.color) ?? GROUP_COLORS[0];

      if (members.length === 0) {
        // G2b ghost lane (roadmap #22): a group whose every member was
        // folded into a sweep aggregate card used to VANISH silently —
        // nothing on the canvas hinted that the group still exists. Render
        // a faded frame hugging the aggregate card(s) so the group stays
        // visible AND selectable (edit/delete work on the ghost too).
        //
        // Stale node ids (deleted after the group was saved) keep the old
        // skip: the server-side prune (node DELETE route) will clean the
        // group, and a ghost around a partially-deleted membership would
        // lie about what is folded.
        const allFolded =
          storedMembers.length > 0 &&
          storedMembers.length === g.nodeIds.length &&
          storedMembers.every(folded);
        if (!allFolded) continue;
        // H3a: bound the UNION of the per-sweep aggregate boxes (each sweep's
        // aggregate is CARD_W × AGGREGATE_CARD_H at its own origin), with the
        // same -24/-40 padding convention the live frames use. A group whose
        // members span TWO sweeps covers the middle ground because the
        // aggregates really are there; a partial group (members ⊂ sweep)
        // hugs its sweep's aggregate card exactly.
        const origins = storedMembers
          .map((m) => sweepOrigin.get(m.sweepGroup!))
          .filter((b): b is { x: number; y: number } => !!b);
        if (origins.length === 0) continue; // defensive — folded implies sweepGroup
        const x0 = Math.min(...origins.map((b) => b.x)) - 24;
        const y0 = Math.min(...origins.map((b) => b.y)) - 40;
        const x1 = Math.max(...origins.map((b) => b.x + CARD_W)) + 24;
        const y1 = Math.max(...origins.map((b) => b.y + AGGREGATE_CARD_H)) + 24;
        out.push({
          ...g,
          nodeIds: storedMembers.map((m) => m.id),
          box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
          color,
          ghost: true,
        });
        continue;
      }

      const minX = Math.min(...members.map((n) => n.x));
      const minY = Math.min(...members.map((n) => n.y));
      const maxX = Math.max(...members.map((n) => n.x + CARD_W));
      const maxY = Math.max(...members.map((n) => n.y + CARD_H));
      out.push({
        ...g,
        nodeIds: members.map((m) => m.id),
        box: {
          x: minX - 24,
          y: minY - 40,
          w: maxX - minX + 48,
          h: maxY - minY + 64,
        },
        color,
        ghost: false,
      });
    }
    return out;
  }, [groups, nodes, collapsedSweepGroups]);

  // ── H3b: ghost frames follow an in-progress aggregate drag live ──────
  // DOM transforms through the subscribeLiveDrag subscription (no React
  // re-render per frame — same cost class as the live edge patches). The
  // subscription is registered once; the ghost membership snapshot is kept
  // in refs and refreshed whenever groupBoxes recomputes (which also clears
  // stale transforms — a re-render means positions were committed).
  const ghostRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ghostMembersRef = React.useRef<Map<string, Set<string>>>(new Map());
  React.useEffect(() => {
    const ghosts = groupBoxes.filter((gb) => gb.ghost);
    ghostMembersRef.current = new Map(ghosts.map((gb) => [gb.id, new Set(gb.nodeIds)]));
    // Drop refs for boxes that are no longer ghosts (e.g. the sweep was
    // expanded) and clear leftover transforms — the fresh render recomputed
    // every box position.
    for (const id of [...ghostRefs.current.keys()]) {
      if (!ghostMembersRef.current.has(id)) ghostRefs.current.delete(id);
    }
    for (const el of ghostRefs.current.values()) {
      if (el) el.style.transform = "";
    }
  }, [groupBoxes]);
  React.useEffect(() => {
    return subscribeLiveDrag((drag) => {
      for (const [id, el] of ghostRefs.current) {
        if (!el) continue;
        const members = ghostMembersRef.current.get(id);
        if (drag && members && drag.ids.some((mid) => members.has(mid))) {
          el.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
        } else {
          el.style.transform = "";
        }
      }
    });
  }, []);

  if (groupBoxes.length === 0) return null;

  return (
    <>
      {groupBoxes.map((gb) => {
        const isActive = gb.id === activeGroupId;
        return (
          <div
            key={gb.id}
            data-testid={gb.ghost ? "group-ghost" : undefined}
            // H2: keyboard path — the frame itself is focusable (role=group,
            // following the sweep aggregate card's labeled-group pattern) and
            // Enter/Space toggle selection; once selected the edit/delete
            // buttons are real <button>s that Tab reaches. Escape deselects.
            // stopPropagation on the HANDLED keys keeps them from the
            // window-level listeners (the global Escape clears node
            // selection / cancels a live wire — focus is on the frame, so
            // the frame's own deselect is the right response). Modifier
            // combos (Ctrl+F/G) aren't handled here and pass through —
            // canvas shortcuts keep working while a frame is focused.
            // Note: this is the canvas's FIRST keyboard-operable surface
            // (node cards and sweep cards are pointer-only; role/aria-label
            // conventions come from the sweep-group-card).
            role="group"
            tabIndex={0}
            aria-label={
              `Group "${gb.label}", ${gb.nodeIds.length} member${gb.nodeIds.length === 1 ? "" : "s"}` +
              (gb.ghost
                ? ", all folded into sweep aggregate cards"
                : "") +
              ". Press Enter to " + (isActive ? "deselect" : "select") + "."
            }
            className={cn(
              "absolute cursor-pointer transition-shadow",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400",
            )}
            style={{
              left: gb.box.x,
              top: gb.box.y,
              width: gb.box.w,
              height: gb.box.h,
              background: gb.ghost ? gb.color.ghostBg : gb.color.bg,
              border: `1.5px dashed ${gb.ghost ? gb.color.ghostBorder : gb.color.border}`,
              borderRadius: 12,
              boxShadow: isActive
                ? `0 0 0 1px ${gb.color.border}`
                : undefined,
            }}
            // H3b: register ghost frames for the live-drag transform follow.
            // (Block body — callback refs returning a Map would be treated as
            // a cleanup function by React.)
            ref={(el) => {
              if (gb.ghost) {
                ghostRefs.current.set(gb.id, el);
              } else {
                ghostRefs.current.delete(gb.id);
              }
            }}
            // G-lane fix (real-pointer e2e, Task 33-a): the canvas's
            // background pointerdown handler calls setPointerCapture on the
            // canvas <section> for every hit that isn't a node card / port /
            // create menu — group frames count as "background", so the
            // browser retargeted every subsequent pointerup AND click to the
            // captured section. The frame's onClick (select toggle) and the
            // delete "×" button never fired in practice (verified with a
            // trusted click: pointerup + click landed on the section only).
            // Stopping the pointerdown propagation here keeps the capture —
            // and with it the pan / band-select machinery — out of frame
            // interactions so the natural click sequence reaches the frame
            // and its buttons. Trade-off: starting a pan drag ON the frame
            // no longer pans (clickable overlay beats drag surface — the
            // cursor-pointer affordance was always a lie before this fix).
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setActiveGroup(isActive ? null : gb.id);
            }}
            onKeyDown={(e) => {
              // P1-1 fix (QA 38-a): interactive descendants own their keys.
              // Without this guard the frame's preventDefault() on Enter/Space
              // cancels a focused ✎/× button's native activation (keyboard
              // dead keys — reachable but unactivatable), and the rename
              // input's Enter commit bubbles into an accidental deselect.
              if (
                (e.target as HTMLElement).closest(
                  "button, input, [contenteditable='true'], [role='button']",
                )
              ) {
                return;
              }
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setActiveGroup(isActive ? null : gb.id);
              } else if (e.key === "Escape" && isActive) {
                e.preventDefault();
                e.stopPropagation();
                setActiveGroup(null);
              }
            }}
          >
            {/* Label */}
            <div
              className={cn(
                "absolute -top-3 left-3 rounded-full px-2 py-0.5 text-[10px] font-medium text-white shadow-sm",
                gb.color.label,
                isActive && "group-active",
              )}
            >
              {gb.ghost
                ? `${gb.label} · ${gb.nodeIds.length} folded`
                : `${gb.label} (${gb.nodeIds.length})`}
            </div>
            {/* Ghost hint (G2b): how to get the members back. */}
            {gb.ghost && (
              <div className="absolute bottom-1.5 left-3 text-[10px] text-muted-foreground">
                expand the sweep to see members
              </div>
            )}
            {/* Edit (G2a) + delete buttons when active */}
            {isActive && (
              <>
                <button
                  type="button"
                  aria-label={`Edit group "${gb.label}"`}
                  data-testid="group-edit-button"
                  className="absolute -top-3 right-11 flex size-5 items-center justify-center rounded-full bg-slate-600 text-white shadow-sm transition-colors hover:bg-slate-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingGroupId(gb.id);
                  }}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove group "${gb.label}"`}
                  className="absolute -top-3 right-3 flex size-5 items-center justify-center rounded-full bg-rose-500 text-white shadow-sm transition-colors hover:bg-rose-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeGroup(gb.id);
                  }}
                >
                  <span className="text-xs leading-none">×</span>
                </button>
              </>
            )}
            {/* Inline rename/recolor editor (G2a). Rendered inside the
                frame's own geometry, so it works for ghost frames too. */}
            {isActive && editingGroupId === gb.id && (
              <GroupEditorPanel
                key={gb.id}
                gb={gb}
                onClose={() => setEditingGroupId(null)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Inline rename/recolor editor for one group (G2a). Rendered on the frame
 * (absolute top-2 left-3, opaque bg-card — NOT the group's translucent bg)
 * with pointer-events so it stays interactive inside the frame.
 *
 * Label commits go through updateGroup (which schedules the debounced
 * groups PATCH — maxLength 64 + non-empty mirror the server's
 * sanitizeGroupsJSON contract). Color dots commit immediately and keep the
 * editor open so a recolor doesn't cancel a half-typed rename.
 */
function GroupEditorPanel({
  gb,
  onClose,
}: {
  gb: GroupBox;
  onClose: () => void;
}) {
  const updateGroup = useGroupStore((s) => s.updateGroup);
  const [draft, setDraft] = React.useState(gb.label);
  // Enter/Escape unmount the panel while the input still holds focus —
  // some browsers then synthesize a focusout whose blur would re-commit
  // (or, after Escape, commit at all). closeRef marks the panel as
  // finished so the blur handler becomes a no-op on the way out.
  const closeRef = React.useRef(false);

  const commitLabel = () => {
    // Empty/whitespace-only keeps the CURRENT label: the server rejects
    // empty labels ("Each group needs an id and a non-empty label").
    const next = draft.trim() || gb.label;
    if (next !== gb.label) updateGroup(gb.id, { label: next });
  };

  return (
    <div
      data-testid="group-editor"
      className="pointer-events-auto absolute top-2 left-3 z-10 w-52 rounded-lg border bg-card p-2 shadow-lg"
      // Clicks inside the panel are panel business only — the frame's
      // onClick select-toggle must not fire underneath an editor edit.
      onClick={(e) => e.stopPropagation()}
      // P2-2 (QA 34-a): the canvas's onDoubleClick treats this panel as
      // background and opens the create-node popover OVER the editor (its
      // click-away catcher then swallows the next pointerdown). A word-select
      // double-click in the label input is a normal gesture — keep it local.
      onDoubleClick={(e) => e.stopPropagation()}
      // Escape from ANYWHERE inside the panel (label input or a focused
      // color dot — dot clicks move focus off the input) closes without
      // committing; stopPropagation so outer layers don't also react to Esc.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current = true;
        onClose();
      }}
      onBlur={(e) => {
        if (closeRef.current) return;
        // Commit only when focus LEFT the panel: clicking a color dot
        // moves focus within it and must not double-fire a label commit
        // alongside the dot's own updateGroup. relatedTarget is null when
        // focus lands on a non-focusable element (canvas, frame) — that
        // counts as "left the panel" and commits, as an outside click
        // should.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        commitLabel();
      }}
    >
      <input
        value={draft}
        maxLength={64}
        autoFocus
        aria-label="Group label"
        data-testid="group-label-input"
        placeholder="Group label…"
        className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            closeRef.current = true;
            commitLabel();
            onClose();
          }
        }}
      />
      {/* Color dots — one per GROUP_COLORS entry; the current one wears a
          ring. Immediate commit, editor stays open. */}
      <div className="mt-2 flex items-center gap-2">
        {GROUP_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            aria-label={`Set group color ${c.name}`}
            data-testid={`group-color-${c.name}`}
            className={cn(
              "size-5 rounded-full border border-border",
              c.label,
              c.name === gb.color.name &&
                "ring-2 ring-offset-2 ring-offset-card ring-foreground/40",
            )}
            onClick={(e) => {
              e.stopPropagation();
              updateGroup(gb.id, { color: c.name });
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Create a group from the currently selected nodes. */
export function createGroupFromSelection(label: string, color: string) {
  const selectedIds = useAppStore.getState().selectedIds;
  if (selectedIds.length < 2) {
    useAppStore.getState().toast({
      title: "Select 2+ nodes to group",
      variant: "destructive",
    });
    return;
  }
  const id = `grp_${Math.random().toString(36).slice(2, 10)}`;
  useGroupStore.getState().addGroup({ id, label, color, nodeIds: selectedIds });
  useAppStore.getState().toast({
    title: "Group created",
    description: `${selectedIds.length} nodes grouped`,
  });
}
