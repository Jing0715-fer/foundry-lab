"use client";

import * as React from "react";
import { useAppStore } from "@/lib/store";

/**
 * Thin status footer.
 * - Left: workflow node count, or "Loading…" when no workflow yet.
 * - Right: keyboard shortcuts hint (hidden on small screens).
 */
export function Footer() {
  const workflow = useAppStore((s) => s.workflow);
  const loading = useAppStore((s) => s.loading);

  const nodeCount = workflow?.nodes.length ?? 0;
  const edgeCount = workflow?.edges.length ?? 0;

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t bg-background px-4 text-xs text-muted-foreground">
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
      <div className="hidden lg:flex items-center gap-3">
        <span>
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Shift+drag
          </kbd>{" "}
          = select
        </span>
        <span className="opacity-40">•</span>
        <span>
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Double-click
          </kbd>{" "}
          = add node
        </span>
        <span className="opacity-40">•</span>
        <span>
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Del
          </kbd>{" "}
          = delete
        </span>
        <span className="opacity-40">•</span>
        <span>
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Esc
          </kbd>{" "}
          = cancel
        </span>
      </div>
    </footer>
  );
}
