"use client";

import * as React from "react";
import { Keyboard } from "lucide-react";
import { useAppStore } from "@/lib/store";

const KBD_CLASS =
  "rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground";

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
 * - Left: workflow node count, or "Loading…" when no workflow yet.
 * - Right: keyboard shortcuts hint (hidden on small screens).
 * - mt-auto ensures the footer sticks to the bottom of its flex-col parent.
 */
export function Footer() {
  const workflow = useAppStore((s) => s.workflow);
  const loading = useAppStore((s) => s.loading);

  const nodeCount = workflow?.nodes.length ?? 0;
  const edgeCount = workflow?.edges.length ?? 0;

  return (
    <footer className="mt-auto flex h-8 shrink-0 items-center justify-between border-t bg-background px-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 truncate">
        {loading || !workflow ? (
          <span>Loading…</span>
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
