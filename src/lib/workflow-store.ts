"use client";

// Small zustand store that supplements `useAppStore` for workflow-list
// operations (list/create/rename/remove). The foundation `useAppStore` is
// intentionally untouched; this store talks to the new plural
// `/api/workflows` endpoints and tracks the current list view separately.

import { create } from "zustand";
import type { WorkflowDTO } from "./types";

export interface WorkflowSummary {
  id: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowListState {
  workflows: WorkflowSummary[];
  activeId: string | null;
  loading: boolean;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  create: (name?: string) => Promise<WorkflowDTO | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useWorkflowListStore = create<WorkflowListState>((set, get) => ({
  workflows: [],
  activeId: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const data = (await res.json()) as WorkflowSummary[];
      set({ workflows: data, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setActive: (id) => set({ activeId: id }),

  create: async (name) => {
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return null;
      const wf = (await res.json()) as WorkflowDTO;
      await get().load();
      return wf;
    } catch {
      return null;
    }
  },

  rename: async (id, name) => {
    try {
      await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await get().load();
    } catch {
      /* swallow — UI still reflects optimistic state */
    }
  },

  remove: async (id) => {
    try {
      await fetch(`/api/workflows/${id}`, { method: "DELETE" });
      await get().load();
    } catch {
      /* swallow */
    }
  },
}));
