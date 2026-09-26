"use client";

import * as React from "react";
import { create } from "zustand";
import { useAppStore } from "@/lib/store";
import { CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { cn } from "@/lib/utils";

interface Group {
  id: string;
  label: string;
  color: string;
  nodeIds: string[];
}

interface GroupColor {
  name: string;
  bg: string;
  border: string;
  label: string;
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
  addGroup: (g) => set((s) => ({ groups: [...s.groups, g] })),
  removeGroup: (id) =>
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      activeGroupId: s.activeGroupId === id ? null : s.activeGroupId,
    })),
  updateGroup: (id, patch) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
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
  const { groups, activeGroupId, removeGroup, setActiveGroup } = useGroupStore();
  const nodes = workflow?.nodes ?? [];

  // Compute each group's bounding box from its member nodes.
  const groupBoxes = React.useMemo<GroupBox[]>(() => {
    const out: GroupBox[] = [];
    for (const g of groups) {
      const members = nodes.filter((n) => g.nodeIds.includes(n.id));
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x));
      const minY = Math.min(...members.map((n) => n.y));
      const maxX = Math.max(...members.map((n) => n.x + CARD_W));
      const maxY = Math.max(...members.map((n) => n.y + CARD_H));
      const color = GROUP_COLORS.find((c) => c.name === g.color) ?? GROUP_COLORS[0];
      out.push({
        ...g,
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
  }, [groups, nodes]);

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
