"use client";

// Global Runs sheet (B4: run-queue visualization + E4 stop affordances).
//
// Cross-workflow execution view, opened from the header's Runs button:
//   - Running & Queued: live progress bars per node (+ its workflow), polled
//     every 3s while the sheet is open. Every active row carries a Stop
//     button (node-level abort: POST /api/runs/abort { nodeId }) and the
//     section header offers Stop all when anything is active (workflow rows
//     are aborted per-workflow).
//   - Failed (last 48h): each row has Retry → POST /api/workflow/nodes/:id/run
//     (single-node lane: claims the terminal node conditionally and cascades
//     downstream whose upstreams are completed). Retry is FIRE-AND-FORGET
//     (E2): the POST resolves only when the node finishes, so awaiting it
//     left the button spinning for the whole execution — instead the toast
//     fires immediately and the 3s poll takes over presenting the run state.
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
        // Only activate from the ROW itself — a keypress focused on a child
        // button (Stop/Retry) must not be hijacked into row navigation
        // (preventDefault here would also swallow the button's own click
        // activation). P1 finding, qa-review-c-e-lane.md.
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
        <span className="block truncate text-sm font-medium leading-tight">
          {run.name}
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
  const [stoppingIds, setStoppingIds] = React.useState<Set<string>>(new Set());
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
  // E2: fire-and-forget — the POST resolves only when the node finishes
  // (potentially minutes), so we toast immediately, let the 3s poll surface
  // the running state, and swallow the (late) HTTP result into a toast.
  const retry = React.useCallback(
    (run: RunRow) => {
      setRetryingId(run.nodeId);
      // Claim-phase feedback only: clear on the next poll tick so the row
      // flips to running naturally (or stays failed if the claim was lost).
      void (async () => {
        const res = await fetch(`/api/workflow/nodes/${run.nodeId}/run`, {
          method: "POST",
        }).catch(() => null);
        setRetryingId(null);
        if (res && !res.ok) {
          const err = await res.json().catch(() => ({}));
          toast({
            title: "Retry failed",
            description: err.error || `HTTP ${res.status}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Retry finished",
            description: res
              ? `${run.name} settled — see Recent for the outcome.`
              : `${run.name} is retrying in the background.`,
          });
        }
      })();
      toast({
        title: "Retry started",
        description: `${run.name} is running again`,
      });
    },
    [toast],
  );

  // E4: stop one active node (running or queued).
  const stop = React.useCallback(
    (run: RunRow) => {
      setStoppingIds((prev) => new Set(prev).add(run.nodeId));
      void (async () => {
        try {
          const res = await fetch("/api/runs/abort", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodeId: run.nodeId }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
          toast({
            title: "Stopped",
            description: `${run.name} was aborted.`,
          });
          // Immediate refresh so the row leaves the active lane right away.
          const fresh = await fetch("/api/runs");
          if (fresh.ok) setData(await fresh.json());
        } catch (e) {
          toast({
            title: "Couldn't stop the run",
            description: e instanceof Error ? e.message : "Unknown error",
            variant: "destructive",
          });
        } finally {
          setStoppingIds((prev) => {
            const next = new Set(prev);
            next.delete(run.nodeId);
            return next;
          });
        }
      })();
    },
    [toast],
  );

  const summary = data?.summary;
  const running = data?.active.filter((r) => r.status === "running") ?? [];
  const queued = data?.active.filter((r) => r.status === "pending") ?? [];
  const active = data?.active ?? [];

  // E4: stop everything active, per workflow (each distinct workflow id
  // among active rows gets one workflow-level abort).
  const stopAll = React.useCallback(() => {
    if (active.length === 0) return;
    const wfIds = [
      ...new Set(active.map((r) => r.workflow?.id).filter((x): x is string => !!x)),
    ];
    setStoppingAll(true);
    void (async () => {
      try {
        let abortedTotal = 0;
        for (const wfId of wfIds) {
          const res = await fetch("/api/runs/abort", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowId: wfId }),
          });
          if (res.ok) {
            const payload = await res.json().catch(() => ({}));
            abortedTotal += Number(payload.aborted ?? 0);
          }
        }
        toast({
          title: "All active runs stopped",
          description: `${abortedTotal} node${abortedTotal === 1 ? "" : "s"} aborted across ${
            wfIds.length
          } workflow${wfIds.length === 1 ? "" : "s"}.`,
        });
        const fresh = await fetch("/api/runs");
        if (fresh.ok) setData(await fresh.json());
      } catch (e) {
        toast({
          title: "Couldn't stop all runs",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      } finally {
        setStoppingAll(false);
      }
    })();
  }, [active, toast]);

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
            <h3 className="flex items-center justify-between px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Running &amp; Queued</span>
              {active.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                  disabled={stoppingAll}
                  onClick={stopAll}
                >
                  {stoppingAll ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Square className="size-3" />
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1 px-2.5 text-xs"
                        disabled={stoppingIds.has(r.nodeId)}
                        title="Abort this node (running or queued)"
                        onClick={(e) => {
                          e.stopPropagation();
                          stop(r);
                        }}
                      >
                        {stoppingIds.has(r.nodeId) ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Square className="size-3.5" />
                        )}
                        Stop
                      </Button>
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
            cascade to downstream nodes.
          </span>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
