"use client";

/**
 * ScreeningTable — the results surface of the Screening panel.
 *
 * Contains:
 *  - SelectionBar: sticky action bar shown while rows are checked
 *    (Star / Shortlist / Reject / Clear / Compare / Promote / Export CSV).
 *  - Desktop table (md+): shadcn Table in a max-h-[60vh] overflow-y-auto
 *    container (thin custom scrollbar comes from the global .overflow-y-auto
 *    CSS). Columns: checkbox · rank · star · name · score · one per metric
 *    def (value + tiny 40px normalized bar + quality-colored text) · length
 *    · status · view action. Sortable headers with aria-sort.
 *  - Mobile card list (<md): compact cards (rank, name, score bar, two best
 *    metrics, status, star) — no wide scroll table on small screens.
 *  - Pagination footer: rows-per-page Select + "Showing X–Y of Z" + Prev/Next.
 *
 * All state lives in the parent ScreeningPanel; this file is presentational.
 */

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Eye,
  Star,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ScreeningCandidateDTO,
  ScreeningCandidateStatus,
  ScreeningMetricDef,
} from "@/lib/types";
import {
  QUALITY_TEXT,
  formatMetric,
  normalize,
  qualityClass,
  scoreColorClass,
  type ScoredRow,
} from "./scoring";

// --- Status badge -----------------------------------------------------------

export const STATUS_BADGE: Record<ScreeningCandidateStatus, string> = {
  new: "bg-muted text-muted-foreground",
  shortlisted: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  rejected: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  promoted: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

export function CandidateStatusBadge({ status }: { status: ScreeningCandidateStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize",
        STATUS_BADGE[status] ?? STATUS_BADGE.new,
      )}
    >
      {status}
    </span>
  );
}

// --- Props ------------------------------------------------------------------

export interface ScreeningTableProps {
  /** Rows for the CURRENT page (already filtered + sorted + sliced). */
  rows: ScoredRow[];
  /** Total filtered rows (for the pagination footer). */
  totalRows: number;
  metricDefs: ScreeningMetricDef[];
  sortKey: string;
  sortDir: "asc" | "desc" | null;
  onSort: (key: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onTogglePageAll: () => void;
  onStar: (id: string, starred: boolean) => void;
  onView: (id: string) => void;
  onBulkStar: () => void;
  onBulkStatus: (status: ScreeningCandidateStatus) => void;
  onClearSelection: () => void;
  onCompare: () => void;
  onPromote: () => void;
  onExportCsv: () => void;
}

// --- Main component ---------------------------------------------------------

export function ScreeningTable(props: ScreeningTableProps) {
  const { rows, totalRows, page, pageSize } = props;
  const selectedCount = props.selectedIds.size;
  const from = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalRows);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const compareEnabled = selectedCount >= 2 && selectedCount <= 4;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {selectedCount > 0 && (
        <SelectionBar
          count={selectedCount}
          compareEnabled={compareEnabled}
          onBulkStar={props.onBulkStar}
          onBulkStatus={props.onBulkStatus}
          onClearSelection={props.onClearSelection}
          onCompare={props.onCompare}
          onPromote={props.onPromote}
          onExportCsv={props.onExportCsv}
        />
      )}

