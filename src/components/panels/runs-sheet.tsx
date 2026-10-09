"use client";

// Global Runs sheet (B4: run-queue visualization).
//
// Cross-workflow execution view, opened from the header's Runs button:
//   - Running & Queued: live progress bars per node (+ its workflow), polled
//     every 3s while the sheet is open.
//   - Failed (last 48h): each row has Retry → POST /api/workflow/nodes/:id/run
//     (single-node lane: claims the terminal node conditionally and cascades
//     downstream whose upstreams are completed).
//   - Recent (last 48h): terminal runs with duration.
//
// Row click → loads that workflow (switcher contract: fetch by id →
// setWorkflow), selects the node, jumps to the canvas.

import * as React from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  ListVideo,
  Loader2,
  RotateCw,
  Square,
  TriangleAlert,
} from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  FAILURE_META,
  type FailureReason,
} from "@/lib/failure-reason";
import type { WorkflowDTO } from "@/lib/types";

interface RunRow {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  workflow: { id: string; name: string } | null;
  /** F1: failure lane classification (failed rows only). */
  failureReason?: FailureReason;
}

interface RunsPayload {
  active: RunRow[];
  failed: RunRow[];
  recent: RunRow[];
  summary: {
    running: number;
    queued: number;
    failed: number;
    completedInWindow: number;
  };
}

const POLL_MS = 3000;

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function durationOf(r: RunRow): number | null {
  if (!r.startedAt || !r.completedAt) return null;
  return new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
}

function Row({
  run,
  trailing,
  onClick,
}: {
  run: RunRow;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  // div[role=button] (NOT a <button>): rows carry a Retry <Button> in
  // `trailing`, and HTML forbids nesting interactive elements.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${run.name} — ${run.status}. Activate to open on the canvas.`}
      onClick={onClick}
      onKeyDown={(e) => {
        // P1-1 (restored from the parallel C+E line): only activate the ROW
        // when the row itself is focused — a focused Stop/Retry button's
        // Enter/Space must activate the button, not bubble here (which
        // preventDefault-kills the button AND mis-navigates the canvas).
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-transparent p-2.5 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          run.status === "running"
            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            : run.status === "pending"
              ? "bg-slate-500/15 text-slate-600 dark:text-slate-400"
              : run.status === "failed"
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        )}
      >
        {run.status === "running" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : run.status === "pending" ? (
          <CircleDashed className="size-4" />
        ) : run.status === "failed" ? (
          <TriangleAlert className="size-4" />
        ) : (
          <CheckCircle2 className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
            {run.name}
          </span>
          {run.status === "failed" && run.failureReason && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                FAILURE_META[run.failureReason].pillClass,
              )}
              title={FAILURE_META[run.failureReason].description}
              data-failure-pill={run.failureReason}
            >
              {FAILURE_META[run.failureReason].label}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {run.workflow?.name ?? "—"} · started {timeAgo(run.startedAt)}
        </span>
        {run.status === "running" && (
          <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-amber-500 transition-[width]"
              style={{ width: `${Math.max(4, Math.min(100, run.progress))}%` }}
            />
          </span>
        )}
        {run.status !== "running" && run.status !== "pending" && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {fmtDuration(durationOf(run))}
          </span>
        )}
      </span>
      {trailing}
    </div>
  );
}

