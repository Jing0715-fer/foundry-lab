"use client";

/**
 * StatsStrip — compact campaign overview above the screening table:
 *  1. Five count cards (Total / Starred / Shortlisted / Rejected / Promoted),
 *     computed LIVE from the candidate list so optimistic patches show up
 *     immediately (the DTO counts only refresh on server round-trips).
 *  2. One summary line for the primary metric ("pLDDT 61.2–94.8 · median 78.4").
 *  3. Per-metric distribution mini-histograms — pure CSS, 12 bins, bar
 *     heights scaled to the tallest bin, bars colored by the quality class
 *     of the bin CENTER, min/max labels at the ends. Wrapped in a
 *     horizontally scrollable row on small screens.
 */

import * as React from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ScreeningCandidateDTO,
  ScreeningMetricDef,
} from "@/lib/types";
import { QUALITY_BG, formatMetric, qualityClass } from "./scoring";

const HIST_BINS = 12;

interface StatsStripProps {
  candidates: ScreeningCandidateDTO[];
  metricDefs: ScreeningMetricDef[];
}

export function StatsStrip({ candidates, metricDefs }: StatsStripProps) {
  const counts = React.useMemo(() => {
    let starred = 0;
    let shortlisted = 0;
    let rejected = 0;
    let promoted = 0;
    for (const c of candidates) {
      if (c.starred) starred += 1;
      switch (c.status) {
        case "shortlisted":
          shortlisted += 1;
          break;
        case "rejected":
          rejected += 1;
          break;
        case "promoted":
          promoted += 1;
          break;
        default:
          break;
      }
    }
    return { total: candidates.length, starred, shortlisted, rejected, promoted };
  }, [candidates]);

  // Summary line over the primary metric (first def with observed values).
  const summary = React.useMemo(() => {
    for (const def of metricDefs) {
      const values: number[] = [];
      for (const c of candidates) {
        const v = c.metrics?.[def.key];
        if (v !== undefined && Number.isFinite(v)) values.push(v);
      }
      if (values.length === 0) continue;
      values.sort((a, b) => a - b);
      const min = values[0];
      const max = values[values.length - 1];
      const median =
        values.length % 2 === 1
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
      return `${def.label} ${formatMetric(min)}–${formatMetric(max)} · median ${formatMetric(median)}`;
    }
    return null;
  }, [candidates, metricDefs]);

  const cards = [
    { label: "Total", value: counts.total, cls: "text-foreground" },
    { label: "Starred", value: counts.starred, cls: "text-amber-600 dark:text-amber-400" },
    { label: "Shortlisted", value: counts.shortlisted, cls: "text-teal-600 dark:text-teal-400" },
    { label: "Rejected", value: counts.rejected, cls: "text-rose-600 dark:text-rose-400" },
    { label: "Promoted", value: counts.promoted, cls: "text-emerald-600 dark:text-emerald-400" },
  ];

  return (
    <Card className="shadow-sm">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <BarChart3 className="size-4" />
          </span>
          <span className="text-sm font-medium">Campaign stats</span>
          {summary && (
            <span className="text-xs text-muted-foreground">{summary}</span>
          )}
        </div>

        {/* Count cards */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {cards.map((c) => (
            <div
              key={c.label}
              className="rounded-lg border bg-card px-3 py-2"
            >
              <p className={`text-xl font-semibold leading-none tabular-nums ${c.cls}`}>
                {c.value}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">{c.label}</p>
            </div>
          ))}
        </div>

        {/* Per-metric distribution mini-histograms */}
        {metricDefs.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {metricDefs.map((def) => (
              <MetricHistogram
                key={def.key}
                def={def}
                candidates={candidates}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Pure-CSS 12-bin histogram for one metric. */
function MetricHistogram({
  def,
  candidates,
}: {
  def: ScreeningMetricDef;
  candidates: ScreeningCandidateDTO[];
}) {
  const { bins, maxCount, domain } = React.useMemo(() => {
    const [min, max] = def.domain;
    const counts = new Array<number>(HIST_BINS).fill(0);
    let observed = 0;
    for (const c of candidates) {
      const v = c.metrics?.[def.key];
      if (v === undefined || !Number.isFinite(v)) continue;
      observed += 1;
      const span = max - min;
      const idx = span === 0
        ? 0
        : Math.min(HIST_BINS - 1, Math.floor(((v - min) / span) * HIST_BINS));
      counts[idx] += 1;
    }
    return {
      bins: counts,
      maxCount: Math.max(1, ...counts),
      domain: { min, max, observed },
    };
  }, [candidates, def]);

  const span = domain.max - domain.min;

  return (
    <div className="w-36 shrink-0 rounded-lg border bg-card p-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <p className="truncate text-center text-[11px] font-medium text-foreground">
            {def.label}
            {def.unit ? ` (${def.unit})` : ""}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">
            {def.label}
            {def.unit ? ` (${def.unit})` : ""} —{" "}
            {def.higherIsBetter ? "higher is better" : "lower is better"}
            {def.hint ? ` · ${def.hint}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {domain.observed} candidates with this metric
          </p>
        </TooltipContent>
      </Tooltip>
      <div
        className="mt-1.5 flex h-10 items-end gap-[2px]"
        role="img"
        aria-label={`${def.label} distribution histogram, ${HIST_BINS} bins`}
      >
        {bins.map((count, i) => {
          const center = domain.min + ((i + 0.5) * span) / HIST_BINS;
          const q = span === 0 ? "neutral" : qualityClass(center, def);
          const height = count === 0 ? 2 : Math.round(4 + (count / maxCount) * 34);
          return (
            <div
              key={i}
              className={`flex-1 rounded-t-sm ${QUALITY_BG[q]}`}
              style={{ height }}
              title={`${count} candidate${count === 1 ? "" : "s"}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{formatMetric(domain.min)}</span>
        <span>{formatMetric(domain.max)}</span>
      </div>
    </div>
  );
}