      {/* Desktop table (md+) */}
      <div className="hidden md:block">
        <div className="max-h-[60vh] overflow-y-auto overflow-x-auto rounded-xl border bg-card [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-9 pl-3">
                  <Checkbox
                    aria-label="Select all rows on this page"
                    checked={
                      rows.length > 0 && rows.every((r) => props.selectedIds.has(r.candidate.id))
                    }
                    onCheckedChange={() => props.onTogglePageAll()}
                  />
                </TableHead>
                <SortableHead
                  label="#"
                  sortKeyValue="score"
                  active={props.sortKey === "score"}
                  dir={props.sortDir}
                  onSort={props.onSort}
                  className="w-14"
                  ariaLabel="Sort by rank"
                />
                <TableHead className="w-10">
                  <span className="sr-only">Star</span>
                </TableHead>
                <SortableHead
                  label="Name"
                  sortKeyValue="name"
                  active={props.sortKey === "name"}
                  dir={props.sortDir}
                  onSort={props.onSort}
                  className="min-w-[180px]"
                  ariaLabel="Sort by name"
                />
                <SortableHead
                  label="Score"
                  sortKeyValue="score"
                  active={props.sortKey === "score"}
                  dir={props.sortDir}
                  onSort={props.onSort}
                  className="w-[130px]"
                  ariaLabel="Sort by composite score"
                />
                {props.metricDefs.map((def) => (
                  <SortableHead
                    key={def.key}
                    label={def.label}
                    sortKeyValue={`metric:${def.key}`}
                    active={props.sortKey === `metric:${def.key}`}
                    dir={props.sortDir}
                    onSort={props.onSort}
                    className="w-[110px]"
                    ariaLabel={`Sort by ${def.label}`}
                  />
                ))}
                <SortableHead
                  label="Len"
                  sortKeyValue="length"
                  active={props.sortKey === "length"}
                  dir={props.sortDir}
                  onSort={props.onSort}
                  className="w-16"
                  ariaLabel="Sort by length"
                />
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-16 pr-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5 + props.metricDefs.length}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No candidates match the current filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <CandidateRow
                    key={row.candidate.id}
                    row={row}
                    metricDefs={props.metricDefs}
                    selected={props.selectedIds.has(row.candidate.id)}
                    onToggleSelect={props.onToggleSelect}
                    onStar={props.onStar}
                    onView={props.onView}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Mobile card list (<md) */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.length === 0 ? (
          <p className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">
            No candidates match the current filters.
          </p>
        ) : (
          rows.map((row) => (
            <MobileCandidateCard
              key={row.candidate.id}
              row={row}
              metricDefs={props.metricDefs}
              selected={props.selectedIds.has(row.candidate.id)}
              onToggleSelect={props.onToggleSelect}
              onStar={props.onStar}
              onView={props.onView}
            />
          ))
        )}
      </div>

      {/* Pagination footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Rows</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => props.onPageSizeChange(Number(v) || 25)}
          >
            <SelectTrigger size="sm" className="h-8 w-[72px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[25, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="tabular-nums">
            Showing {from}–{to} of {totalRows}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-2.5"
            disabled={page <= 1}
            onClick={() => props.onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
            Prev
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-2.5"
            disabled={page >= totalPages}
            onClick={() => props.onPageChange(page + 1)}
            aria-label="Next page"
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Selection bar ----------------------------------------------------------

function SelectionBar({
  count,
  compareEnabled,
  onBulkStar,
  onBulkStatus,
  onClearSelection,
  onCompare,
  onPromote,
  onExportCsv,
}: {
  count: number;
  compareEnabled: boolean;
  onBulkStar: () => void;
  onBulkStatus: (status: ScreeningCandidateStatus) => void;
  onClearSelection: () => void;
  onCompare: () => void;
  onPromote: () => void;
  onExportCsv: () => void;
}) {
  return (
    <div
      className="sticky top-0 z-20 flex flex-wrap items-center gap-1.5 rounded-xl border bg-card/95 p-2 shadow-sm backdrop-blur"
      role="toolbar"
      aria-label="Selection actions"
    >
      <span className="flex min-h-9 items-center gap-2 rounded-lg bg-primary/10 px-2.5 text-sm font-medium text-primary tabular-nums">
        {count} selected
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={onBulkStar}
      >
        <Star className="size-4" />
        Star
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={() => onBulkStatus("shortlisted")}
      >
        <BookmarkCheck className="size-4" />
        Shortlist
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5 text-rose-600 hover:text-rose-600 dark:text-rose-400"
        onClick={() => onBulkStatus("rejected")}
      >
        <XCircle className="size-4" />
        Reject
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={onClearSelection}
      >
        <X className="size-4" />
        Clear
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={onCompare}
        disabled={!compareEnabled}
        title={compareEnabled ? "Compare selected" : "Select 2–4 candidates to compare"}
      >
        <Columns3 className="size-4" />
        Compare
      </Button>
      <Button
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={onPromote}
      >
        <Upload className="size-4" />
        Promote to Canvas
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 px-3 md:h-8 md:px-2.5"
        onClick={onExportCsv}
      >
        <Download className="size-4" />
        Export CSV
      </Button>
    </div>
  );
}

// --- Sortable header --------------------------------------------------------

function SortableHead({
  label,
  sortKeyValue,
  active,
  dir,
  onSort,
  className,
  ariaLabel,
}: {
  label: string;
  sortKeyValue: string;
  active: boolean;
  /** null = unsorted (default rank order) — ArrowUpDown icon. */
  dir: "asc" | "desc" | null;
  onSort: (key: string) => void;
  className?: string;
  ariaLabel: string;
}) {
  const sorted = active && dir !== null;
  const Icon = sorted ? (dir === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <TableHead
      className={className}
      aria-sort={sorted ? (dir === "desc" ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKeyValue)}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded text-xs font-medium transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className={cn("size-3", !active && "opacity-40")} />
      </button>
    </TableHead>
  );
}

