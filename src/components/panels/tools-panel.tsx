"use client";

import * as React from "react";
import {
  Wrench,
  FlaskConical,
  Play,
  Search,
  Loader2,
  Clock,
  Eye,
  Atom,
  Beaker,
  Dna,
  Box,
  Database,
  Download,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/lib/store";
import { COMP_TOOLS, getCompTool, buildCommand } from "@/lib/tools";
import type { CompToolDef, CompParamField } from "@/lib/tools";
import type { ToolJobDTO } from "@/lib/types";
import type { BioResult } from "@/lib/bio-tools";
import { OutputViewerDialog } from "@/components/viewers/output-viewer-dialog";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Detect whether a ToolJob's stdout indicates a simulated run. The
 * real-executor (src/lib/real-executor.ts) prefixes simulated output with
 * `[SIMULATED — ...]`; the legacy executor (executeCompTool →
 * simulateCompRun) emits `(simulated)` in its first line and
 * `FOUNDRY-LAB SIMULATION` in the PDB REMARK. We treat any of those as
 * evidence the run was a simulation rather than a real algorithm.
 */
function isSimulatedJob(job: ToolJobDTO): boolean {
  if (job.params && job.params.simulated === true) return true;
  const out = job.stdout ?? "";
  if (/^\[SIMULATED/i.test(out)) return true;
  if (/\(simulated\)/i.test(out)) return true;
  if (/FOUNDRY-LAB SIMULATION/i.test(out)) return true;
  if (job.command && /^\[SIMULATED\]/i.test(job.command)) return true;
  return false;
}

/** Build the per-file download URL (matches the [id]/file route). */
function fileDownloadUrl(jobId: string, path: string): string {
  return `/api/tools/jobs/${jobId}/file?path=${encodeURIComponent(path)}`;
}

const COMP_TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  atom: Atom,
  beaker: Beaker,
  dna: Dna,
  "flask-conical": FlaskConical,
};

/** Output-type meta for the small chip on each Recent Jobs row. */
const OUTPUT_TYPE_META: Record<
  string,
  { Icon: React.ComponentType<{ className?: string }>; label: string; chip: string }
> = {
  // structure-producing tools → Box icon (teal)
  rfdiffusion: { Icon: Box, label: "structure", chip: "bg-teal-500/10 text-teal-700 dark:text-teal-400" },
  rfantibody: { Icon: Box, label: "structure", chip: "bg-teal-500/10 text-teal-700 dark:text-teal-400" },
  rosetta: { Icon: Box, label: "structure", chip: "bg-teal-500/10 text-teal-700 dark:text-teal-400" },
  pyrosetta: { Icon: Box, label: "structure", chip: "bg-teal-500/10 text-teal-700 dark:text-teal-400" },
  // structure-prediction tools → Box icon (cyan)
  rf3: { Icon: Box, label: "structure", chip: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400" },
  esmfold: { Icon: Box, label: "structure", chip: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400" },
  colabfold: { Icon: Box, label: "structure", chip: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400" },
  // sequence-producing tools → Dna icon (violet)
  proteinmpnn: { Icon: Dna, label: "sequence", chip: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  ligandmpnn: { Icon: Dna, label: "sequence", chip: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  solublempnn: { Icon: Dna, label: "sequence", chip: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
};

/** Fallback for bio tools (BLAST / PDB / PubMed / UniProt) → Database icon (cyan). */
const OUTPUT_TYPE_FALLBACK = {
  Icon: Database,
  label: "bio",
  chip: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
};

export function ToolsPanel() {
  const toast = useAppStore((s) => s.toast);

  // Comp tool state.
  const [toolKey, setToolKey] = React.useState<string>(COMP_TOOLS[0]?.key ?? "rfdiffusion");
  const [compParams, setCompParams] = React.useState<Record<string, unknown>>({});
  const [compRunning, setCompRunning] = React.useState(false);

  // Bio tool state.
  const [bioKey, setBioKey] = React.useState<"blast" | "pdb" | "pubmed" | "uniprot">("blast");
  const [bioQuery, setBioQuery] = React.useState("");
  const [bioMax, setBioMax] = React.useState(5);
  const [blastProgram, setBlastProgram] = React.useState("blastp");
  const [blastDatabase, setBlastDatabase] = React.useState("swissprot");
  const [blastExpect, setBlastExpect] = React.useState(10);
  const [bioRunning, setBioRunning] = React.useState(false);
  const [bioResult, setBioResult] = React.useState<BioResult | null>(null);

  // Jobs state.
  const [jobs, setJobs] = React.useState<ToolJobDTO[]>([]);
  const [loadingJobs, setLoadingJobs] = React.useState(true);
  const [viewJob, setViewJob] = React.useState<ToolJobDTO | null>(null);
  const [expandedJobId, setExpandedJobId] = React.useState<string | null>(null);

  const refreshJobs = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tools/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  React.useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  // Poll while any job is in a non-terminal state — surfaces live progress
  // for real (long-running) tool executions and re-syncs the Recent Jobs
  // list without manual refresh.
  React.useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === "running" || j.status === "pending" || j.status === "queued",
    );
    if (!hasActive) return;
    const id = setInterval(refreshJobs, 2000);
    return () => clearInterval(id);
  }, [jobs, refreshJobs]);

  // When tool changes, reset params to defaults.
  React.useEffect(() => {
    const def = getCompTool(toolKey);
    if (!def) return;
    const next: Record<string, unknown> = {};
    for (const f of def.paramFields) next[f.key] = f.default;
    setCompParams(next);
  }, [toolKey]);

  const activeTool: CompToolDef | undefined = getCompTool(toolKey);
  const commandPreview = activeTool
    ? buildCommand(activeTool, compParams)
    : "";

  const setParam = (key: string, v: unknown) =>
    setCompParams((prev) => ({ ...prev, [key]: v }));

  const handleRunComp = async () => {
    if (!activeTool) return;
    setCompRunning(true);
    try {
      const res = await fetch("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: toolKey,
          params: compParams,
          triggeredBy: "user",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const job: ToolJobDTO = await res.json();
      toast({
        title: `${activeTool.label} completed`,
        description: "Simulated job added to recent jobs.",
        variant: "success",
      });
      setJobs((prev) => [job, ...prev]);
    } catch (e) {
      toast({
        title: "Tool run failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setCompRunning(false);
    }
  };

  const handleRunBio = async () => {
    setBioRunning(true);
    setBioResult(null);
    try {
      const params: Record<string, unknown> = { maxResults: bioMax };
      if (bioKey === "blast") {
        if (!bioQuery.trim()) throw new Error("Sequence is required for BLAST");
        params.sequence = bioQuery;
        params.program = blastProgram;
        params.database = blastDatabase;
        params.expect = blastExpect;
      } else if (bioKey === "pdb") {
        params.query = bioQuery || undefined;
      } else {
        if (!bioQuery.trim()) throw new Error("Query is required");
        params.query = bioQuery;
      }
      const res = await fetch(`/api/bio-tools/${bioKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const result: BioResult = await res.json();
      setBioResult(result);
      toast({
        title: `${bioKey.toUpperCase()} returned ${result.count} hit${result.count === 1 ? "" : "s"}`,
        description: result.simulated ? "Simulated (offline fallback)" : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Bio query failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setBioRunning(false);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Tools</h2>
        <p className="text-sm text-muted-foreground">
          Run computational protein-design tools and bioinformatics queries directly.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Comp tools card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4" />
              Computational Tools
            </CardTitle>
            <CardDescription className="text-xs">
              Simulated runs — backend invokes executeCompTool and stores a completed ToolJob.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <Label>Tool</Label>
              <Select value={toolKey} onValueChange={setToolKey}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMP_TOOLS.map((t) => {
                    const Icon = COMP_TOOL_ICONS[t.icon] ?? Wrench;
                    return (
                      <SelectItem key={t.key} value={t.key}>
                        <span className="flex items-center gap-2">
                          <Icon className="size-3.5" />
                          {t.label}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {activeTool && (
              <p className="text-xs text-muted-foreground">{activeTool.description}</p>
            )}

            {activeTool && (
              <div className="space-y-3">
                {activeTool.paramFields.map((f) => (
                  <ParamField
                    key={f.key}
                    field={f}
                    value={compParams[f.key] ?? f.default}
                    onChange={(v) => setParam(f.key, v)}
                  />
                ))}
              </div>
            )}

            {commandPreview && (
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Command preview</Label>
                <code className="block overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                  {commandPreview}
                </code>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleRunComp} disabled={compRunning || !activeTool}>
                {compRunning ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Run (simulated)
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Bio tools card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4" />
              Bioinformatics Tools
            </CardTitle>
            <CardDescription className="text-xs">
              BLAST / PDB / PubMed / UniProt — live queries with simulated fallback.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <Label>Tool</Label>
              <Select
                value={bioKey}
                onValueChange={(v: "blast" | "pdb" | "pubmed" | "uniprot") => {
                  setBioKey(v);
                  setBioResult(null);
                  setBioQuery("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blast">BLAST — sequence homology</SelectItem>
                  <SelectItem value="pdb">PDB — structure search</SelectItem>
                  <SelectItem value="pubmed">PubMed — literature</SelectItem>
                  <SelectItem value="uniprot">UniProt — annotation</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="bio-query">
                {bioKey === "blast" ? "Sequence (FASTA / raw)" : "Query"}
              </Label>
              {bioKey === "blast" ? (
                <Textarea
                  id="bio-query"
                  value={bioQuery}
                  onChange={(e) => setBioQuery(e.target.value)}
                  placeholder="MTAIIKE…IYFV"
                  rows={4}
                  className="font-mono text-xs"
                />
              ) : (
                <Input
                  id="bio-query"
                  value={bioQuery}
                  onChange={(e) => setBioQuery(e.target.value)}
                  placeholder={
                    bioKey === "pdb"
                      ? "e.g. antibody (or PDB id)"
                      : bioKey === "pubmed"
                        ? "e.g. nanobody neutralization"
                        : "e.g. kinase (or accession P12345)"
                  }
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="bio-max">Max results</Label>
                <Input
                  id="bio-max"
                  type="number"
                  min={1}
                  max={10}
                  value={bioMax}
                  onChange={(e) => setBioMax(Math.max(1, Math.min(10, Number(e.target.value) || 5)))}
                />
              </div>
              {bioKey === "blast" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="blast-program">Program</Label>
                  <Select value={blastProgram} onValueChange={setBlastProgram}>
                    <SelectTrigger className="w-full" id="blast-program">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blastp">blastp</SelectItem>
                      <SelectItem value="blastn">blastn</SelectItem>
                      <SelectItem value="psi-blast">psi-blast</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div />
              )}
            </div>

            {bioKey === "blast" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="blast-db">Database</Label>
                  <Input
                    id="blast-db"
                    value={blastDatabase}
                    onChange={(e) => setBlastDatabase(e.target.value)}
                    placeholder="swissprot"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="blast-evalue">Expect (e-value)</Label>
                  <Input
                    id="blast-evalue"
                    type="number"
                    min={0}
                    step={0.1}
                    value={blastExpect}
                    onChange={(e) => setBlastExpect(Number(e.target.value) || 10)}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {bioResult && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBioResult(null)}
                  disabled={bioRunning}
                >
                  Clear results
                </Button>
              )}
              <Button onClick={handleRunBio} disabled={bioRunning}>
                {bioRunning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                Search
              </Button>
            </div>

            {bioResult && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium uppercase tracking-wide">{bioResult.tool} · {bioResult.count} hits</span>
                  {bioResult.simulated && (
                    <Badge variant="outline" className="text-[10px]">simulated</Badge>
                  )}
                </div>
                {bioResult.hits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No hits.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {bioResult.hits.map((h, i) => (
                      <li key={`${h.id}-${i}`} className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-foreground">{h.id}</span>
                          {h.meta && Object.keys(h.meta).length > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {Object.entries(h.meta)
                                .slice(0, 3)
                                .map(([k, v]) => `${k}=${v}`)
                                .join(" · ")}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-muted-foreground">{h.title}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent jobs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4" />
              Recent Tool Jobs
              {jobs.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {jobs.length}
                </Badge>
              )}
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshJobs}
              disabled={loadingJobs}
              className="h-7 gap-1 text-xs"
            >
              <RefreshCw className={`size-3.5 ${loadingJobs ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingJobs ? (
            <PanelSkeleton count={3} />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="No tool runs yet"
              description="Run a comp or bio tool above."
            />
          ) : (
            <ul className="space-y-2">
              {jobs.map((job) => {
                const def = COMP_TOOLS.find((t) => t.key === job.tool);
                const JobIcon = (def && COMP_TOOL_ICONS[def.icon]) || Wrench;
                const outputMeta =
                  OUTPUT_TYPE_META[job.tool] ?? OUTPUT_TYPE_FALLBACK;
                const OutputIcon = outputMeta.Icon;
                const simulated = isSimulatedJob(job);
                const isActive =
                  job.status === "running" ||
                  job.status === "pending" ||
                  job.status === "queued";
                const statusPill =
                  job.status === "completed"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : job.status === "failed"
                      ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                      : isActive
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-muted text-muted-foreground";
                const isExpanded = expandedJobId === job.id;
                return (
                  <li
                    key={job.id}
                    className={`rounded-md border transition-colors ${
                      isExpanded ? "border-primary/40" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedJobId((id) => (id === job.id ? null : job.id))
                        }
                        className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground hover:bg-accent"
                        title={isExpanded ? "Hide preview" : "Show preview"}
                        aria-label={isExpanded ? "Hide preview" : "Show preview"}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                      </button>
                      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <JobIcon className="size-3.5" />
                      </span>
                      <span
                        className={`flex size-5 items-center justify-center rounded-[4px] ${outputMeta.chip}`}
                        title={`Output type: ${outputMeta.label}`}
                      >
                        <OutputIcon className="size-3" />
                      </span>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {job.tool}
                      </Badge>
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium ${statusPill}`}
                      >
                        {isActive && <Loader2 className="size-2.5 animate-spin" />}
                        {job.status}
                      </span>
                      {/* REAL / SIMULATED badge — surfaces whether the run
                          used a real algorithm or fell back to the
                          synthetic generator. */}
                      <Badge
                        variant="outline"
                        className={
                          simulated
                            ? "border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
                            : "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
                        }
                        title={
                          simulated
                            ? "This run used the synthetic generator (no real tool was installed)"
                            : "This run used a real algorithm"
                        }
                      >
                        {simulated ? "SIMULATED" : "REAL"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        by {job.triggeredBy || "user"}
                      </span>
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" />
                        {timeAgo(job.createdAt)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setViewJob(job)}
                      >
                        <Eye className="size-3.5" />
                        View output
                      </Button>
                    </div>
                    {/* Inline preview — collapsible stdout + per-file
                        download buttons. Shown when the row is expanded so
                        users can scan results without opening the dialog. */}
                    {isExpanded && (
                      <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
                        {job.stdout ? (
                          <div>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              stdout
                            </p>
                            <pre className="max-h-64 overflow-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                              {job.stdout}
                            </pre>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No stdout captured for this job.
                          </p>
                        )}
                        {job.stderr && (
                          <div>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-destructive">
                              stderr
                            </p>
                            <pre className="max-h-32 overflow-auto rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive whitespace-pre-wrap break-words">
                              {job.stderr}
                            </pre>
                          </div>
                        )}
                        {job.outputFiles.length > 0 && (
                          <div>
                            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              output files ({job.outputFiles.length})
                            </p>
                            <ul className="flex flex-wrap gap-1.5">
                              {job.outputFiles.map((f, i) => (
                                <li key={`${f}-${i}`}>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    asChild
                                    className="h-7 gap-1 px-2 text-[11px]"
                                  >
                                    <a
                                      href={fileDownloadUrl(job.id, f)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      <Download className="size-3" />
                                      <code className="font-mono">
                                        {f.split("/").pop() ?? f}
                                      </code>
                                    </a>
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Job output dialog (tabbed: Summary / Structure / Sequence / Files / Command) */}
      <OutputViewerDialog
        job={viewJob}
        open={!!viewJob}
        onClose={() => setViewJob(null)}
      />
    </div>
  );
}

function ParamField({
  field,
  value,
  onChange,
}: {
  field: CompParamField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const labelEl = (
    <Label className="text-xs">
      {field.label}
      {field.unit && <span className="ml-1 text-muted-foreground">({field.unit})</span>}
    </Label>
  );

  if (field.type === "bool") {
    return (
      <div className="flex items-center justify-between rounded-md border p-2.5">
        <div>
          {labelEl}
          {field.hint && <p className="text-[10px] text-muted-foreground">{field.hint}</p>}
        </div>
        <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="grid gap-1.5">
        {labelEl}
        <Select value={String(value)} onValueChange={(v) => onChange(v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div className="grid gap-1.5">
        {labelEl}
        <Input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value as number}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {field.hint && <p className="text-[10px] text-muted-foreground">{field.hint}</p>}
      </div>
    );
  }

  // text | path
  return (
    <div className="grid gap-1.5">
      {labelEl}
      <Input
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.hint ?? ""}
      />
      {field.hint && <p className="text-[10px] text-muted-foreground">{field.hint}</p>}
    </div>
  );
}
