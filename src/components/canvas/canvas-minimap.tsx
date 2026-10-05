"use client";

import * as React from "react";
import { create } from "zustand";
import { X } from "lucide-react";

import { useAppStore } from "@/lib/store";
import { CARD_W, CARD_H, nodeSpec } from "@/lib/workflow-catalog";
import { contentBox } from "@/lib/canvas-utils";
import type { EdgeDTO, NodeDTO } from "@/lib/types";

/**
 * useMinimapStore — tiny zustand store that lets the toolbar toggle button and
 * the WorkflowCanvas share minimap open/closed state without touching the
 * foundation `useAppStore`.
 */
interface MinimapState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  open_: () => void;
}
export const useMinimapStore = create<MinimapState>((set) => ({
  open: true,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
  open_: () => set({ open: true }),
}));

// Status → hex fill (must be inline styles — Tailwind v4 preflight resets SVG
// fill/stroke to none for unstyled elements).
const STATUS_HEX: Record<NodeDTO["status"], string> = {
  idle: "#94a3b8", // slate-400
  pending: "#fbbf24", // amber-400
  running: "#14b8a6", // teal-500
  completed: "#10b981", // emerald-500
  failed: "#f43f5e", // rose-500
};

const MINI_W = 180;
const MINI_H = 120;

/**
 * CanvasMinimap — a bird's-eye overview of the whole workflow, docked in the
 * bottom-right corner of the canvas viewport. Clicking inside it re-centers
 * the canvas viewport on the clicked world point.
 *
 * Rendered as a sibling of the workspace inside WorkflowCanvas so it sits on
 * top of the canvas (z-20) and scales correctly relative to the canvas area
 * rather than the page.
 */
