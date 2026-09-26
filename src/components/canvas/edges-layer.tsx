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
 *  - Running source: gradient stroke + animated particles (animateMotion).
 *  - Completed → pending: subtle teal gradient.
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
  const gradRunId = `grad-run-${uid}`;
  const gradDoneId = `grad-done-${uid}`;

  return (
    <svg
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
            fill="hsl(var(--muted-foreground))"
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
          <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary))" />
        </marker>
        {/* Gradient for running source edges. */}
        <linearGradient id={gradRunId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="hsl(var(--primary) / 0.35)" />
          <stop offset="50%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--primary) / 0.35)" />
        </linearGradient>
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
        const isSelected = selectedIds.includes(edge.id);
        const highlighted = isHovered || isSelected;

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
          stroke = "hsl(var(--primary))";
          strokeWidth = 3;
          markerEnd = `url(#${arrowSelId})`;
        } else {
          stroke = "hsl(var(--border))";
          strokeWidth = 2;
          markerEnd = `url(#${arrowId})`;
        }

        // Drop-shadow on hovered edges for depth.
        const filterClass = highlighted ? "edge-glow" : undefined;

        return (
          <g key={g.id}>
            {/* Invisible hit area */}
            <path
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
              d={g.d}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              markerEnd={markerEnd}
              className={cnEdges(className, filterClass)}
            />
            {/* Running dashes: travelling dots via animateMotion */}
            {isRunning && (
              <>
                <circle r={2.6} fill="hsl(var(--primary))">
                  <animateMotion dur="1.1s" repeatCount="indefinite" path={g.d} />
                </circle>
                <circle r={2.6} fill="hsl(var(--primary) / 0.55)">
                  <animateMotion
                    dur="1.1s"
                    begin="0.55s"
                    repeatCount="indefinite"
                    path={g.d}
                  />
                </circle>
              </>
            )}
            {/* Endpoints */}
            <circle cx={g.src.x} cy={g.src.y} r={3} fill="hsl(var(--primary))" />
            {/* Target dot (kept alongside the arrowhead for a pro combo) */}
            <circle
              cx={g.tgt.x}
              cy={g.tgt.y}
              r={4.2}
              fill="hsl(var(--background))"
              stroke={highlighted ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.7)"}
              strokeWidth={2}
            />
            {/* Delete chip when hovered */}
            {isHovered && (
              <g
                className="pointer-events-auto cursor-pointer"
                transform={`translate(${g.mid.x}, ${g.mid.y})`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(edge);
                }}
                onPointerEnter={() => setHoveredId(g.id)}
              >
                <circle
                  r={9}
                  fill="hsl(var(--background))"
                  stroke="hsl(var(--destructive))"
                  strokeWidth={1.5}
                />
                <path
                  d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5"
                  stroke="hsl(var(--destructive))"
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
