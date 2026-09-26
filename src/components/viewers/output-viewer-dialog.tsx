"use client";

import * as React from "react";
import {
  ScrollText,
  Box,
  Dna,
  FileIcon,
  TerminalSquare,
  Download,
  Check,
  Wrench,
  Loader2,
  ExternalLink,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolJobDTO } from "@/lib/types";
import { PdbViewer, generateSamplePdb } from "./pdb-viewer";
import { FastaViewer, generateSampleFasta } from "./fasta-viewer";

// --- Helpers ------------------------------------------------------------------

/**
 * Tools that produce PDB files (the Structure tab is shown for these).
 * Includes all design + structure-prediction + scoring tools — every comp
 * tool that emits .pdb output via the simulated generators in
 * src/app/api/tools/jobs/[id]/file/route.ts.
 */
const STRUCTURE_TOOLS = new Set([
  "rfdiffusion",
  "rfantibody",
  "rosetta",
  "pyrosetta",
  "rf3",
  "esmfold",
  "colabfold",
]);
/** Tools that produce FASTA files (the Sequence tab is shown for these). */
const SEQUENCE_TOOLS = new Set(["proteinmpnn", "ligandmpnn", "solublempnn"]);

// Used as the fallback when the file fetch fails (e.g. server unreachable).
const SAMPLE_PDB = generateSamplePdb();
const SAMPLE_FASTA = generateSampleFasta();

/** Build the API URL for fetching a single output file's content. */
function fileApiUrl(jobId: string, path: string): string {
  return `/api/tools/jobs/${jobId}/file?path=${encodeURIComponent(path)}`;
}

