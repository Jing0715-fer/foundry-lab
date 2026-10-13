"use client";

// Shared edge-DOM live patching (cryoflow pattern) — F-lane liveDrag group
// extension.
//
// During a card drag the SVG edge layer is NOT re-rendered via React (far too
// expensive per frame). On the first significant pointermove the drag loop
// collects references to the per-edge `<g data-edge-id="…">` groups connected
// to the dragged card(s), and each rAF frame patches their attributes
// directly via setAttribute. No React state writes, no zustand writes.
//
// Extracted from node-card.tsx and generalized from ONE node id to a LIST of
// ids so the sweep aggregate card (sweep-group-card.tsx) can live-follow
// every edge attached to any of its member nodes while the group is dragged —
// previously edges only re-routed on release.

import {
  computeAllEdgeGeoms,
  type LiveDrag,
} from "@/lib/canvas-utils";
import { useAppStore } from "@/lib/store";
import type { NodeDTO } from "@/lib/types";

/**
 * Collect the per-edge `<g data-edge-id="…">` groups connected to ANY of the
 * given node ids (single-card drag → [id]; group drag → all member ids).
 * Returns null if the SVG layer isn't found or none of the nodes has edges.
 */
export function collectEdgeGroups(ids: string[]): Map<string, SVGGElement> | null {
  const svg = document.querySelector("svg[data-edges-layer]");
  if (!svg) return null;
  const state = useAppStore.getState();
  const workflow = state.workflow;
  if (!workflow) return null;
  const idSet = new Set(ids);
  let any = false;
  const map = new Map<string, SVGGElement>();
  for (const e of workflow.edges) {
    if (!idSet.has(e.fromNodeId) && !idSet.has(e.toNodeId)) continue;
    const g = svg.querySelector(`g[data-edge-id="${e.id}"]`);
    if (g) {
      map.set(e.id, g as SVGGElement);
      any = true;
    }
  }
  return any ? map : null;
}

/**
 * Patch the cached edge `<g>` groups in place for the live drag offset
 * `(dx, dy)` (world coordinates). Computes the new geometry for ALL edges
 * (cheap) and updates only the ones connected to any of the given ids.
 *
 * `nodesOverride` (P1-1 fix): the node array in RENDER space. Collapsed sweep
 * groups render their members at the AGGREGATE's top-left (workflow-canvas
 * layoutNodes) — a group drag must patch edges against those render
 * coordinates, not the raw store positions, or every connected edge jumps to
 * the invisible scattered member positions on the first frame. Omit it for
 * single-card drags (raw == render for visible nodes).
 */
export function patchEdgeGroups(
  groups: Map<string, SVGGElement>,
  ids: string[],
  dx: number,
  dy: number,
  nodesOverride?: NodeDTO[],
): void {
  const state = useAppStore.getState();
  const workflow = state.workflow;
  if (!workflow) return;
  const drag: LiveDrag = { ids, dx, dy };
  const geomNodes = nodesOverride ?? workflow.nodes;
  const geoms = computeAllEdgeGeoms(workflow.edges, geomNodes, drag);
  const idSet = new Set(ids);
  const edgeById = new Map(workflow.edges.map((e) => [e.id, e]));
  for (const g of geoms) {
    const edge = edgeById.get(g.id);
    if (!edge) continue;
    if (!idSet.has(edge.fromNodeId) && !idSet.has(edge.toNodeId)) continue;
    const el = groups.get(g.id);
    if (!el) continue;
    // Patch all edge-geometry paths (hit area + visible stroke).
    const paths = el.querySelectorAll('[data-e="d"]');
    paths.forEach((p) => {
      (p as SVGPathElement).setAttribute("d", g.d);
    });
    // Patch every animateMotion (running-edge traveling dots).
    const motions = el.querySelectorAll("[data-e=\"motion\"]");
    motions.forEach((m) => {
      (m as SVGElement).setAttribute("path", g.d);
    });
    // Patch source dot.
    const src = el.querySelector('[data-e="src"]');
    if (src) {
      src.setAttribute("cx", String(g.src.x));
      src.setAttribute("cy", String(g.src.y));
    }
    // Patch target dot(s).
    const tgts = el.querySelectorAll('[data-e="tgt"]');
    tgts.forEach((t) => {
      t.setAttribute("cx", String(g.tgt.x));
      t.setAttribute("cy", String(g.tgt.y));
    });
    // Patch running-gradient endpoints (only present on running edges).
    const grad = el.querySelector('[data-e="grad"]');
    if (grad) {
      grad.setAttribute("x1", String(g.src.x));
      grad.setAttribute("y1", String(g.src.y));
      grad.setAttribute("x2", String(g.tgt.x));
      grad.setAttribute("y2", String(g.tgt.y));
    }
  }
}
