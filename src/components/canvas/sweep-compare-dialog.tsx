"use client";

// Sweep comparison dialog (campaign mode, step 2 — "跑完即出结论").
//
// Opens from the Inspector of any sweep VARIANT node: fetches the whole
// sweep group (GET /api/workflow/nodes/[id]/sweep-group) and renders an
// inline comparison table:
//   - parameter columns = the sweep axes (keys that differ across variants),
//   - metric columns = per-variant aggregated run metrics (same extraction
//     rules as the screening harvester), color-coded best/worst per column,
//   - Score = the screening default composite (primary metrics ×2) with the
//     overall best variant crowned,
//   - row click → selects that variant node on the canvas,
//   - "Create screening campaign" → POST /api/screening {source:{kind:"sweep"}}
//     (all completed variants' outputs, run-labeled by variant name) and
//     navigates to the Screening panel.
//
// Read-only view: no DB writes happen until the explicit campaign action.

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Crown,
  FileStack,
  FlaskConical,
  Loader2,
  Table2,
  TriangleAlert,
} from "lucide-react";
import type { NodeDTO, SweepGroupDTO } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import {
  normalize,
  QUALITY_TEXT,
  formatMetric,
} from "@/components/screening/scoring";

/** Screening default weights: primary metrics ×2, everything else ×1. */
const PRIMARY = new Set(["plddt", "recovery", "rama_ll", "clashes"]);