export function RunsSheet() {
  const open = useAppStore((s) => s.runsSheetOpen);
  const setRunsSheetOpen = useAppStore((s) => s.setRunsSheetOpen);
  const toast = useAppStore((s) => s.toast);
  const [data, setData] = React.useState<RunsPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retryingId, setRetryingId] = React.useState<string | null>(null);
  const [stoppingIds, setStoppingIds] = React.useState<string[]>([]);
  const [stoppingAll, setStoppingAll] = React.useState(false);

  // Poll while the sheet is open (3s), stop on close.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload: RunsPayload = await res.json();
        if (alive) {
          setData(payload);
          setLoadError(null);
        }
      } catch (e) {
        // Keep the last good payload; surface an error only when we never
        // loaded anything (otherwise a transient poll failure isn't worth
        // a toast storm at 3s cadence).
        if (alive && !data) {
          setLoadError(e instanceof Error ? e.message : "network error");
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [open]);

  // E2: the retry spinner covers only the CLAIM phase. The retry POST awaits
  // the node's FULL execution (plus the downstream cascade), so holding the
  // spinner for the whole run would spin for minutes; once a 3s poll observes
  // the node left the failed lane, the cadence owns presentation and the
  // button un-locks. (The background fetch still toasts on a failed claim.)
  React.useEffect(() => {
    if (!retryingId || !data) return;
    const row = [...data.active, ...data.failed, ...data.recent].find(
      (r) => r.nodeId === retryingId,
    );
    if (row && row.status !== "failed") setRetryingId(null);
  }, [data, retryingId]);

  // Jump to a run's workflow + node on the canvas.
  const jumpTo = React.useCallback(
    async (run: RunRow) => {
      if (!run.workflow) return;
      try {
        const res = await fetch(`/api/workflows/${run.workflow.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const wf: WorkflowDTO = await res.json();
        useAppStore.getState().setWorkflow(wf);
        useAppStore.getState().setActivePanel("canvas");
        useAppStore.getState().select(run.nodeId);
        useAppStore.getState().inspect(run.nodeId);
        setRunsSheetOpen(false);
      } catch (e) {
        toast({
          title: "Couldn't open workflow",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      }
    },
    [setRunsSheetOpen, toast],
  );

  // Retry a failed node via the single-node run lane (claims terminal
  // nodes conditionally + BFS-cascades completed-upstream descendants).
  // E2 fire-and-forget: the toast is immediate, the POST runs in the
  // background, and the 3s poll flips the row to running/queued.
  const retry = React.useCallback(
    (run: RunRow) => {
      setRetryingId(run.nodeId);
      toast({
        title: "Retry started",
        description: `${run.name} is running again`,
      });
      void (async () => {
        try {
          const res = await fetch(`/api/workflow/nodes/${run.nodeId}/run`, {
            method: "POST",
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          // The run lane finished — reconcile the row into Recent.
          const fresh = await fetch("/api/runs");
          if (fresh.ok) setData(await fresh.json());
        } catch (e) {
          toast({
            title: "Retry failed",
            description: e instanceof Error ? e.message : "Unknown error",
            variant: "destructive",
          });
        } finally {
          setRetryingId(null);
        }
      })();
    },
    [toast],
  );

  // E4: stop one active node (running or queued) — POST /stop marks it
  // failed with a user-stop trace; late engine results are discarded by the
  // conditional persist in every execution lane.
  const stop = React.useCallback(
    async (run: RunRow) => {
      setStoppingIds((ids) => (ids.includes(run.nodeId) ? ids : [...ids, run.nodeId]));
      try {
        const res = await fetch(`/api/workflow/nodes/${run.nodeId}/stop`, {
          method: "POST",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        toast({
          title: "Stopped",
          description: `${run.name} marked failed (stopped by user)`,
          variant: "success",
        });
        const fresh = await fetch("/api/runs");
        if (fresh.ok) setData(await fresh.json());
      } catch (e) {
        toast({
          title: "Stop failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      } finally {
        setStoppingIds((ids) => ids.filter((x) => x !== run.nodeId));
      }
    },
    [toast],
  );

  // E4 workflow-level stop: every currently active row (running + queued)
  // across all workflows. Fires the same /stop lane per row; the runner's
  // claim skips the now-failed queued rows and the pool drains.
  const stopAll = React.useCallback(
    async (rows: RunRow[]) => {
      if (rows.length === 0) return;
      setStoppingAll(true);
      try {
        const results = await Promise.allSettled(
          rows.map((r) =>
            fetch(`/api/workflow/nodes/${r.nodeId}/stop`, {
              method: "POST",
            }).then((res) =>
              res.ok
                ? null
                : res
                    .json()
                    .catch(() => ({}))
                    .then((err: { error?: string }) =>
                      `${r.name}: ${err.error || `HTTP ${res.status}`}`,
                    ),
            ),
          ),
        );
        const failures = results
          .map((x) => (x.status === "fulfilled" ? x.value : null))
          .filter((x): x is string => x !== null);
        toast({
          title:
            failures.length === 0
              ? `Stopped ${rows.length} run${rows.length === 1 ? "" : "s"}`
              : `Stopped ${rows.length - failures.length}/${rows.length} runs`,
          description:
            failures.length > 0 ? failures[0] : "Active nodes were marked failed (stopped by user).",
          variant: failures.length === 0 ? "success" : "destructive",
        });
        const fresh = await fetch("/api/runs");
        if (fresh.ok) setData(await fresh.json());
      } finally {
        setStoppingAll(false);
      }
    },
    [toast],
  );

  const summary = data?.summary;
  const running = data?.active.filter((r) => r.status === "running") ?? [];
  const queued = data?.active.filter((r) => r.status === "pending") ?? [];

  return (
    <Sheet open={open} onOpenChange={setRunsSheetOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ListVideo className="size-4 text-primary" />
            Runs
          </SheetTitle>
          <SheetDescription className="text-xs">
            {loading && !data
              ? "Loading run queue…"
              : summary
                ? `${summary.running} running · ${summary.queued} queued · ${summary.failed} failed (48h) · ${summary.completedInWindow} completed (48h)`
                : "Global run queue across all workflows"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-2 py-3">
          {loadError && !data ? (
            <p className="px-2 py-3 text-sm text-rose-600 dark:text-rose-400">
              Couldn&apos;t load the run queue — {loadError}. Retrying every 3s…
            </p>
          ) : (
            <>
          {/* Active lane */}
          <section aria-label="Running and queued nodes">
            <h3 className="flex items-center justify-between px-2 pb-1 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Running &amp; Queued
              </span>
              {running.length + queued.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400"
                  disabled={stoppingAll}
                  title="Stop every running and queued node — they are marked failed (stopped) and downstream nodes unlock with failure semantics."
                  onClick={(e) => {
                    e.stopPropagation();
                    void stopAll([...running, ...queued]);
                  }}
                >
                  {stoppingAll ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Square className="size-3 fill-current" />
                  )}
                  Stop all
                </Button>
              )}
            </h3>
            {running.length === 0 && queued.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                Nothing executing right now.
              </p>
            ) : (
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {[...running, ...queued].map((r) => (
                  <Row
                    key={r.nodeId}
                    run={r}
                    onClick={() => void jumpTo(r)}
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400"
                          disabled={stoppingIds.includes(r.nodeId)}
                          title={
                            r.status === "running"
                              ? "Stop this node — marked failed; its late engine result is discarded."
                              : "Cancel this queued node — marked failed so the runner skips it."
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            void stop(r);
                          }}
                        >
                          {stoppingIds.includes(r.nodeId) ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Square className="size-3.5 fill-current" />
                          )}
                          Stop
                        </Button>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* Failed lane */}
          <section aria-label="Failed nodes" className="mt-4">
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Failed · retry
            </h3>
            {(data?.failed ?? []).length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No failures in the last 48 hours.
              </p>
            ) : (
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {(data?.failed ?? []).map((r) => (
                  <Row
                    key={r.nodeId}
                    run={r}
                    onClick={() => void jumpTo(r)}
                    trailing={
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1 px-2.5 text-xs"
                        disabled={retryingId === r.nodeId}
                        onClick={(e) => {
                          e.stopPropagation();
                          void retry(r);
                        }}
                      >
                        {retryingId === r.nodeId ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCw className="size-3.5" />
                        )}
                        Retry
                      </Button>
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* Recent lane */}
          <section aria-label="Recent runs" className="mt-4">
            <h3 className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Clock className="size-3" />
              Recent (48h)
            </h3>
            {(data?.recent ?? []).length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No finished runs in the window.
              </p>
            ) : (
              <div className="max-h-96 space-y-0.5 overflow-y-auto">
                {(data?.recent ?? []).map((r) => (
                  <Row key={r.nodeId} run={r} onClick={() => void jumpTo(r)} trailing={<ChevronRight className="size-4 shrink-0 text-muted-foreground" />} />
                ))}
              </div>
            )}
          </section>
            </>
          )}
        </div>

        {/* Footnote: parallel lane note */}
        <footer className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Activity className="size-3" />
            Workflow runs execute up to 3 independent nodes in parallel; retries
            cascade downstream. Stopped nodes are marked failed — downstream
            nodes unlock with failure semantics, and a node stuck longer than
            15m is failed by the watchdog.
          </span>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