export function CanvasMinimap({ onClose }: { onClose: () => void }) {
  const workflow = useAppStore((s) => s.workflow);
  const viewport = useAppStore((s) => s.viewport);
  const setViewport = useAppStore((s) => s.setViewport);
  const select = useAppStore((s) => s.select);

  const nodes = workflow?.nodes ?? [];
  const edges = workflow?.edges ?? [];

  // Compute the world-space content box (with the large padding baked into
  // contentBox — gives breathing room so nodes near the edges don't touch the
  // minimap border).
  const box = React.useMemo(() => contentBox(nodes), [nodes]);

  // Scale: fit the content box inside the minimap, preserving aspect ratio.
  // Clamp to a sane minimum so an empty canvas doesn't blow up to Infinity.
  const scale = React.useMemo(() => {
    const sx = MINI_W / Math.max(1, box.w);
    const sy = MINI_H / Math.max(1, box.h);
    return Math.min(sx, sy);
  }, [box.w, box.h]);

  // The SVG viewBox matches the world content box (1:1 with world units), and
  // the SVG itself is sized MINI_W × MINI_H. Using a viewBox lets the browser
  // scale world coords down to minimap pixels automatically — no manual
  // multiplication per shape.
  const viewBox = `${box.x} ${box.y} ${box.w} ${box.h}`;

  // Compute the current viewport frame in world coords:
  //   visibleWorld = (screen - viewport.xy) / zoom
  // The visible width/height in world units = canvasSize / zoom.
  // We grab canvasSize from the [data-canvas="viewport"] element on click; for
  // rendering the frame we use the live canvas element size if available.
  const canvasElRef = React.useRef<HTMLElement | null>(null);
  const [canvasSize, setCanvasSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });

  React.useEffect(() => {
    // Find the canvas viewport element (it's the parent's parent of the minimap
    // because the minimap itself sits inside WorkflowCanvas's <section>).
    const find = () => {
      const el = document.querySelector('[data-canvas="viewport"]') as HTMLElement | null;
      canvasElRef.current = el;
      if (el) {
        setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
      }
    };
    find();
    // Observe size changes.
    const ro = new ResizeObserver(() => find());
    const el = document.querySelector('[data-canvas="viewport"]') as HTMLElement | null;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleW = canvasSize.w > 0 ? canvasSize.w / viewport.zoom : 0;
  const visibleH = canvasSize.h > 0 ? canvasSize.h / viewport.zoom : 0;
  const visibleX = -viewport.x / viewport.zoom;
  const visibleY = -viewport.y / viewport.zoom;

  // Click handler: convert minimap-pixel coords → world coords, then set the
  // viewport so that world point lands at the canvas center.
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    const canvasEl = canvasElRef.current ?? (document.querySelector('[data-canvas="viewport"]') as HTMLElement | null);
    if (!svg || !canvasEl) return;
    // The SVG viewBox maps directly to world coords, so we can use the DOM
    // point → SVG point conversion via getScreenCTM.
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const worldPt = pt.matrixTransform(ctm.inverse());
    const worldX = worldPt.x;
    const worldY = worldPt.y;
    const cw = canvasEl.clientWidth;
    const ch = canvasEl.clientHeight;
    // Center the world point in the canvas viewport.
    setViewport({
      x: cw / 2 - worldX * viewport.zoom,
      y: ch / 2 - worldY * viewport.zoom,
    });
    // Don't change zoom — keep the user's current zoom level.
  };

  // If a node is clicked directly, select it (instead of recentering). We do
  // this by stopping propagation on the node <rect>.
  const onNodeClick = (e: React.MouseEvent<SVGRectElement>, id: string) => {
    e.stopPropagation();
    select(id);
  };

  return (
    <div
      // Mobile: the toolbar row (bottom-left) is wide on narrow screens, so
      // the minimap lifts above it (bottom-16) to avoid overlapping; on md+
      // it sits level with the toolbar again.
      className="absolute bottom-16 right-3 z-20 rounded-lg border bg-card/90 shadow-lg backdrop-blur-sm md:bottom-3"
      // Prevent the minimap from triggering canvas pan/zoom handlers.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Minimap
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close minimap"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <svg
        ref={svgRef}
        width={MINI_W}
        height={MINI_H}
        viewBox={viewBox}
        className="block cursor-pointer"
        onClick={handleClick}
        style={{ background: "hsl(var(--muted) / 0.4)" }}
      >
        {/* Edges (drawn first so they sit under the node rects). */}
        {edges.map((edge: EdgeDTO) => {
          const from = nodes.find((n) => n.id === edge.fromNodeId);
          const to = nodes.find((n) => n.id === edge.toNodeId);
          if (!from || !to) return null;
          const x1 = from.x + CARD_W;
          const y1 = from.y + CARD_H / 2;
          const x2 = to.x;
          const y2 = to.y + CARD_H / 2;
          return (
            <line
              key={edge.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              style={{ stroke: "hsl(var(--border))", strokeWidth: 8 / Math.max(scale, 0.01) }}
            />
          );
        })}

        {/* Nodes (scaled CARD_W × CARD_H rects colored by status). */}
        {nodes.map((n: NodeDTO) => {
          const spec = nodeSpec(n.type);
          const fill = STATUS_HEX[n.status] ?? STATUS_HEX.idle;
          return (
            <rect
              key={n.id}
              x={n.x}
              y={n.y}
              width={CARD_W}
              height={CARD_H}
              rx={10}
              style={{ fill, stroke: "hsl(var(--background))", strokeWidth: 6 / Math.max(scale, 0.01) }}
              onClick={(e) => onNodeClick(e, n.id)}
            >
              {/* Browser-native tooltip with the node name + spec label. */}
              <title>{`${n.name || spec?.label || n.type}\n${n.status}`}</title>
            </rect>
          );
        })}

        {/* Current viewport frame (highlighted rect). */}
        {visibleW > 0 && visibleH > 0 && (
          <rect
            x={visibleX}
            y={visibleY}
            width={visibleW}
            height={visibleH}
            rx={6}
            style={{
              fill: "color-mix(in oklch, var(--primary) 12%, transparent)",
              stroke: "hsl(var(--primary))",
              strokeWidth: 8 / Math.max(scale, 0.01),
              strokeDasharray: `${16 / Math.max(scale, 0.01)} ${10 / Math.max(scale, 0.01)}`,
              pointerEvents: "none",
            }}
          />
        )}
      </svg>
    </div>
  );
}