/** Composite score (0–100) of one variant under the default weights. */
function variantScore(
  metrics: Record<string, number>,
  defs: SweepGroupDTO["metrics"],
): number {
  let sum = 0;
  let wsum = 0;
  for (const d of defs) {
    const v = metrics[d.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const w = PRIMARY.has(d.key) ? 2 : 1;
    sum += w * normalize(v, d);
    wsum += w;
  }
  return wsum > 0 ? (100 * sum) / wsum : 0;
}

export function SweepCompareDialog({
  node,
  open,
  onOpenChange,
}: {
  node: NodeDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const select = useAppStore((s) => s.select);
  const inspect = useAppStore((s) => s.inspect);
  const setViewport = useAppStore((s) => s.setViewport);
  const workflow = useAppStore((s) => s.workflow);

  const [data, setData] = React.useState<SweepGroupDTO | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Fetch on open (fresh data every time — statuses/metrics move).
  React.useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      setCreating(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/workflow/nodes/${node.id}/sweep-group`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (!cancelled) setData(body as SweepGroupDTO);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, node.id]);

  // Scores + best variant (completed rows only compete).
  const scored = React.useMemo(() => {
    if (!data) return { rows: [] as { nodeId: string; score: number }[], bestId: null as string | null };
    const rows = data.variants.map((v) => ({
      nodeId: v.nodeId,
      score: variantScore(v.metrics, data.metrics),
    }));
    const completed = rows.filter((r) =>
      data.variants.find((v) => v.nodeId === r.nodeId && v.status === "completed"),
    );
    let bestId: string | null = null;
    let bestScore = -1;
    for (const r of completed) {
      if (r.score > bestScore) {
        bestScore = r.score;
        bestId = r.nodeId;
      }
    }
    return { rows, bestId };
  }, [data]);

  const completedCount = data?.completedCount ?? 0;
  const hasMetrics = (data?.metrics.length ?? 0) > 0;

  const onRowClick = (nodeId: string) => {
    const target = workflow?.nodes.find((n) => n.id === nodeId);
    select(nodeId);
    inspect(nodeId);
    // Best-effort center: keep zoom, pan the node toward the viewport middle.
    if (target) {
      const zoom = useAppStore.getState().viewport.zoom;
      setViewport({
        x: window.innerWidth / 2 - target.x * zoom,
        y: window.innerHeight / 2 - target.y * zoom,
      });
    }
    onOpenChange(false);
  };

  const onCreateCampaign = async () => {
    if (!data || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/screening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { kind: "sweep", nodeId: node.id },
          name: `${data.toolLabel} Sweep Campaign`,
          description: `One-click campaign from the ${data.toolLabel} parameter sweep (${completedCount}/${data.variants.length} variants completed).`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      onOpenChange(false);
      useAppStore.getState().setActivePanel("screening");
      toast({
        title: "Screening campaign created",
        description: `Harvested outputs from ${completedCount} completed variants — each run labeled by its variant.`,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Failed to create campaign",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-4 text-primary" />
            Sweep comparison — {data?.toolLabel ?? node.name}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.variants.length} variants · ${completedCount} completed · ${data.totalOutputFiles} output files`
              : "Comparing every variant of this parameter sweep."}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading sweep results…
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && data && (
          <>
          <div
            className="max-h-[60vh] overflow-y-auto overflow-x-auto rounded-xl border bg-card"
            data-sweep-compare-scroll
          >
            <table className="w-full min-w-[640px] border-collapse text-sm" data-sweep-compare-table>
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2 font-medium text-muted-foreground">Variant</th>
                  {data.axisKeys.map((k) => (
                    <th
                      key={k}
                      className="p-2 font-mono text-xs font-medium text-muted-foreground"
                    >
                      {k}
                    </th>
                  ))}
                  {data.metrics.map((m) => (
                    <th
                      key={m.key}
                      title={m.hint ?? m.key}
                      className="p-2 text-xs font-medium text-muted-foreground"
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {m.label}
                        {m.higherIsBetter ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )}
                      </span>
                    </th>
                  ))}
                  <th className="p-2 text-xs font-medium text-muted-foreground">
                    Score
                  </th>
                  <th className="p-2 text-xs font-medium text-muted-foreground">
                    Files
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((v) => {
                  const rowScore = scored.rows.find((r) => r.nodeId === v.nodeId)?.score ?? 0;
                  const isBest = scored.bestId === v.nodeId;
                  return (
                    <tr
                      key={v.nodeId}
                      onClick={() => onRowClick(v.nodeId)}
                      className="cursor-pointer border-b transition-colors hover:bg-accent/50"
                      data-sweep-compare-row={v.nodeId}
                    >
                      <td className="max-w-52 truncate p-2">
                        <span className="flex items-center gap-1.5">
                          {v.status === "completed" && (
                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                          )}
                          {v.status === "failed" && (
                            <TriangleAlert className="size-3.5 shrink-0 text-rose-500" />
                          )}
                          <span className="truncate font-medium" title={v.name}>
                            {v.name}
                          </span>
                          {isBest && (
                            <Badge className="ml-1 gap-0.5 bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400">
                              <Crown className="size-3" />
                              Best
                            </Badge>
                          )}
                        </span>
                      </td>
                      {data.axisKeys.map((k) => (
                        <td
                          key={k}
                          className="p-2 font-mono text-xs text-foreground"
                        >
                          {String(v.params[k] ?? "—")}
                        </td>
                      ))}
                      {data.metrics.map((m) => {
                        const raw = v.metrics[m.key];
                        const hasRaw = typeof raw === "number" && Number.isFinite(raw);
                        // Best value in this column (completed rows only).
                        let isColBest = false;
                        if (hasRaw) {
                          for (const other of data.variants) {
                            if (other.status !== "completed") continue;
                            const ov = other.metrics[m.key];
                            if (typeof ov !== "number" || !Number.isFinite(ov)) continue;
                            if (other.nodeId === v.nodeId) continue;
                            if (m.higherIsBetter ? ov > raw : ov < raw) {
                              isColBest = false;
                              break;
                            }
                            isColBest = true;
                          }
                        }
                        return (
                          <td key={m.key} className="p-2 font-mono text-xs">
                            {hasRaw ? (
                              <span
                                className={
                                  isColBest ? "font-semibold text-emerald-600 dark:text-emerald-400" : QUALITY_TEXT.neutral
                                }
                              >
                                {formatMetric(raw)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="p-2 font-mono text-xs">
                        {v.status === "completed" ? (
                          <span className="font-medium">{rowScore.toFixed(1)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2 font-mono text-xs text-muted-foreground">
                        {v.files.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

            {!hasMetrics && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                <FileStack className="size-3.5 shrink-0" />
                No metrics detected yet — metrics appear once variants complete
                with engine metrics.json / ranking files.
              </div>
            )}
            {completedCount < data.variants.length && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0" />
                {data.variants.length - completedCount} variant
                {data.variants.length - completedCount === 1 ? "" : "s"} still
                running or idle — the campaign will harvest completed ones.
              </div>
            )}
          </>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Close
          </Button>
          <Button
            onClick={onCreateCampaign}
            disabled={!data || creating || completedCount === 0}
            title={
              completedCount === 0
                ? "No completed variants yet — run the variants first"
                : "Harvest all completed variants' outputs into a screening campaign"
            }
            data-sweep-create-campaign
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FlaskConical className="size-4" />
            )}
            Create screening campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
