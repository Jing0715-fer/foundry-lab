// Pure canvas math: edge bezier geometry, port anchor positions, topological layout.

import type { EdgeDTO, NodeDTO, PortKind } from "./types";
import { CARD_W, CARD_H, portY } from "./workflow-catalog";

export interface Point { x: number; y: number; }

export interface EdgeGeom {
  id: string;
  src: Point;
  tgt: Point;
  d: string; // SVG path
  mid: Point;
}

/**
 * Module-level live-drag state.
 *
 * Holds the in-progress card drag offset (nodeId + dx/dy in WORLD coordinates)
 * so that ANY consumer of `computeAllEdgeGeoms` can read it without going through
 * React state or the zustand store. The drag loop in node-card.tsx writes to
 * this every rAF frame and clears it on pointerup.
 *
 * This is the cryoflow pattern: edges are patched directly via DOM setAttribute
 * (no React re-render per frame), but the shared geometry helpers can still
 * observe the live offset for defensive reads (e.g. by polling layers or the
 * SVG layer itself if it ever re-renders mid-drag).
 */
let liveDrag: { id: string; dx: number; dy: number } | null = null;

export function setLiveDrag(o: { id: string; dx: number; dy: number } | null): void {
  liveDrag = o;
}

export function getLiveDrag(): { id: string; dx: number; dy: number } | null {
  return liveDrag;
}

/** Anchor point of a port on a card. dir = "out" (right edge) | "in" (left edge). */
export function portAnchor(
  job: NodeDTO,
  dir: "in" | "out",
  portIndex: number,
  portCount: number,
): Point {
  const x = dir === "out" ? job.x + CARD_W : job.x;
  const y = job.y + portY(portIndex, portCount);
  return { x, y };
}

/** Compute a smooth cubic bezier path between two points. */
export function bezierPath(src: Point, tgt: Point): { d: string; mid: Point } {
  const dx = Math.max(40, Math.abs(tgt.x - src.x) * 0.5);
  const c1x = src.x + dx;
  const c2x = tgt.x - dx;
  const d = `M ${src.x} ${src.y} C ${c1x} ${src.y}, ${c2x} ${tgt.y}, ${tgt.x} ${tgt.y}`;
  const mid = { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 };
  return { d, mid };
}

/** Resolve the (fromPort,toPort) indices on each card for an edge. */
export function resolvePortIndices(
  edge: EdgeDTO,
  jobs: NodeDTO[],
): {
  from: NodeDTO | undefined;
  to: NodeDTO | undefined;
  fromIdx: number;
  fromCount: number;
  toIdx: number;
  toCount: number;
} {
  const from = jobs.find((j) => j.id === edge.fromNodeId);
  const to = jobs.find((j) => j.id === edge.toNodeId);
  const fromIdx = from?.params ? Number(from.params[`__outIdx_${edge.fromPort ?? "default"}`] ?? 0) : 0;
  const toIdx = to?.params ? Number(to.params[`__inIdx_${edge.toPort ?? "default"}`] ?? 0) : 0;
  const fromCount = from?.params ? Number(from.params.__outCount ?? 1) : 1;
  const toCount = to?.params ? Number(to.params.__inCount ?? 1) : 1;
  return { from, to, fromIdx, fromCount, toIdx, toCount };
}

export function computeEdgeGeom(
  edge: EdgeDTO,
  jobs: NodeDTO[],
  drag?: { id: string; dx: number; dy: number },
): EdgeGeom | null {
  const { from, to } = resolvePortIndices(edge, jobs);
  if (!from || !to) return null;
  const fromDx = drag && drag.id === from.id ? drag.dx : 0;
  const fromDy = drag && drag.id === from.id ? drag.dy : 0;
  const toDx = drag && drag.id === to.id ? drag.dx : 0;
  const toDy = drag && drag.id === to.id ? drag.dy : 0;
  const src = { x: from.x + CARD_W + fromDx, y: from.y + 58 + fromDy };
  const tgt = { x: to.x + toDx, y: to.y + 58 + toDy };
  const { d, mid } = bezierPath(src, tgt);
  return { id: edge.id, src, tgt, d, mid };
}

export function computeAllEdgeGeoms(
  edges: EdgeDTO[],
  jobs: NodeDTO[],
  drag?: { id: string; dx: number; dy: number },
): EdgeGeom[] {
  return edges
    .map((e) => computeEdgeGeom(e, jobs, drag))
    .filter((g): g is EdgeGeom => g !== null);
}

/** Bounding box of all jobs (with padding) — used for the SVG viewBox. */
export function contentBox(jobs: NodeDTO[]): { x: number; y: number; w: number; h: number } {
  if (jobs.length === 0) return { x: 0, y: 0, w: 1200, h: 800 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const j of jobs) {
    minX = Math.min(minX, j.x);
    minY = Math.min(minY, j.y);
    maxX = Math.max(maxX, j.x + CARD_W);
    maxY = Math.max(maxY, j.y + CARD_H);
  }
  const pad = 600;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Cycle detection via DFS. */
export function wouldCreateCycle(
  edges: { fromNodeId: string; toNodeId: string }[],
  fromId: string,
  toId: string,
): boolean {
  if (fromId === toId) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, []);
    adj.get(e.fromNodeId)!.push(e.toNodeId);
  }
  if (!adj.has(fromId)) adj.set(fromId, []);
  adj.get(fromId)!.push(toId);
  const visited = new Set<string>();
  const stack = [toId];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === fromId) return true;
    if (visited.has(n)) continue;
    visited.add(n);
    for (const next of adj.get(n) ?? []) stack.push(next);
  }
  return false;
}

/** Topological order (Kahn's algorithm). Returns null if cyclic. */
export function topologicalOrder(jobs: NodeDTO[], edges: EdgeDTO[]): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const j of jobs) { indeg.set(j.id, 0); adj.set(j.id, []); }
  for (const e of edges) {
    if (!indeg.has(e.fromNodeId) || !indeg.has(e.toNodeId)) continue;
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    indeg.set(e.toNodeId, (indeg.get(e.toNodeId) ?? 0) + 1);
  }
  const queue = jobs.filter((j) => (indeg.get(j.id) ?? 0) === 0).map((j) => j.id);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === jobs.length ? order : null;
}

/** Auto-arrange jobs in a left-to-right layered layout. */
export function autoLayout(jobs: NodeDTO[], edges: EdgeDTO[]): Map<string, { x: number; y: number }> {
  const order = topologicalOrder(jobs, edges);
  const result = new Map<string, { x: number; y: number }>();
  if (!order) {
    // fallback: grid
    const cols = Math.ceil(Math.sqrt(jobs.length));
    jobs.forEach((j, i) => result.set(j.id, { x: 80 + (i % cols) * 320, y: 80 + Math.floor(i / cols) * 180 }));
    return result;
  }
  // Assign layers by longest path from a source.
  const layer = new Map<string, number>();
  for (const id of order) {
    const incoming = edges.filter((e) => e.toNodeId === id).map((e) => e.fromNodeId);
    const maxL = incoming.length ? Math.max(...incoming.map((p) => layer.get(p) ?? 0)) : -1;
    layer.set(id, maxL + 1);
  }
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }
  const colW = 320, rowH = 170, x0 = 80, y0 = 80;
  for (const [l, ids] of byLayer) {
    ids.forEach((id, i) => result.set(id, { x: x0 + l * colW, y: y0 + i * rowH }));
  }
  return result;
}

/** Clamp a world coordinate to the valid range. */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
