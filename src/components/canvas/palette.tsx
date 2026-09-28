"use client";

import * as React from "react";
import {
  Bot,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Boxes,
  Database,
  ArrowRightToLine,
  Flag,
  Box,
  ChevronDown,
  ChevronRight,
  Search,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  NODE_SPECS,
  NODE_COLORS,
  nodeSpec,
} from "@/lib/workflow-catalog";
import type { NodeSpec } from "@/lib/types";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Render the lucide icon for a spec.icon string. */
function SpecIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  switch (name) {
    case "bot":
      return <Bot className={className} />;
    case "square-pen":
      return <SquarePen className={className} />;
    case "users":
      return <Users className={className} />;
    case "book-open":
      return <BookOpen className={className} />;
    case "cpu":
      return <Cpu className={className} />;
    case "boxes":
      return <Boxes className={className} />;
    case "database":
      return <Database className={className} />;
    case "arrow-right-to-line":
      return <ArrowRightToLine className={className} />;
    case "flag":
      return <Flag className={className} />;
    default:
      return <Box className={className} />;
  }
}

/** Group specs by category, preserving NODE_SPECS order. */
function groupByCategory(specs: NodeSpec[]): { category: string; items: NodeSpec[] }[] {
  const out: { category: string; items: NodeSpec[] }[] = [];
  const idx = new Map<string, number>();
  for (const s of specs) {
    const i = idx.get(s.category);
    if (i === undefined) {
      idx.set(s.category, out.length);
      out.push({ category: s.category, items: [s] });
    } else {
      out[i].items.push(s);
    }
  }
  return out;
}

/** Find a free spot on the canvas for a new node (avoids overlapping existing nodes). */
function findFreeSpot(
  existing: { x: number; y: number }[],
  centerX: number,
  centerY: number,
): { x: number; y: number } {
  const CARD_W = 248;
  const CARD_H = 116;
  const PAD = 40;
  if (existing.length === 0) return { x: centerX, y: centerY };
  // Try the center first, then a spiral of expanding positions.
  const candidates: { x: number; y: number }[] = [{ x: centerX, y: centerY }];
  for (let ring = 1; ring <= 6; ring++) {
    const step = CARD_W + PAD;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        candidates.push({
          x: centerX + dx * step,
          y: centerY + dy * (CARD_H + PAD),
        });
      }
    }
  }
  const overlaps = (c: { x: number; y: number }) =>
    existing.some(
      (e) =>
        Math.abs(e.x - c.x) < CARD_W + PAD * 0.5 &&
        Math.abs(e.y - c.y) < CARD_H + PAD * 0.5,
    );
  for (const c of candidates) {
    if (!overlaps(c)) return { x: Math.round(c.x), y: Math.round(c.y) };
  }
  return { x: Math.round(centerX + 40), y: Math.round(centerY + 40) };
}

/** Drop a new node at the approximate viewport center, avoiding existing nodes. */
async function createNodeAtCenter(spec: NodeSpec): Promise<void> {
  const { viewport, workflow, upsertNode, toast } = useAppStore.getState();
  // Compute visible center in world coords.
  const canvasEl = document.querySelector('[data-canvas="viewport"]');
  const w = canvasEl?.getBoundingClientRect().width ?? 900;
  const h = canvasEl?.getBoundingClientRect().height ?? 600;
  const centerX = (viewport.x + w / 2) / viewport.zoom - 124;
  const centerY = (viewport.y + h / 2) / viewport.zoom - 58;
  const existing = (workflow?.nodes ?? []).map((n) => ({ x: n.x, y: n.y }));
  const { x, y } = findFreeSpot(existing, centerX, centerY);
  try {
    const res = await fetch("/api/workflow/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: spec.type,
        name: spec.label,
        x,
        y,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const node = await res.json();
    upsertNode(node);
    useAppStore.getState().select(node.id);
    useAppStore.getState().inspect(node.id);
    useAppStore.getState().toast({
      title: "Node added",
      description: `${spec.label} added to canvas`,
      variant: "success",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast({
      title: "Couldn't add node",
      description: msg,
      variant: "destructive",
    });
  }
}

/** One palette row. Draggable + click-to-add. */
const PaletteItem = React.memo(function PaletteItem({
  spec,
  query,
}: {
  spec: NodeSpec;
  query: string;
}) {
  const color = NODE_COLORS[spec.color as keyof typeof NODE_COLORS] ?? NODE_COLORS.slate;

  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData("application/node-type", spec.type);
    e.dataTransfer.effectAllowed = "copy";
  };

  // Highlight the part of label/description matching the query.
  const highlight = (text: string) => {
    if (!query) return text;
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark className="bg-yellow-200/70 dark:bg-yellow-500/40 rounded-sm px-0.5">
          {text.slice(i, i + query.length)}
        </mark>
        {text.slice(i + query.length)}
      </>
    );
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={() => createNodeAtCenter(spec)}
      className="group flex w-full items-start gap-2.5 rounded-lg border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-accent/60 cursor-grab active:cursor-grabbing"
      title={`Drag onto canvas, or click to add · ${spec.label}`}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
          color.soft,
          color.border,
          color.text,
        )}
      >
        <SpecIcon name={spec.icon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{highlight(spec.label)}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground">
          {highlight(spec.description)}
        </div>
      </div>
    </button>
  );
});

/** A collapsible category section. */
function CategorySection({
  category,
  items,
  query,
}: {
  category: string;
  items: NodeSpec[];
  query: string;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border/60 last:border-b-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/50"
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span>{category}</span>
          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
            {items.length}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-1 gap-0.5 px-2 pb-2">
          {items.map((spec) => (
            <PaletteItem key={spec.type} spec={spec} query={query} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The left-column node palette. */
export function NodePalette() {
  const query = useAppStore((s) => s.paletteQuery);
  const setQuery = useAppStore((s) => s.setPaletteQuery);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NODE_SPECS;
    return NODE_SPECS.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.type.toLowerCase().includes(q),
    );
  }, [query]);

  const groups = React.useMemo(() => groupByCategory(filtered), [filtered]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-background">
      <header className="flex flex-col gap-2 border-b p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Nodes</h2>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {filtered.length}/{NODE_SPECS.length}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            className="h-8 pl-8 text-sm"
            aria-label="Search palette"
          />
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          {groups.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No nodes match “{query}”.
            </div>
          ) : (
            groups.map((g) => (
              <CategorySection
                key={g.category}
                category={g.category}
                items={g.items}
                query={query.trim()}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <footer className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Drag onto canvas · click to add
      </footer>
    </aside>
  );
}

// Re-export for callers that want a synchronous lookup (no extra fetch).
export { nodeSpec };
