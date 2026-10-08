"use client";
import * as React from "react";
import { Search, X } from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { NodeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CARD_W, CARD_H } from "@/lib/workflow-catalog";
import { deriveSweepGroups } from "@/components/canvas/sweep-group-card";

export function NodeSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<NodeDTO[]>([]);
  const [highlighted, setHighlighted] = React.useState(0);
  const workflow = useAppStore((s) => s.workflow);
  const collapsedSweepGroups = useAppStore((s) => s.collapsedSweepGroups);
  const select = useAppStore((s) => s.select);
  const inspect = useAppStore((s) => s.inspect);
  const setViewport = useAppStore((s) => s.setViewport);

  // Search nodes by name, type, or status. Members of a COLLAPSED sweep
  // group are hidden behind their aggregate card — searching (and jumping)
  // to an invisible card is confusing, so they're filtered out (E3).
  React.useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    const nodes = workflow?.nodes ?? [];
    let hidden: Set<string> | null = null;
    if (collapsedSweepGroups.length > 0) {
      hidden = new Set();
      for (const g of deriveSweepGroups(nodes).values()) {
        if (collapsedSweepGroups.includes(g.groupId)) {
          for (const m of g.members) hidden.add(m.id);
        }
      }
    }
    const q = query.toLowerCase();
    const matched = nodes.filter(
      (n) =>
        !(hidden?.has(n.id) ?? false) &&
        (n.name.toLowerCase().includes(q) ||
          n.type.toLowerCase().includes(q) ||
          n.status.toLowerCase().includes(q)),
    );
    setResults(matched);
    setHighlighted(0);
  }, [query, workflow, collapsedSweepGroups]);

  // Navigate to a node: center it in the viewport + select it. The CURRENT
  // zoom is preserved (it used to hard-reset to 1, yanking the user from a
  // comfortable zoom level to 100% on every search jump) — only the pan
  // (x/y) is recentered around the node.
  const navigateToNode = React.useCallback(
    (node: NodeDTO) => {
      select(node.id);
      inspect(node.id);
      // Center the node in the viewport
      const canvasEl = document.querySelector('[data-canvas="viewport"]');
      const w = canvasEl?.clientWidth ?? 900;
      const h = canvasEl?.clientHeight ?? 600;
      const zoom = useAppStore.getState().viewport.zoom;
      setViewport({
        x: Math.round(w / 2 - (node.x + CARD_W / 2) * zoom),
        y: Math.round(h / 2 - (node.y + CARD_H / 2) * zoom),
      });
      onClose();
    },
    [inspect, onClose, select, setViewport],
  );

  // Keyboard: Enter selects highlighted, ArrowDown/Up navigates, Esc closes
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && results[highlighted]) {
      e.preventDefault();
      void navigateToNode(results[highlighted]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="absolute left-1/2 top-3 z-30 w-80 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-lg border bg-card/90 shadow-lg backdrop-blur-sm">
        <Search className="ml-3 size-4 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search nodes by name, type, or status..."
          className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onClose}
          className="mr-2 text-muted-foreground hover:text-foreground"
          aria-label="Close node search"
        >
          <X className="size-4" />
        </button>
      </div>
      {results.length > 0 && (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-lg border bg-card shadow-lg">
          {results.map((n, i) => (
            <button
              key={n.id}
              type="button"
              onClick={() => void navigateToNode(n)}
              onMouseEnter={() => setHighlighted(i)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                i === highlighted && "bg-accent",
              )}
            >
              <span
                className="size-2 rounded-full"
                style={{ background: statusColor(n.status) }}
                aria-hidden
              />
              <span className="font-medium">{n.name}</span>
              <span className="text-xs text-muted-foreground">{n.type}</span>
            </button>
          ))}
        </div>
      )}
      {query && results.length === 0 && (
        <div className="mt-1 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground shadow-lg">
          No matching nodes.
        </div>
      )}
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#10b981";
    case "failed":
      return "#ef4444";
    case "running":
      return "#14b8a6";
    case "pending":
      return "#f59e0b";
    default:
      return "#94a3b8";
  }
}
