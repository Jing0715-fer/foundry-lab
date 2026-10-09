"use client";

import * as React from "react";
import { create } from "zustand";
import { useAppStore } from "@/lib/store";
import { CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { cn } from "@/lib/utils";
import type { CanvasGroupDTO } from "@/lib/types";

type Group = CanvasGroupDTO;

interface GroupColor {
  name: string;
  bg: string;
  border: string;
  label: string;
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
  { name: "teal", bg: "rgba(20, 184, 166, 0.08)", border: "rgba(20, 184, 166, 0.3)", label: "bg-teal-500" },
  { name: "violet", bg: "rgba(139, 92, 246, 0.08)", border: "rgba(139, 92, 246, 0.3)", label: "bg-violet-500" },
  { name: "amber", bg: "rgba(245, 158, 11, 0.08)", border: "rgba(245, 158, 11, 0.3)", label: "bg-amber-500" },
  { name: "rose", bg: "rgba(244, 63, 94, 0.08)", border: "rgba(244, 63, 94, 0.3)", label: "bg-rose-500" },
];

interface GroupBox extends Omit<Group, "color"> {
  box: { x: number; y: number; w: number; h: number };
  color: GroupColor;
}

/**
 * NodeGroupLayer — renders colored, dashed-rectangle overlays around
 * groups of nodes. Sits behind the node cards (rendered before them in
 * the workspace) but above the dot-grid background.
 *
 * Click a group to select it (shows the delete "×" button). Click again
 * (or click outside) to deselect.
 */
export function NodeGroupLayer() {
  const workflow = useAppStore((s) => s.workflow);
  const collapsedSweepGroups = useAppStore((s) => s.collapsedSweepGroups);
  const { groups, activeGroupId, removeGroup, setActiveGroup } = useGroupStore();
  const nodes = workflow?.nodes ?? [];

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

  // Compute each group's bounding box from its member nodes.
  // E3 collapse consistency: members folded into a sweep aggregate card are
  // rendered at the AGGREGATE's position, not their own — a dashed rectangle
  // around their raw coordinates would float over nothing. Collapsed members
  // are excluded; a group whose every member is collapsed disappears until
  // the sweep is expanded again.
  const groupBoxes = React.useMemo<GroupBox[]>(() => {
    const collapsed = new Set(collapsedSweepGroups);
    const visible = nodes.filter(
      (n) => !(n.sweepGroup && collapsed.has(n.sweepGroup)),
    );
    const out: GroupBox[] = [];
    for (const g of groups) {
      const members = visible.filter((n) => g.nodeIds.includes(n.id));
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x));
      const minY = Math.min(...members.map((n) => n.y));
      const maxX = Math.max(...members.map((n) => n.x + CARD_W));
      const maxY = Math.max(...members.map((n) => n.y + CARD_H));
      const color = GROUP_COLORS.find((c) => c.name === g.color) ?? GROUP_COLORS[0];
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
      });
    }
    return out;
  }, [groups, nodes, collapsedSweepGroups]);

  if (groupBoxes.length === 0) return null;

  return (
    <>
      {groupBoxes.map((gb) => {
        const isActive = gb.id === activeGroupId;
        return (
          <div
            key={gb.id}
            className="absolute cursor-pointer transition-shadow"
            style={{
              left: gb.box.x,
              top: gb.box.y,
              width: gb.box.w,
              height: gb.box.h,
              background: gb.color.bg,
              border: `1.5px dashed ${gb.color.border}`,
              borderRadius: 12,
              boxShadow: isActive
                ? `0 0 0 1px ${gb.color.border}`
                : undefined,
            }}
            onClick={(e) => {
              e.stopPropagation();
              setActiveGroup(isActive ? null : gb.id);
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
              {gb.label} ({gb.nodeIds.length})
            </div>
            {/* Delete button when active */}
            {isActive && (
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
            )}
          </div>
        );
      })}
    </>
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
