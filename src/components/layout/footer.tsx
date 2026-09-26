"use client";

import * as React from "react";
import { Keyboard } from "lucide-react";
import { useAppStore } from "@/lib/store";

const KBD_CLASS =
  "kbd rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow-sm";

interface Shortcut {
  keys: string;
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "Shift+drag", label: "select" },
  { keys: "Double-click", label: "add node" },
  { keys: "Del", label: "delete" },
  { keys: "Esc", label: "cancel" },
];

/**
 * Thin status footer.
 * - Left: "All systems operational" status pill, then workflow node count, or
 *   "Loading…" when no workflow yet.
 * - Right: keyboard shortcuts hint (hidden on small screens).
 * - mt-auto ensures the footer sticks to the bottom of its flex-col parent.
 * - fade-in-up entrance + kbd class for consistent keyboard-key styling.
 */
export function Footer() {
  const workflow = useAppStore((s) => s.workflow);
  const loading = useAppStore((s) => s.loading);

  const nodeCount = workflow?.nodes.length ?? 0;
  const edgeCount = workflow?.edges.length ?? 0;

  return (
    <footer className="fade-in-up mt-auto flex h-8 shrink-0 items-center justify-between border-t bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        {/* System status indicator */}
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
          title="Backend API + LLM gateway reachable"
        >
          <span className="relative flex size-1.5">
            {/* subtle ping halo */}
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          All systems operational
        </span>

        {loading || !workflow ? (
          <span className="truncate">Loading…</span>
        ) : (
          <span className="truncate">
            <span className="font-medium text-foreground">{workflow.name}</span>
            <span className="mx-2 opacity-40">•</span>
            <span>{nodeCount} nodes</span>
            <span className="mx-2 opacity-40">•</span>
            <span>{edgeCount} edges</span>
          </span>
        )}
      </div>
      <div className="hidden items-center gap-3 lg:flex">
        <Keyboard className="size-3.5 text-muted-foreground" />
        {SHORTCUTS.map((s, i) => (
          <React.Fragment key={s.keys}>
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>{s.keys}</kbd>
              <span className="text-muted-foreground">{s.label}</span>
            </span>
            {i < SHORTCUTS.length - 1 && (
              <span className="opacity-40" aria-hidden>
                •
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    </footer>
  );
}
