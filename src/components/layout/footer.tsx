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

/** API health, actually probed — "checking" until the first GET /api lands. */
type ApiHealth = "checking" | "ok" | "down";

/**
 * Thin status footer.
 * - Left: API health pill (probed via GET /api — the app's health route —
 *   once on mount, then every 60s and on tab re-focus; NO claims about the
 *   LLM gateway or anything else this check can't see), then workflow name
 *   + node/edge counts, or "Loading…" when no workflow yet.
 * - Right: keyboard shortcuts hint (hidden on small screens).
 * - mt-auto ensures the footer sticks to the bottom of its flex-col parent.
 * - fade-in-up entrance + kbd class for consistent keyboard-key styling.
 */
export function Footer() {
  const workflow = useAppStore((s) => s.workflow);
  const loading = useAppStore((s) => s.loading);

  const [health, setHealth] = React.useState<ApiHealth>("checking");

  // Probe GET /api — cheap (a JSON health row), so a 60s interval while the
  // tab is open plus a refresh on visibilitychange is plenty. The pill used
  // to be a hardcoded "All systems operational" emerald dot that lied
  // whenever the backend was actually down.
  React.useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const res = await fetch("/api", { cache: "no-store" });
        if (!cancelled) setHealth(res.ok ? "ok" : "down");
      } catch {
        if (!cancelled) setHealth("down");
      }
    };
    void ping();
    const iv = setInterval(() => void ping(), 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void ping();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const nodeCount = workflow?.nodes.length ?? 0;
  const edgeCount = workflow?.edges.length ?? 0;

  // Pill styling per state — emerald only when the probe actually passed.
  const pill =
    health === "ok"
      ? {
          cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          dot: "bg-emerald-500",
          ping: "bg-emerald-500/60",
          text: "All systems operational",
          title: "GET /api health check passed",
        }
      : health === "down"
        ? {
            cls: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
            dot: "bg-rose-500",
            ping: "bg-rose-500/60",
            text: "API unreachable",
            title: "GET /api health check failed — the backend may be down",
          }
        : {
            cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            dot: "bg-amber-500",
            ping: "bg-amber-500/60",
            text: "Checking API…",
            title: "Probing GET /api…",
          };

  return (
    <footer className="fade-in-up mt-auto flex h-8 shrink-0 items-center justify-between border-t bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        {/* System status indicator — honest (probed, not hardcoded). */}
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${pill.cls}`}
          title={pill.title}
        >
          <span className="relative flex size-1.5">
            {/* subtle ping halo */}
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full ${pill.ping}`}
            />
            <span
              className={`relative inline-flex size-1.5 rounded-full ${pill.dot}`}
            />
          </span>
          {pill.text}
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
