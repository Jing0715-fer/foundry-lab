"use client";
import { create } from "zustand";
import type { NodeDTO, EdgeDTO } from "./types";

interface HistorySnapshot {
  nodes: NodeDTO[];
  edges: EdgeDTO[];
  viewport: { x: number; y: number; zoom: number };
}

interface HistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  /** Push a snapshot before a destructive operation. */
  push: (snapshot: HistorySnapshot) => void;
  /** Undo: move current to future, restore last past. */
  undo: () => HistorySnapshot | null;
  /** Redo: move current to past, restore last future. */
  redo: () => HistorySnapshot | null;
  /** Clear all history (e.g. after workflow switch). */
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

const MAX_HISTORY = 50;

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  push: (snapshot) =>
    set((s) => ({
      past: [...s.past, snapshot].slice(-MAX_HISTORY),
      future: [], // clear redo stack on new action
    })),
  undo: () => {
    const { past } = get();
    if (past.length === 0) return null;
    const prev = past[past.length - 1];
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [prev, ...s.future].slice(0, MAX_HISTORY),
    }));
    return prev;
  },
  redo: () => {
    const { future } = get();
    if (future.length === 0) return null;
    const next = future[0];
    set((s) => ({
      future: s.future.slice(1),
      past: [...s.past, next].slice(-MAX_HISTORY),
    }));
    return next;
  },
  clear: () => set({ past: [], future: [] }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));
