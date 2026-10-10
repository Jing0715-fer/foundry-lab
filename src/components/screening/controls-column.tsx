"use client";

/**
 * ControlsColumn — the search / filter / ranking-weights sidebar of the
 * Screening panel. Rendered as a ~300px sticky column on xl+ screens and
 * inside a Collapsible above the table below xl. Purely presentational:
 * every value + setter is owned by the parent ScreeningPanel.
 */

import * as React from "react";
import { Box, Loader2, RotateCcw, Save, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { ScreeningMetricDef } from "@/lib/types";
import { PRESETS, formatMetric, type WeightPreset } from "./scoring";

export type StatusFilterKey =
  | "all" | "new" | "starred" | "shortlisted" | "rejected" | "promoted";

const STATUS_CHIPS: { key: StatusFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "starred", label: "Starred" },
  { key: "shortlisted", label: "Shortlisted" },
  { key: "rejected", label: "Rejected" },
  { key: "promoted", label: "Promoted" },
];

export interface RangeFilter {
  min: string;
  max: string;
}

export interface ControlsColumnProps {
  query: string;
  onQueryChange: (q: string) => void;
  statusFilter: StatusFilterKey;
  onStatusFilterChange: (s: StatusFilterKey) => void;
  uniqueSources: string[];
  sourceFilter: string[];
  onToggleSource: (s: string) => void;
  metricDefs: ScreeningMetricDef[];
  rangeFilters: Record<string, RangeFilter>;
  onRangeChange: (key: string, side: "min" | "max", value: string) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  weights: Record<string, number>;
  onWeightChange: (key: string, value: number) => void;
  onPreset: (preset: WeightPreset) => void;
  onResetWeights: () => void;
  onSaveWeights: () => void;
  weightsDirtyFlag: boolean;
  savingWeights: boolean;
  /** H1c: candidates eligible as the RMSD reference (linked PDB only). */
  rmsdCandidates: { id: string; name: string }[];
  /** H1c: the reference the axis was last computed against (null = never). */
  rmsdRef: { id: string; name: string } | null;
  rmsdBusy: boolean;
  /** Local select value — the parent owns it so it survives re-renders. */
  rmsdRefPick: string;
  onRmsdRefPick: (id: string) => void;
  /** Compute (or recompute against a new reference) — fires the POST. */
  onComputeRmsd: (refId: string) => void;
}

