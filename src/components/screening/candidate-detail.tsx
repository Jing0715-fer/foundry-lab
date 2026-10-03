"use client";

/**
 * CandidateDetail — right Sheet drawer for ONE screening candidate.
 *
 * Header: name, source badges, star toggle, status Select, rank + score chip.
 * Body: metrics grid (label, value, unit, quality color, normalized bar,
 * domain range, hint tooltip) · sequence block (monospace, fasta-style letter
 * coloring) · tags editor · notes Textarea + Save · status quick actions ·
 * file section REUSING <InlineResults> for the linked PDB/FASTA files
 * (served via /api/tools/file?path=…). All mutations are applied through the
 * parent's onPatch (optimistic + server round-trip).
 */

import * as React from "react";
import {
  BookmarkCheck,
  Box,
  Check,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Star,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineResults } from "@/components/viewers/inline-results";
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
} from "./scoring";
import { STATUS_BADGE } from "./screening-table";

/** Mutations the drawer can request (handled by the parent panel). */
export interface CandidatePatch {
  starred?: boolean;
  status?: ScreeningCandidateStatus;
  addTags?: string[];
  removeTags?: string[];
  notes?: string;
}

interface CandidateDetailProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  candidate: ScreeningCandidateDTO | null;
  metricDefs: ScreeningMetricDef[];
  score: number | null;
  rank: number | null;
  onPatch: (ids: string[], patch: CandidatePatch) => void;
}

const STATUSES: ScreeningCandidateStatus[] = [
  "new",
  "shortlisted",
  "rejected",
  "promoted",
];

// Fasta-style letter coloring (simple scheme, grouped into runs when rendered).
const AA_COLOR: Record<string, string> = {
  A: "aa-hydro", V: "aa-hydro", I: "aa-hydro", L: "aa-hydro", M: "aa-hydro",
  F: "aa-hydro", W: "aa-hydro", Y: "aa-hydro", C: "aa-hydro",
  N: "aa-polar", Q: "aa-polar", S: "aa-polar", T: "aa-polar",
  D: "aa-neg", E: "aa-neg",
  K: "aa-pos", R: "aa-pos", H: "aa-pos",
};
const AA_CLASS: Record<string, string> = {
  "aa-hydro": "text-amber-600 dark:text-amber-400",
  "aa-polar": "text-emerald-600 dark:text-emerald-400",
  "aa-neg": "text-rose-600 dark:text-rose-400",
  "aa-pos": "text-violet-600 dark:text-violet-400",
};

