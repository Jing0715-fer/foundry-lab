"use client";
import { create } from "zustand";
import type { NodeDTO, EdgeDTO } from "./types";

export interface HistorySnapshot {
  nodes: NodeDTO[];
  edges: EdgeDTO[];
  viewport: { x: number; y: number; zoom: number };
}

interface HistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  /** Push a snapshot (the state BEFORE a destructive operation). */
  push: (snapshot: HistorySnapshot) => void;
  /**
   * Undo: pop the last past snapshot (the pre-op state) and push the CURRENT
   * (post-op) state onto the future stack so redo can return to it. The
   * caller must pass the CURRENT app state — the history store deliberately
   * doesn't import the app store (avoids a store↔store cycle) and undo
   * semantics need "what the user sees right now", captured at call time.
   */
  undo: (current: HistorySnapshot) => HistorySnapshot | null;
  /**
   * Redo: pop the first future snapshot and push the CURRENT state onto the
   * past stack (undo of the redo must be able to return here).
   */
  redo: (current: HistorySnapshot) => HistorySnapshot | null;
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
  undo: (current) => {
    const { past } = get();
    if (past.length === 0) return null;
    const prev = past[past.length - 1];
    set((s) => ({
      past: s.past.slice(0, -1),
      // The state being LEFT (current) goes to the future so redo restores
      // it — NOT the snapshot being restored (that made undo a toggle: redo
      // re-restored the same pre-op state forever).
      future: [current, ...s.future].slice(0, MAX_HISTORY),
    }));
    return prev;
  },
  redo: (current) => {
    const { future } = get();
    if (future.length === 0) return null;
    const next = future[0];
    set((s) => ({
      future: s.future.slice(1),
      // Symmetric: the state being LEFT (current) is pushed to past so
      // undo-after-redo returns to it.
      past: [...s.past, current].slice(-MAX_HISTORY),
    }));
    return next;
  },
  clear: () => set({ past: [], future: [] }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));
