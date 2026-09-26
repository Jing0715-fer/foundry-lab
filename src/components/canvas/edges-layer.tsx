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
      {geoms.map((g) => {
        const edge = edges.find((e) => e.id === g.id);
        if (!edge) return null;
        const fromNode = nodeById.get(edge.fromNodeId);
        const isRunning = fromNode?.status === "running";
        const isHovered = hoveredId === g.id;
        const isSelected = selectedIds.includes(edge.id);
        const highlighted = isHovered || isSelected || isRunning;

        const stroke = highlighted ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.55)";
        const strokeWidth = isHovered ? 3.2 : 2.25;

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
              className={isRunning ? "edge-flow" : undefined}
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
            <circle
              cx={g.tgt.x}
              cy={g.tgt.y}
              r={4.2}
              fill="hsl(var(--background))"
              stroke="hsl(var(--primary))"
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

export const EdgesLayer = React.memo(EdgesLayerImpl);