// --- Desktop row ------------------------------------------------------------

function CandidateRow({
  row,
  metricDefs,
  selected,
  onToggleSelect,
  onStar,
  onView,
}: {
  row: ScoredRow;
  metricDefs: ScreeningMetricDef[];
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onStar: (id: string, starred: boolean) => void;
  onView: (id: string) => void;
}) {
  const c = row.candidate;
  const q = scoreColorClass(row.score);
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell className="pl-3">
        <Checkbox
          aria-label={`Select ${c.name}`}
          checked={selected}
          onCheckedChange={() => onToggleSelect(c.id)}
        />
      </TableCell>
      <TableCell className="text-xs tabular-nums text-muted-foreground">
        {row.rank}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-amber-500"
          onClick={() => onStar(c.id, !c.starred)}
          aria-label={c.starred ? `Unstar ${c.name}` : `Star ${c.name}`}
          aria-pressed={c.starred}
        >
          <Star
            className={cn(
              "size-4",
              c.starred && "fill-amber-400 text-amber-400",
            )}
          />
        </Button>
      </TableCell>
      <TableCell className="max-w-[260px] whitespace-normal">
        <div className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{c.name}</span>
          {c.sourceLabel && (
            <span className="truncate text-[11px] text-muted-foreground">
              {c.sourceLabel}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="text-[10px] lowercase">
              {c.source}
            </Badge>
            {c.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="rounded-full bg-secondary px-1.5 py-px text-[10px] text-secondary-foreground"
              >
                #{t}
              </span>
            ))}
            {c.tags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">
                +{c.tags.length - 3}
              </span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "w-10 text-right text-xs font-semibold tabular-nums",
              q === "emerald"
                ? "text-emerald-600 dark:text-emerald-400"
                : q === "amber"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-rose-600 dark:text-rose-400",
            )}
          >
            {row.score.toFixed(1)}
          </span>
          <Progress
            value={row.score}
            aria-label={`Composite score ${row.score.toFixed(1)}`}
            className={cn(
              "h-1.5 w-[60px] shrink-0",
              q === "emerald"
                ? "[&>div]:bg-emerald-500"
                : q === "amber"
                  ? "[&>div]:bg-amber-500"
                  : "[&>div]:bg-rose-500",
            )}
          />
        </div>
      </TableCell>
      {metricDefs.map((def) => {
        const raw = c.metrics?.[def.key];
        return (
          <TableCell key={def.key}>
            <MetricCell value={raw} def={def} />
          </TableCell>
        );
      })}
      <TableCell className="text-xs tabular-nums">
        {c.length ?? "—"}
      </TableCell>
      <TableCell>
        <CandidateStatusBadge status={c.status} />
      </TableCell>
      <TableCell className="pr-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          onClick={() => onView(c.id)}
          aria-label={`View ${c.name} details`}
        >
          <Eye className="size-3.5" />
          View
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** Value + tiny 40px normalized bar + quality-colored text. */
export function MetricCell({
  value,
  def,
}: {
  value: number | undefined;
  def: ScreeningMetricDef;
}) {
  if (value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const q = qualityClass(value, def);
  const n = normalize(value, def);
  return (
    <div className="flex items-center gap-1.5" title={def.hint ?? def.label}>
      <span
        className={cn(
          "w-12 text-right text-xs font-medium tabular-nums",
          QUALITY_TEXT[q],
        )}
      >
        {formatMetric(value)}
      </span>
      <Progress
        value={Math.round(n * 100)}
        aria-label={`${def.label} ${formatMetric(value)}`}
        className={cn(
          "h-1 w-10 shrink-0",
          q === "emerald"
            ? "[&>div]:bg-emerald-500"
            : q === "amber"
              ? "[&>div]:bg-amber-500"
              : q === "rose"
                ? "[&>div]:bg-rose-500"
                : "[&>div]:bg-muted-foreground/60",
        )}
      />
    </div>
  );
}

// --- Mobile card ------------------------------------------------------------

function MobileCandidateCard({
  row,
  metricDefs,
  selected,
  onToggleSelect,
  onStar,
  onView,
}: {
  row: ScoredRow;
  metricDefs: ScreeningMetricDef[];
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onStar: (id: string, starred: boolean) => void;
  onView: (id: string) => void;
}) {
  const c = row.candidate;
  const q = scoreColorClass(row.score);

  // Two "best" metrics = highest normalized values among present metrics.
  const best = metricDefs
    .map((def) => ({ def, value: c.metrics?.[def.key] }))
    .filter((m): m is { def: ScreeningMetricDef; value: number } =>
      m.value !== undefined && Number.isFinite(m.value),
    )
    .sort((a, b) => normalize(b.value, b.def) - normalize(a.value, a.def))
    .slice(0, 2);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3 shadow-sm",
        selected && "border-primary/60 ring-1 ring-primary/30",
      )}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          aria-label={`Select ${c.name}`}
          checked={selected}
          onCheckedChange={() => onToggleSelect(c.id)}
          className="size-5"
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          #{row.rank}
        </span>
        <button
          type="button"
          onClick={() => onView(c.id)}
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md px-1 text-left"
          aria-label={`View ${c.name} details`}
        >
          <span className="w-full truncate text-sm font-medium">{c.name}</span>
          <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
            <Badge variant="outline" className="text-[9px] lowercase">
              {c.source}
            </Badge>
            <span className="truncate">{c.sourceLabel}</span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-muted-foreground hover:text-amber-500"
          onClick={() => onStar(c.id, !c.starred)}
          aria-label={c.starred ? `Unstar ${c.name}` : `Star ${c.name}`}
          aria-pressed={c.starred}
        >
          <Star
            className={cn("size-5", c.starred && "fill-amber-400 text-amber-400")}
          />
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span
          className={cn(
            "w-10 text-right text-sm font-semibold tabular-nums",
            q === "emerald"
              ? "text-emerald-600 dark:text-emerald-400"
              : q === "amber"
                ? "text-amber-600 dark:text-amber-400"
                : "text-rose-600 dark:text-rose-400",
          )}
        >
          {row.score.toFixed(1)}
        </span>
        <Progress
          value={row.score}
          className={cn(
            "h-1.5 flex-1",
            q === "emerald"
              ? "[&>div]:bg-emerald-500"
              : q === "amber"
                ? "[&>div]:bg-amber-500"
                : "[&>div]:bg-rose-500",
          )}
        />
        <CandidateStatusBadge status={c.status} />
      </div>

      {best.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {best.map(({ def, value }) => (
            <span key={def.key} className="text-[11px] text-muted-foreground">
              {def.label}{" "}
              <span
                className={cn(
                  "font-medium tabular-nums",
                  QUALITY_TEXT[qualityClass(value, def)],
                )}
              >
                {formatMetric(value)}
              </span>
              {def.unit ? ` ${def.unit}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
