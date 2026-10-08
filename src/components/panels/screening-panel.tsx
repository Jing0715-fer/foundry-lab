"use client";

/**
 * ScreeningPanel — 大规模筛选结果评估与排序 (large-scale screening result
 * evaluation & ranking).
 *
 * Owns ALL state & mutations for one selected screening campaign:
 *  - list + detail fetching (GET /api/screening, GET /api/screening/[id])
 *  - candidate patches (PATCH …/candidates — optimistic local update, then
 *    full server refresh with the fresh ALL-candidates array)
 *  - ranking weights (local copy → live client-side re-rank; explicit Save
 *    PATCHes them server-side; subtle "unsaved" dot while dirty)
 *  - search / status / source / per-metric range filters, sorting,
 *    pagination, multi-selection (compare / promote / bulk actions)
 *  - detail drawer, compare dialog, promote dialog, new-screening dialog,
 *    delete confirm, rescan (node/job sources), CSV export.
 *
 * Layout: stats strip + histograms on top; on xl a 300px sticky controls
 * column beside the table; below xl the controls live in a Collapsible.
 */

import * as React from "react";
import {
  Boxes,
  ChevronDown,
  Download,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAppStore } from "@/lib/store";
import type {
  PromoteResultDTO,
  ScreeningCandidateDTO,
  ScreeningDTO,
  ScreeningMetricDef,
} from "@/lib/types";
import {
  applyPreset,
  buildCsv,
  buildScoredRows,
  downloadCsv,
  initWeights,
  weightsDirty as weightsDiffer,
  type ScoredRow,
  type WeightPreset,
} from "@/components/screening/scoring";
import { StatsStrip } from "@/components/screening/stats-strip";
import { ScreeningTable } from "@/components/screening/screening-table";
import {
  ControlsColumn,
  type RangeFilter,
  type StatusFilterKey,
} from "@/components/screening/controls-column";
import { NewScreeningDialog } from "@/components/screening/new-screening-dialog";
import { CandidateDetail, type CandidatePatch } from "@/components/screening/candidate-detail";
import { CompareDialog } from "@/components/screening/compare-dialog";
import { PromoteDialog } from "@/components/screening/promote-dialog";

type SortDir = "asc" | "desc" | null;

/** Optimistically apply a candidate patch locally (server refresh follows). */
function applyCandidatePatch(
  c: ScreeningCandidateDTO,
  patch: CandidatePatch,
): ScreeningCandidateDTO {
  let next = c;
  if (patch.starred !== undefined) next = { ...next, starred: patch.starred };
  if (patch.status !== undefined) next = { ...next, status: patch.status };
  if (patch.notes !== undefined) next = { ...next, notes: patch.notes };
  if (patch.addTags?.length) {
    next = { ...next, tags: Array.from(new Set([...next.tags, ...patch.addTags])) };
  }
  if (patch.removeTags?.length) {
    next = { ...next, tags: next.tags.filter((t) => !patch.removeTags!.includes(t)) };
  }
  return next;
}

