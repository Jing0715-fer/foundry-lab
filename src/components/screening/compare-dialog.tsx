"use client";

/**
 * CompareDialog — side-by-side comparison of 2–4 selected candidates.
 *
 * Rows: Score, Rank, Length, one per metric def, Status. Columns: the
 * candidates (name + assigned color dot). The BEST value per numeric row is
 * emerald-highlighted (respecting higherIsBetter; Score → highest, Rank →
 * lowest; Length and Status get no highlight). Footer: an "Open" button per
 * column (opens the detail drawer) + a winner summary line.
 */

import * as React from "react";
import { Columns3, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScreeningMetricDef } from "@/lib/types";
import { QUALITY_TEXT, formatMetric, qualityClass, type ScoredRow } from "./scoring";
import { CandidateStatusBadge } from "./screening-table";

const COLUMN_DOTS = [
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
];

interface CompareDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: ScoredRow[];
  metricDefs: ScreeningMetricDef[];
  onOpenCandidate: (id: string) => void;
}

export function CompareDialog({
  open,
  onOpenChange,
  rows,
  metricDefs,
  onOpenCandidate,
}: CompareDialogProps) {
  if (rows.length === 0) return null;

  const winner = rows.reduce((best, r) => (r.score > best.score ? r : best), rows[0]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Columns3 className="size-5" />
            Compare candidates
          </DialogTitle>
          <DialogDescription>
            Best value per row is highlighted — arrow direction follows each
            metric's preference.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto overflow-x-auto rounded-xl border [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28 bg-card">Metric</TableHead>
                {rows.map((r, i) => (
                  <TableHead key={r.candidate.id} className="min-w-36 bg-card">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn("size-2.5 shrink-0 rounded-full", COLUMN_DOTS[i % 4])}
                        aria-hidden
                      />
                      <span className="truncate text-xs font-medium">
                        {r.candidate.name}
                      </span>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Score — highest wins (ties all highlighted) */}
              <CompareRow
                label="Score"
                cells={rows.map((r) => ({ text: r.score.toFixed(1) }))}
                best={indexOfAllMax(rows.map((r) => r.score))}
              />
              {/* Rank — lowest wins */}
              <CompareRow
                label="Rank"
                cells={rows.map((r) => ({ text: `#${r.rank}` }))}
                best={indexOfAllMin(rows.map((r) => r.rank))}
              />
              {/* Length — no highlight */}
              <CompareRow
                label="Length"
                cells={rows.map((r) => ({
                  text: r.candidate.length === null ? "—" : String(r.candidate.length),
                }))}
                best={[]}
              />
              {/* Metrics */}
              {metricDefs.map((def) => {
                const values = rows.map((r) => r.candidate.metrics?.[def.key]);
                const anyMissing = values.some((v) => v === undefined || !Number.isFinite(v));
                const best = anyMissing
                  ? []
                  : def.higherIsBetter
                    ? indexOfAllMax(values as number[])
                    : indexOfAllMin(values as number[]);
                return (
                  <CompareRow
                    key={def.key}
                    label={`${def.label}${def.unit ? ` (${def.unit})` : ""}`}
                    cells={rows.map((r) => {
                      const v = r.candidate.metrics?.[def.key];
                      if (v === undefined || !Number.isFinite(v)) return { text: "—" };
                      return {
                        text: formatMetric(v),
                        cls: QUALITY_TEXT[qualityClass(v, def)],
                      };
                    })}
                    best={best}
                  />
                );
              })}
              {/* Status — text, no highlight */}
              <TableRow>
                <TableCell className="text-xs text-muted-foreground">Status</TableCell>
                {rows.map((r) => (
                  <TableCell key={r.candidate.id}>
                    <CandidateStatusBadge status={r.candidate.status} />
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {/* Footer: open per column + winner summary */}
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {rows.map((r) => (
              <Button
                key={r.candidate.id}
                variant="outline"
                size="sm"
                className="h-11 gap-1.5 md:h-9"
                onClick={() => {
                  onOpenChange(false);
                  onOpenCandidate(r.candidate.id);
                }}
              >
                <Eye className="size-3.5" />
                Open
              </Button>
            ))}
          </div>
          <p className="text-center text-sm">
            <span className="text-muted-foreground">Best composite: </span>
            <span className="font-medium">{winner.candidate.name}</span>{" "}
            <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              ({winner.score.toFixed(1)})
            </span>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareRow({
  label,
  cells,
  best,
}: {
  label: string;
  cells: { text: string; cls?: string }[];
  /** Indices of the best cell(s) — ties highlight every winner. */
  best: number[];
}) {
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground">{label}</TableCell>
      {cells.map((cell, i) => (
        <TableCell
          key={i}
          className={cn(
            "text-sm tabular-nums",
            cell.cls,
            best.includes(i) &&
              "rounded-md bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-400",
          )}
        >
          {cell.text}
        </TableCell>
      ))}
    </TableRow>
  );
}

function indexOfAllMax(values: number[]): number[] {
  const bestV = Math.max(...values);
  return values.map((v, i) => (v === bestV ? i : -1)).filter((i) => i >= 0);
}

function indexOfAllMin(values: number[]): number[] {
  const bestV = Math.min(...values);
  return values.map((v, i) => (v === bestV ? i : -1)).filter((i) => i >= 0);
}
