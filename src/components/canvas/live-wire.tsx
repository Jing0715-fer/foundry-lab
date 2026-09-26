"use client";

import React from "react";
import type { NodeDTO } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { nodeSpec, CARD_W, portY } from "@/lib/workflow-catalog";
import { bezierPath } from "@/lib/canvas-utils";

/**
 * Pending-connection wire. Renders an SVG overlay filling the canvas section
 * (its parent must be position: relative) and draws a dashed bezier from the
 * pending port's anchor to the current mouse position. ESC cancels.
 *
 * Coordinates are in CSS pixels relative to the canvas section. The anchor is
 * computed in workspace coords then transformed by the current viewport so it
 * tracks pan/zoom.
 */
export function LiveWire({ nodes }: { nodes: NodeDTO[] }) {
  const pendingFrom = useAppStore((s) => s.pendingFrom);
  const viewport = useAppStore((s) => s.viewport);
  const cancelConnect = useAppStore((s) => s.cancelConnect);

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [mouse, setMouse] = React.useState<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!pendingFrom) {
      setMouse(null);
      return;
    }
    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelConnect();
    };
    // Initialize mouse to the anchor so the wire doesn't snap from origin.
    const svg = svgRef.current;
    if (svg) {
      // no-op; just ensures ref is set on mount.
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [pendingFrom, cancelConnect]);

  if (!pendingFrom) return null;

  const node = nodes.find((n) => n.id === pendingFrom.nodeId);
  if (!node) return null;
  const spec = nodeSpec(node.type);
  const ports = pendingFrom.dir === "out" ? spec?.outputs : spec?.inputs;
  if (!ports || ports.length === 0) return null;
  const idx = ports.findIndex((p) => p.name === pendingFrom.port);
  if (idx < 0) return null;
  const count = ports.length;

  // Workspace-coordinate anchor.
  const wx = pendingFrom.dir === "out" ? node.x + CARD_W : node.x;
  const wy = node.y + portY(idx, count);
  // Transform to canvas-section-local CSS pixels.
  const ax = wx * viewport.zoom + viewport.x;
  const ay = wy * viewport.zoom + viewport.y;

  const mx = mouse?.x ?? ax;
  const my = mouse?.y ?? ay;

  const { d } = bezierPath({ x: ax, y: ay }, { x: mx, y: my });

  return (
    <svg
      ref={svgRef}
      className="pointer-events-none absolute inset-0 z-20"
      width="100%"
      height="100%"
    >
      <path
        d={d}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
        strokeDasharray="6 4"
        opacity={0.8}
      />
      <circle cx={ax} cy={ay} r={3.5} fill="hsl(var(--primary))" />
      <circle cx={mx} cy={my} r={3} fill="hsl(var(--primary))" opacity={0.6} />
    </svg>
  );
}
