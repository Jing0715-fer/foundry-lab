"use client";

import React from "react";
import type { EdgeDTO, NodeDTO } from "@/lib/types";
import { computeAllEdgeGeoms, contentBox } from "@/lib/canvas-utils";
import { useAppStore } from "@/lib/store";

interface EdgesLayerProps {
  edges: EdgeDTO[];
  nodes: NodeDTO[];
}

/**
 * SVG edge layer. Renders one <svg> sized to the content box of all nodes
 * (so all coordinates are workspace coords). pointer-events: none on the svg,
 * but per-edge hit-paths re-enable pointer-events: all for hover/click.
 *
 * Visual states:
 *  - Base: subtle border color stroke + small arrowhead at the target end.
 *  - Hovered / selected: primary stroke (3px) + drop-shadow filter for depth.
 *  - Running source: directional gradient (source→target) + animated particles
 *    (3 traveling dots via animateMotion for a richer "data flowing" effect).
 *  - Completed → pending: subtle teal gradient.
 *  - Selected endpoint: strokeWidth 3.5 + `.edge-selected` pulse animation.
 *  - Hover label: small "fromPort → toPort" text chip at the path midpoint.
 */
function EdgesLayerImpl({ edges, nodes }: EdgesLayerProps) {
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const removeEdge = useAppStore((s) => s.removeEdge);
  const toast = useAppStore((s) => s.toast);
  const selectedIds = useAppStore((s) => s.selectedIds);

  const geoms = React.useMemo(
    () => computeAllEdgeGeoms(edges, nodes),
    [edges, nodes],
  );

  const box = React.useMemo(() => contentBox(nodes), [nodes]);

  // Map of nodeId -> node for status lookups.
  const nodeById = React.useMemo(() => {
    const m = new Map<string, NodeDTO>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Set of selected node IDs for O(1) "is endpoint selected" lookups.
  const selectedSet = React.useMemo(
    () => new Set(selectedIds),
    [selectedIds],
  );

  const handleDelete = React.useCallback(
    async (edge: EdgeDTO) => {
      removeEdge(edge.id);
      try {
        const res = await fetch(`/api/workflow/edges/${edge.id}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("delete failed");
        toast({ title: "Edge removed" });
      } catch {
        toast({ title: "Failed to remove edge", variant: "destructive" });
      }
    },
    [removeEdge, toast],
  );

  // Unique gradient ids per render so multiple SVGs on the page don't clash.
  const uid = React.useId().replace(/:/g, "");
  const arrowId = `arrowhead-${uid}`;
  const arrowSelId = `arrowhead-sel-${uid}`;
  const gradDoneId = `grad-done-${uid}`;
  // Per-edge running gradient ids — directional (source→target).
  const gradRunIdFor = (edgeId: string) => `grad-run-${uid}-${edgeId}`;

  return (
    <svg
      data-edges-layer
      className="pointer-events-none absolute overflow-visible"
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
      }}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
    >
      <defs>
        {/* Subtle base arrowhead (muted-foreground). */}
        <marker
          id={arrowId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            style={{ fill: "var(--muted-foreground)" }}
          />
        </marker>
        {/* Primary-colored arrowhead for hovered/selected edges. */}
        <marker
          id={arrowSelId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "var(--primary)" }} />
        </marker>
        {/* Subtle teal gradient for completed→pending edges. */}
        <linearGradient id={gradDoneId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="oklch(0.7 0.14 145 / 0.5)" />
          <stop offset="100%" stopColor="oklch(0.7 0.14 145)" />
        </linearGradient>
      </defs>

      {geoms.map((g) => {
        const edge = edges.find((e) => e.id === g.id);
        if (!edge) return null;
        const fromNode = nodeById.get(edge.fromNodeId);
        const toNode = nodeById.get(edge.toNodeId);
        const isRunning = fromNode?.status === "running";
        const isCompleted =
          fromNode?.status === "completed" &&
          (toNode?.status === "pending" || toNode?.status === "idle");
        const isHovered = hoveredId === g.id;
        // An edge is "selected" when one of its endpoint NODES is selected.
        const isEndpointSelected =
          selectedSet.has(edge.fromNodeId) || selectedSet.has(edge.toNodeId);
        const highlighted = isHovered || isEndpointSelected;

        // Per-edge directional gradient (source → target) for running edges.
        // Lighter at the source, full primary at the target — visually
        // represents data flowing from source to target.
        const gradRunId = gradRunIdFor(g.id);

        // Stroke color logic.
        let stroke: string;
        let strokeWidth: number;
        let markerEnd: string;
        let className: string | undefined;
        if (isRunning) {
          stroke = `url(#${gradRunId})`;
          strokeWidth = isHovered ? 3 : 2.5;
          markerEnd = `url(#${arrowSelId})`;
          className = "edge-flow";
        } else if (isCompleted) {
          stroke = `url(#${gradDoneId})`;
          strokeWidth = isHovered ? 3 : 2.25;
          markerEnd = `url(#${arrowId})`;
        } else if (highlighted) {
          stroke = "var(--primary)";
          strokeWidth = 3;
          markerEnd = `url(#${arrowSelId})`;
        } else {
          stroke = "var(--border)";
          strokeWidth = 2;
          markerEnd = `url(#${arrowId})`;
        }

        // Selected endpoint → bump stroke to 3.5 + add pulse class.
        if (isEndpointSelected) {
          strokeWidth = 3.5;
        }

        // Drop-shadow on hovered edges for depth.
        const filterClass = highlighted ? "edge-glow" : undefined;
        // Pulse on endpoint-selected edges (on top of running flow if both apply).
        const selectedClass = isEndpointSelected ? "edge-selected" : undefined;

        // Port label, e.g. "text → context" (fallback to "default → default").
        const fromPortLabel = edge.fromPort ?? "default";
        const toPortLabel = edge.toPort ?? "default";
        const portLabel = `${fromPortLabel} → ${toPortLabel}`;
        // Approximate label width for the bg rect (9px font, ~5.4px per char).
        const labelW = Math.max(36, portLabel.length * 5.4 + 8);
        const labelH = 16;

        return (
          <g key={g.id} data-edge-id={g.id}>
            {/* Per-edge directional running gradient (source → target). */}
            {isRunning && (
              <linearGradient
                data-e="grad"
                id={gradRunId}
                gradientUnits="userSpaceOnUse"
                x1={g.src.x}
                y1={g.src.y}
                x2={g.tgt.x}
                y2={g.tgt.y}
              >
                <stop
                  offset="0%"
                  stopColor="color-mix(in oklab, var(--primary) 30%, transparent)"
                />
                <stop offset="100%" stopColor="var(--primary)" />
              </linearGradient>
            )}
            {/* Invisible hit area */}
            <path
              data-e="d"
              d={g.d}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              strokeLinecap="round"
              className="pointer-events-auto cursor-pointer"
              onPointerEnter={() => setHoveredId(g.id)}
              onPointerLeave={() => setHoveredId((h) => (h === g.id ? null : h))}
            />
            {/* Visible edge */}
            <path
              data-e="d"
              d={g.d}
              fill="none"
              stroke={
                stroke.startsWith("var(") || stroke.startsWith("url(")
                  ? undefined
                  : stroke
              }
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              markerEnd={markerEnd}
              className={cnEdges(className, filterClass, selectedClass)}
              style={
                stroke.startsWith("var(") || stroke.startsWith("url(")
                  ? { stroke }
                  : undefined
              }
            />
            {/* Running dashes: traveling dots via animateMotion.
                3 particles with staggered delays for a richer flow effect. */}
            {isRunning && (
              <>
                <circle r={2.6} style={{ fill: "var(--primary)" }}>
                  <animateMotion data-e="motion" dur="1.1s" begin="0s" repeatCount="indefinite" path={g.d} />
                </circle>
                <circle
                  r={2.6}
                  style={{ fill: "color-mix(in oklab, var(--primary) 70%, transparent)" }}
                >
                  <animateMotion
                    data-e="motion"
                    dur="1.1s"
                    begin="0.37s"
                    repeatCount="indefinite"
                    path={g.d}
                  />
                </circle>
                <circle
                  r={2.2}
                  style={{ fill: "color-mix(in oklab, var(--primary) 45%, transparent)" }}
                >
                  <animateMotion
                    data-e="motion"
                    dur="1.1s"
                    begin="0.74s"
                    repeatCount="indefinite"
                    path={g.d}
                  />
                </circle>
              </>
            )}
            {/* Endpoints */}
            <circle data-e="src" cx={g.src.x} cy={g.src.y} r={3} style={{ fill: "var(--primary)" }} />
            {/* Target dot (kept alongside the arrowhead for a pro combo) */}
            <circle
              data-e="tgt"
              cx={g.tgt.x}
              cy={g.tgt.y}
              r={4.2}
              style={{
                fill: "var(--background)",
                stroke: highlighted
                  ? "var(--primary)"
                  : "color-mix(in oklab, var(--primary) 70%, transparent)",
              }}
              strokeWidth={2}
            />
            {/* Hover label: fromPort → toPort at the midpoint, with a subtle bg rect. */}
            {isHovered && (
              <g
                transform={`translate(${g.mid.x}, ${g.mid.y})`}
                className="pointer-events-none"
              >
                <rect
                  x={-labelW / 2}
                  y={-labelH / 2}
                  width={labelW}
                  height={labelH}
                  className="edge-label-bg"
                />
                <text
                  x={0}
                  y={0}
                  className="edge-label-text"
                >
                  {portLabel}
                </text>
              </g>
            )}
            {/* Delete chip when hovered (offset below midpoint so it
                doesn't overlap the port label that sits at the midpoint). */}
            {isHovered && (
              <g
                className="pointer-events-auto cursor-pointer"
                transform={`translate(${g.mid.x}, ${g.mid.y + 18})`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(edge);
                }}
                onPointerEnter={() => setHoveredId(g.id)}
              >
                <circle
                  r={9}
                  style={{ fill: "var(--background)", stroke: "var(--destructive)" }}
                  strokeWidth={1.5}
                />
                <path
                  d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5"
                  style={{ stroke: "var(--destructive)" }}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Local cn helper (avoids importing cn into the SVG scope where it isn't needed elsewhere).
function cnEdges(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export const EdgesLayer = React.memo(EdgesLayerImpl);