export function ScreeningPanel() {
  const toast = useAppStore((s) => s.toast);
  // C2 provenance navigation: openScreening(id) (e.g. a promote node's source
  // badge in the Inspector) switches here with pendingScreeningId set —
  // consume it by selecting that screening, then clear the request.
  const pendingScreeningId = useAppStore((s) => s.pendingScreeningId);
  const clearPendingScreening = React.useCallback(() => {
    if (useAppStore.getState().pendingScreeningId !== null) {
      useAppStore.setState({ pendingScreeningId: null });
    }
  }, []);

  // --- Data ---------------------------------------------------------------
  const [screenings, setScreenings] = React.useState<ScreeningDTO[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [currentId, setCurrentId] = React.useState<string | null>(null);
  const [screening, setScreening] = React.useState<ScreeningDTO | null>(null);
  const [candidates, setCandidates] = React.useState<ScreeningCandidateDTO[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailToken, setDetailToken] = React.useState(0); // force-reload (rollback)

  const reloadDetail = React.useCallback(() => setDetailToken((t) => t + 1), []);

  // Provenance deep-link (C2): a pending id selects that screening once the
  // list is available (guard: only ids that actually exist in the list).
  React.useEffect(() => {
    if (!pendingScreeningId || listLoading) return;
    const exists = screenings.some((s) => s.id === pendingScreeningId);
    if (exists && pendingScreeningId !== currentId) {
      setCurrentId(pendingScreeningId);
    }
    clearPendingScreening();
  }, [pendingScreeningId, listLoading, screenings, currentId, clearPendingScreening]);

  const refreshList = React.useCallback(async () => {
    try {
      const res = await fetch("/api/screening");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.screenings)) {
        setScreenings(data.screenings as ScreeningDTO[]);
      }
    } catch {
      /* best-effort refresh */
    }
  }, []);

  // Initial list load.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/screening");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.screenings)
          ? (data.screenings as ScreeningDTO[])
          : [];
        if (cancelled) return;
        setScreenings(list);
        if (list.length > 0) setCurrentId(list[0].id);
      } catch (e) {
        if (!cancelled) {
          toast({
            title: "Failed to load screenings",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  // Detail load (on selection change / forced reload).
  React.useEffect(() => {
    if (!currentId) {
      setScreening(null);
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/screening/${currentId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setScreening(data?.screening ?? null);
        setCandidates(Array.isArray(data?.candidates) ? (data.candidates as ScreeningCandidateDTO[]) : []);
        setWeights(initWeights(data?.screening ?? null));
      } catch (e) {
        if (!cancelled) {
          toast({
            title: "Failed to load screening",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId, detailToken, toast]);

  // Reset view state when switching screenings.
  React.useEffect(() => {
    setQuery("");
    setStatusFilter("all");
    setSourceFilter([]);
    setRangeFilters({});
    setSelectedIds([]);
    setSortKey("score");
    setSortDir("desc");
    setPage(1);
  }, [currentId]);

  // --- Controls state -----------------------------------------------------
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilterKey>("all");
  const [sourceFilter, setSourceFilter] = React.useState<string[]>([]);
  const [rangeFilters, setRangeFilters] = React.useState<Record<string, RangeFilter>>({});
  const [controlsOpen, setControlsOpen] = React.useState(false);

  // --- Weights ------------------------------------------------------------
  const [weights, setWeights] = React.useState<Record<string, number>>({});
  const [savingWeights, setSavingWeights] = React.useState(false);

  const metricDefs: ScreeningMetricDef[] = screening?.metricDefs ?? [];
  const savedWeights = React.useMemo(() => initWeights(screening), [screening]);
  const dirty = React.useMemo(
    () => weightsDiffer(metricDefs, weights, savedWeights),
    [metricDefs, weights, savedWeights],
  );

  // --- Sort / pagination / selection --------------------------------------
  // Sort cycle on a header click: desc → asc → none → desc. "none" returns
  // the view to the default ordering (rank = composite score over ALL
  // candidates, independent of filters).
  const [sortKey, setSortKey] = React.useState("score");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(25);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  // --- Dialog / drawer state ----------------------------------------------
  const [newOpen, setNewOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const [promoteOpen, setPromoteOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [rescanBusy, setRescanBusy] = React.useState(false);
  const [creatingDemo, setCreatingDemo] = React.useState<"scaffold" | "models" | null>(null);

  // --- Derived data (memoized for smooth 100+ candidate re-ranks) ---------
  const scoredRows = React.useMemo(
    () => buildScoredRows(candidates, metricDefs, weights),
    [candidates, metricDefs, weights],
  );

  const uniqueSources = React.useMemo(
    () => Array.from(new Set(candidates.map((c) => c.source))).sort(),
    [candidates],
  );

  const sourceFilterSet = React.useMemo(() => new Set(sourceFilter), [sourceFilter]);
  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoredRows.filter(({ candidate: c }) => {
      if (q) {
        const hay = `${c.name} ${c.source} ${c.sourceLabel ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter === "starred") {
        if (!c.starred) return false;
      } else if (statusFilter !== "all" && c.status !== statusFilter) {
        return false;
      }
      if (sourceFilterSet.size > 0 && !sourceFilterSet.has(c.source)) return false;
      for (const d of metricDefs) {
        const rf = rangeFilters[d.key];
        if (!rf) continue;
        const minRaw = rf.min.trim();
        const maxRaw = rf.max.trim();
        const minNum = minRaw === "" ? undefined : Number(minRaw);
        const maxNum = maxRaw === "" ? undefined : Number(maxRaw);
        const min =
          minNum !== undefined && Number.isFinite(minNum) ? minNum : undefined;
        const max =
          maxNum !== undefined && Number.isFinite(maxNum) ? maxNum : undefined;
        // A non-empty but invalid input (e.g. "-") disables that bound.
        if ((minRaw !== "" && min === undefined) || (maxRaw !== "" && max === undefined)) {
          continue;
        }
        if (min === undefined && max === undefined) continue;
        const v = c.metrics?.[d.key];
        if (v === undefined || !Number.isFinite(v)) return false;
        if (min !== undefined && v < min) return false;
        if (max !== undefined && v > max) return false;
      }
      return true;
    });
  }, [scoredRows, query, statusFilter, sourceFilterSet, rangeFilters, metricDefs]);

  const sortedRows = React.useMemo(() => {
    if (sortDir === null) return filteredRows; // default rank ordering
    const dir = sortDir === "desc" ? -1 : 1;
    const sortValue = (r: ScoredRow): string | number | undefined => {
      if (sortKey === "name") return r.candidate.name;
      if (sortKey === "length") return r.candidate.length ?? undefined;
      if (sortKey.startsWith("metric:")) return r.candidate.metrics?.[sortKey.slice(7)];
      return r.score; // "score" (rank shares the ordering)
    };
    const rows = [...filteredRows];
    rows.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av === undefined && bv === undefined) return a.rank - b.rank;
      if (av === undefined) return 1; // missing values always last
      if (bv === undefined) return -1;
      const cmp =
        typeof av === "string"
          ? av.localeCompare(bv as string)
          : av - (bv as number);
      if (cmp !== 0) return cmp * dir;
      return a.rank - b.rank; // stable tie-break
    });
    return rows;
  }, [filteredRows, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const pageRows = React.useMemo(
    () => sortedRows.slice((page - 1) * pageSize, page * pageSize),
    [sortedRows, page, pageSize],
  );

  // Reset / clamp pagination.
  React.useEffect(() => {
    setPage(1);
  }, [query, statusFilter, sourceFilter, rangeFilters, sortKey, sortDir, pageSize]);
  React.useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  // Drawer + compare rows.
  const detailRow = React.useMemo(
    () => scoredRows.find((r) => r.candidate.id === detailId) ?? null,
    [scoredRows, detailId],
  );
  const compareRows = React.useMemo(
    () =>
      selectedIds
        .map((id) => scoredRows.find((r) => r.candidate.id === id))
        .filter((r): r is ScoredRow => !!r),
    [selectedIds, scoredRows],
  );

  const activeFilterCount = React.useMemo(() => {
    let n = query.trim() ? 1 : 0;
    if (statusFilter !== "all") n += 1;
    n += sourceFilter.length;
    n += Object.values(rangeFilters).filter(
      (rf) => rf.min.trim() !== "" || rf.max.trim() !== "",
    ).length;
    return n;
  }, [query, statusFilter, sourceFilter, rangeFilters]);

  // --- Mutations ------------------------------------------------------------

  /** Integrate a freshly created screening (dialog POSTs it itself). */
  const handleCreated = React.useCallback(
    (s: ScreeningDTO) => {
      setScreenings((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setCurrentId(s.id);
      toast({
        title: "Screening ready",
        description: `${s.name} · ${s.candidateCount} candidates`,
        variant: "success",
      });
    },
    [toast],
  );

  /** POST a new screening (demo CTAs in the empty state). */
  async function createScreeningFrom(source: {
    kind: "node" | "job" | "demo";
    nodeId?: string;
    jobId?: string;
    demo?: "scaffold" | "models";
  }): Promise<ScreeningDTO | null> {
    try {
      const res = await fetch("/api/screening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const s: ScreeningDTO | undefined = data?.screening;
      if (!s?.id) throw new Error("Malformed response from server");
      handleCreated(s);
      return s;
    } catch (e) {
      toast({
        title: "Failed to create screening",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      return null;
    }
  }

  async function handleDemoCta(demo: "scaffold" | "models") {
    if (creatingDemo) return;
    setCreatingDemo(demo);
    try {
      await createScreeningFrom({ kind: "demo", demo });
    } finally {
      setCreatingDemo(null);
    }
  }

  /** PATCH candidates — optimistic local update, then server refresh. */
  const patchCandidates = React.useCallback(
    async (ids: string[], patch: CandidatePatch) => {
      if (!screening || ids.length === 0) return;
      setCandidates((prev) =>
        prev.map((c) => (ids.includes(c.id) ? applyCandidatePatch(c, patch) : c)),
      );
      try {
        const res = await fetch(`/api/screening/${screening.id}/candidates`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, patch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data?.candidates)) {
          setCandidates(data.candidates as ScreeningCandidateDTO[]);
        }
        void refreshList();
      } catch (e) {
        toast({
          title: "Update failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
        reloadDetail(); // rollback to server truth
      }
    },
    [screening, refreshList, toast, reloadDetail],
  );

  async function saveWeights() {
    if (!screening || !dirty) return;
    setSavingWeights(true);
    try {
      const res = await fetch(`/api/screening/${screening.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data?.screening) {
        setScreening(data.screening as ScreeningDTO);
        setWeights(initWeights(data.screening as ScreeningDTO));
      }
      toast({ title: "Ranking weights saved", variant: "success" });
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingWeights(false);
    }
  }

  async function rescan() {
    if (!screening) return;
    setRescanBusy(true);
    try {
      const res = await fetch(`/api/screening/${screening.id}/rescan`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setScreening(data?.screening ?? screening);
      if (Array.isArray(data?.candidates)) {
        setCandidates(data.candidates as ScreeningCandidateDTO[]);
      }
      toast({
        title: "Rescan complete",
        description:
          data?.added > 0
            ? `${data.added} new candidate(s) harvested`
            : "No new candidates found",
        variant: "success",
      });
      void refreshList();
    } catch (e) {
      toast({
        title: "Rescan failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setRescanBusy(false);
    }
  }

  async function deleteScreening() {
    if (!screening) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/screening/${screening.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const removedId = screening.id;
      const next = screenings.filter((s) => s.id !== removedId);
      setScreenings(next);
      setCurrentId((cur) => (cur === removedId ? (next[0]?.id ?? null) : cur));
      toast({ title: "Screening deleted", variant: "success" });
      setDeleteOpen(false);
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  /** Promote selected candidates onto the canvas. Resolves true on success. */
  async function promote(nodeName: string): Promise<boolean> {
    if (!screening || selectedIds.length === 0) return false;
    try {
      const res = await fetch(`/api/screening/${screening.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Target the CURRENT workflow (multi-workflow contract, task 3-a):
        // without workflowId the server promotes into its first-workflow
        // default, which would land the node on the wrong canvas.
        body: JSON.stringify({
          ids: selectedIds,
          nodeName,
          workflowId: useAppStore.getState().workflow?.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const data: PromoteResultDTO = await res.json();
      if (!data?.node?.id) throw new Error("Malformed response from server");
      useAppStore.getState().upsertNode(data.node);
      useAppStore.getState().select(data.node.id);
      useAppStore.getState().setActivePanel("canvas");
      toast({
        title: `Promoted ${data.promotedIds?.length ?? selectedIds.length} candidates to canvas`,
        description: nodeName,
        variant: "success",
      });
      setSelectedIds([]);
      reloadDetail();
      void refreshList();
      return true;
    } catch (e) {
      toast({
        title: "Promote failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      return false;
    }
  }

  function exportCsv() {
    if (!screening) return;
    // Selection wins when rows are checked; otherwise export ALL candidates
    // (global rank order, independent of the current filters).
    const useSelection = selectedIds.length > 0;
    const rows = useSelection
      ? scoredRows.filter((r) => selectedSet.has(r.candidate.id))
      : scoredRows;
    if (rows.length === 0) {
      toast({ title: "Nothing to export", variant: "default" });
      return;
    }
    const csv = buildCsv(screening, rows, metricDefs);
    const slug =
      screening.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "screening";
    downloadCsv(`${slug}.csv`, csv);
    toast({
      title: "CSV exported",
      description: `${rows.length} row(s)${useSelection ? " (selection)" : ""}`,
      variant: "success",
    });
  }

  // --- Small handlers -------------------------------------------------------

  function handleSort(key: string) {
    if (sortKey === key) {
      // desc → asc → none → desc
      setSortDir((d) => (d === "desc" ? "asc" : d === "asc" ? null : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const pageAllChecked =
    pageRows.length > 0 && pageRows.every((r) => selectedSet.has(r.candidate.id));

  function togglePageAll() {
    const pageIds = pageRows.map((r) => r.candidate.id);
    setSelectedIds((prev) =>
      pageAllChecked
        ? prev.filter((id) => !pageIds.includes(id))
        : Array.from(new Set([...prev, ...pageIds])),
    );
  }

  function setWeight(key: string, value: number) {
    setWeights((prev) => ({ ...prev, [key]: value }));
  }

  function clearFilters() {
    setQuery("");
    setStatusFilter("all");
    setSourceFilter([]);
    setRangeFilters({});
  }

  const canRescan = screening?.sourceType === "node" || screening?.sourceType === "job";

  // --- Render ---------------------------------------------------------------

  const controlsProps = {
    query,
    onQueryChange: setQuery,
    statusFilter,
    onStatusFilterChange: setStatusFilter,
    uniqueSources,
    sourceFilter,
    onToggleSource: (s: string) =>
      setSourceFilter((prev) =>
        prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
      ),
    metricDefs,
    rangeFilters,
    onRangeChange: (key: string, side: "min" | "max", value: string) =>
      setRangeFilters((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { min: "", max: "" }), [side]: value },
      })),
    activeFilterCount,
    onClearFilters: clearFilters,
    weights,
    onWeightChange: setWeight,
    onPreset: (preset: WeightPreset) => setWeights(applyPreset(preset, metricDefs)),
    onResetWeights: () => setWeights(initWeights(screening)),
    onSaveWeights: saveWeights,
    weightsDirtyFlag: dirty,
    savingWeights,
  };

  return (
    <div className="fade-in-up space-y-4 p-4 md:p-6">
      {/* Panel header */}
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          <span className="gradient-text">Screening</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Evaluate & rank large candidate pools — filter, weight, shortlist,
          and promote the winners back onto the canvas.
        </p>
      </div>

      {/* Loading state */}
      {listLoading && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      )}

      {/* Empty state — two big demo CTAs */}
      {!listLoading && screenings.length === 0 && (
        <Card className="card-lift-hover">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <FlaskConical className="size-7 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-medium">No screening campaigns yet</h3>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                Harvest design candidates from RFdiffusion / AlphaFold runs —
                rank by pLDDT, pTM, helix%, clashes… then star, shortlist, and
                promote winners back to the workflow canvas.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                className="h-12 gap-2 px-6"
                disabled={creatingDemo !== null}
                onClick={() => handleDemoCta("scaffold")}
              >
                {creatingDemo === "scaffold" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <Boxes className="size-5" />
                )}
                {creatingDemo === "scaffold" ? "Running real engines…" : "Run scaffold campaign"}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 gap-2 px-6"
                disabled={creatingDemo !== null}
                onClick={() => handleDemoCta("models")}
              >
                {creatingDemo === "models" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <Sparkles className="size-5" />
                )}
                {creatingDemo === "models" ? "Running real engines…" : "Run AF2 model ranking"}
              </Button>
            </div>
            {creatingDemo && (
              <p className="text-xs text-muted-foreground">
                Running the real diffusion / fold engines — this can take 1–2
                minutes. Keep this panel open.
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-11 gap-1.5 md:h-9"
              onClick={() => setNewOpen(true)}
            >
              <Plus className="size-4" />
              Or create from canvas nodes / tool jobs
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Main screening view */}
      {!listLoading && screenings.length > 0 && (
        <>
          {/* Header row: screening picker + actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={currentId ?? undefined}
              onValueChange={(v) => setCurrentId(v)}
            >
              <SelectTrigger
                className="h-11 min-w-0 flex-1 md:h-9 md:max-w-xs"
                aria-label="Select screening campaign"
              >
                <SelectValue placeholder="Select a screening…" />
              </SelectTrigger>
              <SelectContent>
                {screenings.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="truncate">{s.name}</span>
                    <Badge variant="secondary" className="ml-1.5 text-[10px] tabular-nums">
                      {s.candidateCount}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="sm"
              className="h-11 gap-1.5 md:h-9"
              onClick={() => setNewOpen(true)}
            >
              <Plus className="size-4" />
              New
            </Button>
            {canRescan && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 gap-1.5 md:h-9"
                onClick={rescan}
                disabled={rescanBusy || detailLoading}
                title="Re-harvest candidates from the source"
              >
                {rescanBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                <span className={rescanBusy ? "hidden sm:inline" : ""}>
                  {rescanBusy ? "Rescanning…" : "Rescan"}
                </span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-11 gap-1.5 md:h-9"
              onClick={exportCsv}
              disabled={detailLoading}
              title={
                selectedIds.length > 0
                  ? "Export the selected rows"
                  : "Export all candidates"
              }
            >
              <Download className="size-4" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 gap-1.5 text-destructive hover:text-destructive md:h-9"
                  disabled={detailLoading}
                  aria-label="Delete this screening"
                >
                  <Trash2 className="size-4" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete screening?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes “{screening?.name}” and its{" "}
                    {screening?.candidateCount} candidate(s). Promoted canvas
                    nodes are not affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    disabled={deleteBusy}
                    onClick={(e) => {
                      e.preventDefault(); // keep open until our async work done
                      void deleteScreening();
                    }}
                  >
                    {deleteBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {/* Stats strip + histograms */}
          {detailLoading ? (
            <Card>
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-20 w-full" />
                <div className="flex gap-3 overflow-hidden">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-36 shrink-0" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <StatsStrip candidates={candidates} metricDefs={metricDefs} />
          )}

          {/* Controls + results */}
          <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
            {/* xl+: sticky controls column */}
            <div className="hidden xl:sticky xl:top-0 xl:block xl:max-h-[calc(100vh-9rem)] xl:self-start xl:overflow-y-auto">
              <ControlsColumn {...controlsProps} />
            </div>
            {/* below xl: collapsible controls */}
            <div className="xl:hidden">
              <Collapsible open={controlsOpen} onOpenChange={setControlsOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-11 w-full justify-between md:h-10"
                    aria-expanded={controlsOpen}
                  >
                    <span className="flex items-center gap-2">
                      <SlidersHorizontal className="size-4" />
                      Filters &amp; ranking
                      {activeFilterCount > 0 && (
                        <Badge variant="secondary" className="text-[10px] tabular-nums">
                          {activeFilterCount}
                        </Badge>
                      )}
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform",
                        controlsOpen && "rotate-180",
                      )}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <ControlsColumn {...controlsProps} />
                </CollapsibleContent>
              </Collapsible>
            </div>

            {/* Results table */}
            <div className="min-w-0">
              {detailLoading ? (
                <Card>
                  <CardContent className="space-y-2 p-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <Skeleton key={i} className="h-11 w-full" />
                    ))}
                  </CardContent>
                </Card>
              ) : (
                <ScreeningTable
                  rows={pageRows}
                  totalRows={sortedRows.length}
                  metricDefs={metricDefs}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  page={page}
                  pageSize={pageSize}
                  onPageChange={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
                  onPageSizeChange={(n) => setPageSize(n)}
                  selectedIds={selectedSet}
                  onToggleSelect={toggleSelect}
                  onTogglePageAll={togglePageAll}
                  onStar={(id, starred) => void patchCandidates([id], { starred })}
                  onView={(id) => setDetailId(id)}
                  onBulkStar={() => void patchCandidates(selectedIds, { starred: true })}
                  onBulkStatus={(status) =>
                    void patchCandidates(selectedIds, { status })
                  }
                  onClearSelection={() => setSelectedIds([])}
                  onCompare={() => setCompareOpen(true)}
                  onPromote={() => setPromoteOpen(true)}
                  onExportCsv={exportCsv}
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* Dialogs & drawer */}
      <NewScreeningDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSuccess={handleCreated}
      />
      <CandidateDetail
        open={!!detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        candidate={detailRow?.candidate ?? null}
        metricDefs={metricDefs}
        score={detailRow?.score ?? null}
        rank={detailRow?.rank ?? null}
        onPatch={(ids, patch) => void patchCandidates(ids, patch)}
      />
      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        rows={compareRows}
        metricDefs={metricDefs}
        onOpenCandidate={(id) => setDetailId(id)}
      />
      <PromoteDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        screeningName={screening?.name ?? ""}
        count={selectedIds.length}
        onConfirm={promote}
      />
    </div>
  );
}

export default ScreeningPanel;