function statusPillClass(status: string): string {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (status === "failed") return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
  if (status === "running") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

/**
 * Detect whether the job's stdout indicates a simulated run. Mirrors the
 * detection in tools-panel.tsx so the badge in the dialog header matches
 * the badge in the Recent Jobs list.
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

// --- Component ----------------------------------------------------------------

export interface OutputViewerDialogProps {
  job: ToolJobDTO | null;
  open: boolean;
  onClose: () => void;
}

export function OutputViewerDialog({
  job,
  open,
  onClose,
}: OutputViewerDialogProps) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<string>("summary");

  // Real fetched PDB / FASTA content (null = not yet loaded / no file).
  const [pdbContent, setPdbContent] = React.useState<string | null>(null);
  const [fastaContent, setFastaContent] = React.useState<string | null>(null);
  const [loadingContent, setLoadingContent] = React.useState(false);

  // Reset to the "summary" tab whenever a new job is opened.
  React.useEffect(() => {
    if (open) setActiveTab("summary");
  }, [open, job?.id]);

  // Fetch real PDB / FASTA content for the first matching output file
  // whenever the dialog opens (or the job changes). Falls back to the
  // synthetic SAMPLE_* content if the fetch fails so the viewer is never
  // empty.
  React.useEffect(() => {
    if (!open || !job) return;
    const pdbFile = job.outputFiles.find((f) => f.endsWith(".pdb"));
    const fastaFile = job.outputFiles.find((f) => f.endsWith(".fasta"));

    let cancelled = false;

    if (pdbFile) {
      setLoadingContent(true);
      fetch(fileApiUrl(job.id, pdbFile))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        .then((text) => {
          if (!cancelled) setPdbContent(text);
        })
        .catch(() => {
          if (!cancelled) setPdbContent(SAMPLE_PDB);
        })
        .finally(() => {
          if (!cancelled) setLoadingContent(false);
        });
    } else {
      setPdbContent(null);
    }

    if (fastaFile) {
      fetch(fileApiUrl(job.id, fastaFile))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        .then((text) => {
          if (!cancelled) setFastaContent(text);
        })
        .catch(() => {
          if (!cancelled) setFastaContent(SAMPLE_FASTA);
        });
    } else {
      setFastaContent(null);
    }

    return () => {
      cancelled = true;
    };
  }, [open, job?.id, job?.outputFiles]);

  const handleCopyFile = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
      setCopied(path);
      setTimeout(() => setCopied((c) => (c === path ? null : c)), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  const hasStructure = !!job && (STRUCTURE_TOOLS.has(job.tool) || job.outputFiles.some((f) => f.endsWith(".pdb")));
  const hasSequence = !!job && (SEQUENCE_TOOLS.has(job.tool) || job.outputFiles.some((f) => f.endsWith(".fasta")));
  const hasFiles = !!job?.outputFiles && job.outputFiles.length > 0;
  const hasCommand = !!job?.command;
  const simulated = !!job && isSimulatedJob(job);

  // First matching output file of each type — used for both the inline
  // preview fetch (above) and the Download buttons.
  const pdbFile = job?.outputFiles.find((f) => f.endsWith(".pdb")) ?? null;
  const fastaFile = job?.outputFiles.find((f) => f.endsWith(".fasta")) ?? null;

  if (!job) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <Wrench className="size-4 text-muted-foreground" />
            <span className="font-mono">{job.tool}</span>
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium",
                statusPillClass(job.status),
              )}
            >
              {job.status}
            </span>
            {/* REAL / SIMULATED badge — surfaces whether the run used a real
                algorithm or the synthetic generator. Uses the same
                detection logic as the Recent Jobs list (above) so the
                badge is consistent across the UI. */}
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
            {job.exitCode != null && (
              <Badge variant="outline" className="font-mono text-[10px]">
                exit {job.exitCode}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            job {job.id} · by {job.triggeredBy || "user"} ·{" "}
            {new Date(job.createdAt).toLocaleString()}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex h-[calc(88vh-104px)] flex-col gap-0"
        >
          <div className="border-b px-3 py-2">
            <TabsList>
              <TabsTrigger value="summary" className="text-xs">
                <ScrollText className="size-3.5" />
                Summary
              </TabsTrigger>
              {hasStructure && (
                <TabsTrigger value="structure" className="text-xs">
                  <Box className="size-3.5" />
                  Structure
                </TabsTrigger>
              )}
              {hasSequence && (
                <TabsTrigger value="sequence" className="text-xs">
                  <Dna className="size-3.5" />
                  Sequence
                </TabsTrigger>
              )}
              {hasFiles && (
                <TabsTrigger value="files" className="text-xs">
                  <FileIcon className="size-3.5" />
                  Files
                </TabsTrigger>
              )}
              {hasCommand && (
                <TabsTrigger value="command" className="text-xs">
                  <TerminalSquare className="size-3.5" />
                  Command
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {/* Summary tab — full stdout (and stderr if present). Pre wraps
              long lines so wide log output (e.g. coordinate dumps) doesn't
              force horizontal scroll. */}
          <TabsContent value="summary" className="m-0 flex-1 overflow-hidden p-4">
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  stdout {job.stdout ? `· ${job.stdout.length.toLocaleString()} chars` : ""}
                </p>
                <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {job.stdout || "(empty)"}
                </pre>
              </div>
              {job.stderr && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                    stderr
                  </p>
                  <pre className="max-h-32 overflow-auto rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive whitespace-pre-wrap break-words">
                    {job.stderr}
                  </pre>
                </div>
              )}
            </div>
          </TabsContent>

          {/* Structure tab — PDB viewer (real fetched PDB, falls back to sample) */}
          {hasStructure && (
            <TabsContent
              value="structure"
              className="m-0 flex-1 overflow-y-auto p-4"
            >
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Box className="size-3.5" />
                {pdbFile ? (
                  <code className="truncate font-mono">{pdbFile}</code>
                ) : (
                  <span>
                    Showing a representative scaffold — no PDB file in this
                    job's outputs.
                  </span>
                )}
                {pdbFile && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="ml-auto h-7 gap-1 px-2 text-[11px]"
                    onClick={() =>
                      window.open(fileApiUrl(job.id, pdbFile), "_blank")
                    }
                  >
                    <Download className="size-3" />
                    Download
                  </Button>
                )}
              </div>
              {loadingContent && !pdbContent ? (
                <div className="flex h-72 items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading structure…
                </div>
              ) : (
                <PdbViewer pdbText={pdbContent ?? SAMPLE_PDB} />
              )}
            </TabsContent>
          )}

          {/* Sequence tab — FASTA viewer (real fetched FASTA, falls back to sample) */}
          {hasSequence && (
            <TabsContent
              value="sequence"
              className="m-0 flex-1 overflow-y-auto p-4"
            >
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Dna className="size-3.5" />
                {fastaFile ? (
                  <code className="truncate font-mono">{fastaFile}</code>
                ) : (
                  <span>
                    Showing a representative designed sequence — no FASTA file
                    in this job's outputs.
                  </span>
                )}
                {fastaFile && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="ml-auto h-7 gap-1 px-2 text-[11px]"
                    onClick={() =>
                      window.open(fileApiUrl(job.id, fastaFile), "_blank")
                    }
                  >
                    <Download className="size-3" />
                    Download
                  </Button>
                )}
              </div>
              {loadingContent && !fastaContent ? (
                <div className="flex h-60 items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading sequence…
                </div>
              ) : (
                <FastaViewer fastaText={fastaContent ?? SAMPLE_FASTA} />
              )}
            </TabsContent>
          )}

          {/* Files tab */}
          {hasFiles && (
            <TabsContent value="files" className="m-0 flex-1 overflow-y-auto p-4">
              <ul className="space-y-1.5">
                {job.outputFiles.map((f, i) => (
                  <li
                    key={`${f}-${i}`}
                    className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
                  >
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <code className="truncate font-mono text-xs text-foreground">
                      {f}
                    </code>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => handleCopyFile(f)}
                        type="button"
                        aria-label="Copy path"
                        title="Copy path"
                      >
                        {copied === f ? (
                          <Check className="size-3.5 text-emerald-500" />
                        ) : (
                          <FileIcon className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        type="button"
                        aria-label="Download"
                        title="Download"
                        onClick={() =>
                          window.open(fileApiUrl(job.id, f), "_blank")
                        }
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        type="button"
                        aria-label="Open in new tab"
                        title="Open in new tab"
                        onClick={() =>
                          window.open(fileApiUrl(job.id, f), "_blank")
                        }
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] text-muted-foreground">
                {simulated
                  ? "Files are generated on-the-fly from the simulated job params (no real tool was installed)."
                  : "Files are served from the run's work directory."}
              </p>
            </TabsContent>
          )}

          {/* Command tab */}
          {hasCommand && (
            <TabsContent value="command" className="m-0 flex-1 overflow-y-auto p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invoked command
              </p>
              <code className="block overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                {job.command}
              </code>
              {Object.keys(job.params ?? {}).length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Resolved params
                  </p>
                  <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px]">
                    {JSON.stringify(job.params, null, 2)}
                  </pre>
                </div>
              )}
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export default OutputViewerDialog;