export function CandidateDetail({
  open,
  onOpenChange,
  candidate,
  metricDefs,
  score,
  rank,
  onPatch,
}: CandidateDetailProps) {
  const id = candidate?.id ?? null;

  // Notes editor state — reset when the candidate changes.
  const [notesDraft, setNotesDraft] = React.useState("");
  const [notesDirty, setNotesDirty] = React.useState(false);
  const [savingNotes, setSavingNotes] = React.useState(false);

  // Tags editor state.
  const [tagInput, setTagInput] = React.useState("");

  React.useEffect(() => {
    setNotesDraft(candidate?.notes ?? "");
    setNotesDirty(false);
    setTagInput("");
  }, [id, candidate?.notes]);

  if (!candidate) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle className="sr-only">Candidate details</SheetTitle>
            <SheetDescription className="sr-only">
              Inspect a screening candidate.
            </SheetDescription>
            <Skeleton className="h-6 w-2/3" />
          </SheetHeader>
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const q = score !== null ? scoreColorClass(score) : "neutral";
  const files = [candidate.pdbPath, candidate.fastaPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );

  async function saveNotes() {
    if (!id || notesDirty === false) return;
    setSavingNotes(true);
    try {
      onPatch([id], { notes: notesDraft });
      setNotesDirty(false);
    } finally {
      setSavingNotes(false);
    }
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!id || !t || candidate?.tags.includes(t)) {
      setTagInput("");
      return;
    }
    onPatch([id], { addTags: [t] });
    setTagInput("");
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="space-y-2 border-b">
          <SheetTitle className="flex items-start gap-2 pr-8">
            <span className="min-w-0 flex-1 break-words text-base leading-tight">
              {candidate.name}
            </span>
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] lowercase">
                {candidate.source}
              </Badge>
              {candidate.sourceLabel && (
                <span className="text-xs text-muted-foreground">
                  {candidate.sourceLabel}
                </span>
              )}
              {rank !== null && score !== null && (
                <span className="ml-auto flex items-center gap-1.5 text-xs">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium tabular-nums">
                    #{rank}
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 font-semibold tabular-nums",
                      q === "emerald"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : q === "amber"
                          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          : "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                    )}
                  >
                    {score.toFixed(1)}
                  </span>
                </span>
              )}
            </div>
          </SheetDescription>

          {/* Header actions: star · status */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-11 gap-1.5 px-3 md:h-9"
              onClick={() => onPatch([candidate.id], { starred: !candidate.starred })}
              aria-pressed={candidate.starred}
              aria-label={candidate.starred ? "Unstar candidate" : "Star candidate"}
            >
              <Star
                className={cn(
                  "size-4",
                  candidate.starred && "fill-amber-400 text-amber-400",
                )}
              />
              {candidate.starred ? "Starred" : "Star"}
            </Button>
            <Select
              value={candidate.status}
              onValueChange={(v) =>
                onPatch([candidate.id], { status: v as ScreeningCandidateStatus })
              }
            >
              <SelectTrigger
                className="h-11 w-[150px] md:h-9"
                aria-label="Candidate status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              className={cn(
                "ml-auto hidden rounded-md px-2 py-0.5 text-xs font-medium capitalize md:inline-flex",
                STATUS_BADGE[candidate.status] ?? STATUS_BADGE.new,
              )}
            >
              {candidate.status}
            </span>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {/* Metrics grid */}
          {metricDefs.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Metrics
              </h4>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {metricDefs.map((def) => {
                  const raw = candidate.metrics?.[def.key];
                  const present =
                    raw !== undefined && raw !== null && Number.isFinite(raw);
                  const mq = present ? qualityClass(raw, def) : "neutral";
                  const n = present ? normalize(raw, def) : 0;
                  return (
                    <div key={def.key} className="rounded-lg border p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help truncate text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2">
                              {def.label}
                              {def.unit ? ` (${def.unit})` : ""}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-52">
                            <p className="text-xs">
                              {def.hint ??
                                `${def.label} — ${def.higherIsBetter ? "higher is better" : "lower is better"}`}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                        <span
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            present ? QUALITY_TEXT[mq] : "text-muted-foreground",
                          )}
                        >
                          {present ? formatMetric(raw) : "—"}
                        </span>
                      </div>
                      <Progress
                        value={Math.round(n * 100)}
                        className={cn(
                          "mt-2 h-1",
                          mq === "emerald"
                            ? "[&>div]:bg-emerald-500"
                            : mq === "amber"
                              ? "[&>div]:bg-amber-500"
                              : mq === "rose"
                                ? "[&>div]:bg-rose-500"
                                : "[&>div]:bg-muted-foreground/60",
                        )}
                      />
                      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
                        <span>min {formatMetric(def.domain[0])}</span>
                        <span>{def.higherIsBetter ? "↑ better" : "↓ better"}</span>
                        <span>max {formatMetric(def.domain[1])}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Sequence */}
          {candidate.sequence && (
            <section className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Sequence
                <span className="ml-2 font-normal normal-case">
                  {candidate.length ?? candidate.sequence.length} residues
                </span>
              </h4>
              <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/60 p-2.5 font-mono text-[11px] leading-5 break-all">
                {renderSequence(candidate.sequence)}
              </div>
            </section>
          )}

          {/* Tags editor */}
          <section className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tags
            </h4>
            <div className="flex flex-wrap items-center gap-1.5">
              {candidate.tags.length === 0 && (
                <span className="text-xs text-muted-foreground">No tags yet.</span>
              )}
              {candidate.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                >
                  #{t}
                  <button
                    type="button"
                    onClick={() => onPatch([candidate.id], { removeTags: [t] })}
                    className="rounded-full p-0.5 transition-colors hover:bg-rose-500/20 hover:text-rose-600 dark:hover:text-rose-400"
                    aria-label={`Remove tag ${t}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Add a tag…"
                className="h-11 md:h-9"
                aria-label="New tag"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-11 shrink-0 gap-1 md:h-9"
                onClick={addTag}
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
          </section>

          {/* Notes */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="candidate-notes">Notes</Label>
              <Button
                size="sm"
                variant="outline"
                className="h-11 gap-1 md:h-8"
                disabled={!notesDirty || savingNotes}
                onClick={saveNotes}
              >
                {savingNotes ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save
              </Button>
            </div>
            <Textarea
              id="candidate-notes"
              value={notesDraft}
              onChange={(e) => {
                setNotesDraft(e.target.value);
                setNotesDirty(true);
              }}
              rows={3}
              placeholder="Why this design looks promising (or not)…"
            />
          </section>

          {/* Status quick actions */}
          <section className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Quick actions
            </h4>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-11 gap-1.5 md:h-9"
                onClick={() => onPatch([candidate.id], { status: "shortlisted" })}
              >
                <BookmarkCheck className="size-4 text-teal-600 dark:text-teal-400" />
                Shortlist
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-11 gap-1.5 text-rose-600 hover:text-rose-600 dark:text-rose-400 md:h-9"
                onClick={() => onPatch([candidate.id], { status: "rejected" })}
              >
                <XCircle className="size-4" />
                Reject
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-11 gap-1.5 md:h-9"
                onClick={() => onPatch([candidate.id], { status: "new" })}
              >
                <RotateCcw className="size-4" />
                Reset
              </Button>
            </div>
          </section>

          {/* Files — REUSE InlineResults (PDB 3D + FASTA viewers) */}
          <section className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Box className="size-3.5" />
              Structure files
            </h4>
            {files.length > 0 ? (
              <div className="rounded-lg border">
                <InlineResults
                  files={files}
                  fileUrl={(p) => `/api/tools/file?path=${encodeURIComponent(p)}`}
                  executor="builtin-engine"
                  compact
                  summary={`Harvested from ${candidate.source}${
                    candidate.sourceLabel ? ` · ${candidate.sourceLabel}` : ""
                  } · ${files.length} file${files.length === 1 ? "" : "s"}`}
                />
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                No structure files linked.
              </p>
            )}
          </section>

          {/* Provenance footer */}
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3 text-emerald-500" />
            Created {candidate.createdAt ? new Date(candidate.createdAt).toLocaleString() : "—"}
            {candidate.fileCount > 0 && ` · ${candidate.fileCount} file(s)`}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Render a sequence as colored runs (fasta-style). */
function renderSequence(seq: string): React.ReactNode[] {
  const runs: { cls: string; text: string }[] = [];
  for (const ch of seq.toUpperCase()) {
    const cls = AA_CLASS[AA_COLOR[ch] ?? ""] ?? "text-muted-foreground";
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.text += ch;
    else runs.push({ cls, text: ch });
  }
  return runs.map((r, i) => (
    <span key={i} className={r.cls}>
      {r.text}
    </span>
  ));
}