export function ControlsColumn({
  query,
  onQueryChange,
  statusFilter,
  onStatusFilterChange,
  uniqueSources,
  sourceFilter,
  onToggleSource,
  metricDefs,
  rangeFilters,
  onRangeChange,
  activeFilterCount,
  onClearFilters,
  weights,
  onWeightChange,
  onPreset,
  onResetWeights,
  onSaveWeights,
  weightsDirtyFlag,
  savingWeights,
  rmsdCandidates,
  rmsdRef,
  rmsdBusy,
  rmsdRefPick,
  onRmsdRefPick,
  onComputeRmsd,
}: ControlsColumnProps) {
  return (
    <Card className="shadow-sm">
      <CardContent className="space-y-4 p-4">
        {/* Search */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="screening-search">Search</Label>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onClearFilters}
              >
                Clear ({activeFilterCount})
              </Button>
            )}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="screening-search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Name, source, tag…"
              className="h-11 pl-8 md:h-9"
            />
          </div>
        </div>

        {/* Status filter chips */}
        <div className="space-y-1.5">
          <Label>Status</Label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_CHIPS.map((chip) => {
              const active = statusFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => onStatusFilterChange(chip.key)}
                  aria-pressed={active}
                  className={cn(
                    "min-h-9 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Source filter chips */}
        {uniqueSources.length > 1 && (
          <div className="space-y-1.5">
            <Label>Source</Label>
            <div className="flex flex-wrap gap-1.5">
              {uniqueSources.map((s) => {
                const active = sourceFilter.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onToggleSource(s)}
                    aria-pressed={active}
                    className={cn(
                      "min-h-9 rounded-full border px-3 py-1 text-xs font-medium lowercase transition-colors",
                      active
                        ? "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-400"
                        : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-metric range filters */}
        {metricDefs.length > 0 && (
          <div className="space-y-2.5">
            <Label>Metric ranges</Label>
            {metricDefs.map((def) => {
              const rf = rangeFilters[def.key] ?? { min: "", max: "" };
              return (
                <div key={def.key} className="space-y-1">
                  <p className="text-xs font-medium text-foreground">
                    {def.label}
                    {def.unit ? ` (${def.unit})` : ""}
                    <span className="ml-1 font-normal text-muted-foreground">
                      {formatMetric(def.domain[0])}–{formatMetric(def.domain[1])}
                    </span>
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={rf.min}
                      onChange={(e) => onRangeChange(def.key, "min", e.target.value)}
                      placeholder="min"
                      className="h-9 text-xs"
                      aria-label={`${def.label} minimum`}
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={rf.max}
                      onChange={(e) => onRangeChange(def.key, "max", e.target.value)}
                      placeholder="max"
                      className="h-9 text-xs"
                      aria-label={`${def.label} maximum`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Ranking weights */}
        <div className="space-y-2.5 border-t pt-3">
          <div className="flex items-center justify-between">
            <Label>Ranking weights</Label>
            <span
              className="relative flex size-2"
              title={weightsDirtyFlag ? "Unsaved changes" : "Saved"}
              role="status"
              aria-label={weightsDirtyFlag ? "Weights have unsaved changes" : "Weights saved"}
            >
              {weightsDirtyFlag && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              )}
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  weightsDirtyFlag ? "bg-amber-500" : "bg-muted-foreground/40",
                )}
              />
            </span>
          </div>

          {metricDefs.map((def) => (
            <div key={def.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  {def.label}
                </span>
                <Badge
                  variant="secondary"
                  className="text-[10px] tabular-nums"
                  aria-label={`${def.label} weight ${weights[def.key] ?? 1}`}
                >
                  {weights[def.key] ?? 1}
                </Badge>
              </div>
              <Slider
                value={[weights[def.key] ?? 1]}
                min={0}
                max={5}
                step={1}
                onValueChange={(v) => onWeightChange(def.key, v[0] ?? 1)}
                aria-label={`${def.label} weight`}
              />
            </div>
          ))}

          {/* Presets */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => onPreset(preset)}
                className="min-h-9 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title={`Apply preset: ${preset.label}`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 flex-1 gap-1"
              onClick={onResetWeights}
              disabled={!weightsDirtyFlag || savingWeights}
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
            <Button
              size="sm"
              className="h-9 flex-1 gap-1"
              onClick={onSaveWeights}
              disabled={!weightsDirtyFlag || savingWeights}
            >
              {savingWeights ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
        {/* H1c: structural-RMSD axis — compute a real "rmsd" metric for every
            candidate against one reference (server-side superposition). The
            values land in candidate metrics, so sorting / range filters /
            weights / CSV / report all treat it like any engine metric. */}
        <div className="space-y-2 border-t pt-3">
          <Label className="flex items-center gap-1.5">
            <Box className="size-3.5" />
            Structural RMSD
          </Label>
          {rmsdCandidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No candidates with a linked PDB file yet.
            </p>
          ) : (
            <>
              {rmsdRef && (
                <p
                  className="rounded-md bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground"
                  data-testid="rmsd-ref-chip"
                >
                  Axis reference: <span className="font-medium text-foreground">{rmsdRef.name}</span>
                  <span className="text-muted-foreground"> (rmsd 0 Å)</span>
                </p>
              )}
              <Select
                // "" (not undefined): Radix treats it as cleared → placeholder,
                // and the value prop stays a STRING from the first render —
                // switching undefined→string mid-lifetime is the React
                // "uncontrolled to controlled" warning.
                value={rmsdRefPick || rmsdRef?.id || ""}
                onValueChange={onRmsdRefPick}
              >
                <SelectTrigger
                  className="h-11 md:h-9"
                  aria-label="RMSD reference candidate"
                >
                  <SelectValue placeholder="Reference candidate…" />
                </SelectTrigger>
                <SelectContent>
                  {rmsdCandidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="truncate">{c.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-11 w-full gap-1.5 md:h-9"
                disabled={rmsdBusy || !rmsdRefPick}
                onClick={() => {
                  if (rmsdRefPick) onComputeRmsd(rmsdRefPick);
                }}
                data-testid="rmsd-compute"
                title="Compute the global Cα RMSD of every PDB candidate against the reference (optimal rigid superposition)"
              >
                {rmsdBusy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Computing…
                  </>
                ) : (
                  <>
                    <Box className="size-3.5" />
                    {rmsdRef ? "Recompute RMSD" : "Compute RMSD"}
                  </>
                )}
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Adds a weightable <span className="font-medium">rmsd</span> metric (Å, lower
                is more similar) to every candidate with a PDB file — computed
                via sequence alignment + optimal rigid superposition.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
