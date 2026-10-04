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
  FileWarning,
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
import { generateSamplePdb } from "@/lib/pdb-parser";
// (Pdb3DViewer superseded by the embedded MolVision studio.)
import dynamic from "next/dynamic";

/** MolVision studio — client-only (three.js engine), no SSR. */
const MolStudio = dynamic(
  () => import("@/components/molecular/mol-studio").then((m) => m.MolStudio),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-72 items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading MolVision studio…
      </div>
    ),
  }
);
import { FastaViewer, generateSampleFasta } from "./fasta-viewer";

// --- Helpers ------------------------------------------------------------------

/**
 * Tools that produce PDB files (the Structure tab is shown for these).
 * Includes all design + structure-prediction + scoring tools — every comp
 * tool whose real executors (native or built-in engine) emit .pdb output,
 * plus AlphaFold2 (ranked_*.pdb / relaxed_*.pdb models).
 */
const STRUCTURE_TOOLS = new Set([
  "rfdiffusion",
  "rfantibody",
  "rosetta",
  "pyrosetta",
  "rf3",
  "esmfold",
  "colabfold",
  "alphafold",
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

/** Build the API URL for workflow-node outputs (no ToolJob row exists). */
function nodeFileApiUrl(path: string): string {
  return `/api/tools/file?path=${encodeURIComponent(path)}`;
}

function statusPillClass(status: string): string {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (status === "failed") return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
  if (status === "running") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

/**
 * Detect which executor produced this job's output: the native upstream
 * tool, or the built-in real algorithm engine. Legacy rows (pre-real-executor
 * era) are detected via the old SIMULATED banners for correct display.
 */
function jobExecutor(job: ToolJobDTO): "native" | "builtin-engine" | "legacy-simulated" {
  const meta = job.params?._meta as { executor?: string } | undefined;
  if (meta?.executor === "native") return "native";
  // Cluster runs execute the real native tool on a remote host.
  if (meta?.executor === "cluster") return "native";
  if (meta?.executor === "builtin-engine") return "builtin-engine";
  const out = job.stdout ?? "";
  if (/^\[SIMULATED/i.test(out)) return "legacy-simulated";
  if (/\(simulated\)/i.test(out)) return "legacy-simulated";
  if (/FOUNDRY-LAB SIMULATION/i.test(out)) return "legacy-simulated";
  if (job.command && /^\[SIMULATED\]/i.test(job.command)) return "legacy-simulated";
  return "builtin-engine";
}

// --- Component ----------------------------------------------------------------

export interface OutputViewerDialogProps {
  job: ToolJobDTO | null;
  open: boolean;
  onClose: () => void;
  /** When true, output files are fetched via the generic /api/tools/file
   *  endpoint (workflow-node runs that have no ToolJob row). */
  nodeMode?: boolean;
}

export function OutputViewerDialog({
  job,
  open,
  onClose,
  nodeMode = false,
}: OutputViewerDialogProps) {
  const fileUrl = React.useCallback(
    (path: string) =>
      nodeMode ? nodeFileApiUrl(path) : fileApiUrl(job?.id ?? "", path),
    [nodeMode, job?.id],
  );
  const [copied, setCopied] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<string>("summary");

  // Real fetched PDB / FASTA content (null = not yet loaded / no file).
  const [pdbContent, setPdbContent] = React.useState<string | null>(null);
  const [fastaContent, setFastaContent] = React.useState<string | null>(null);
  const [loadingContent, setLoadingContent] = React.useState(false);
  // Fetch failures (HTTP status / network error). A failure is now an
  // HONEST inline error card showing the real file path — the old .catch
  // silently swapped in SAMPLE_PDB while the header kept showing the real
  // pdbFile path, mislabeling the sample structure as the job's output.
  const [pdbError, setPdbError] = React.useState<string | null>(null);
  const [fastaError, setFastaError] = React.useState<string | null>(null);

  // Reset to the "summary" tab whenever a new job is opened.
  React.useEffect(() => {
    if (open) setActiveTab("summary");
  }, [open, job?.id]);

  // Fetch real PDB / FASTA content for the first matching output file
  // whenever the dialog opens (or the job changes). The SAMPLE_* fallback
  // is only used when the job genuinely has NO output file of that type —
  // fetch failures surface as error states instead.
  React.useEffect(() => {
    if (!open || !job) return;
    const pdbFile = job.outputFiles.find((f) => f.endsWith(".pdb"));
    const fastaFile = job.outputFiles.find((f) => f.endsWith(".fasta"));

    let cancelled = false;

    if (pdbFile) {
      setLoadingContent(true);
      setPdbError(null);
      fetch(fileUrl(pdbFile))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((text) => {
          if (!cancelled) setPdbContent(text);
        })
        .catch((e) => {
          if (!cancelled) {
            setPdbContent(null);
            setPdbError(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingContent(false);
        });
    } else {
      setPdbContent(null);
      setPdbError(null);
    }

    if (fastaFile) {
      setFastaError(null);
      fetch(fileUrl(fastaFile))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((text) => {
          if (!cancelled) setFastaContent(text);
        })
        .catch((e) => {
          if (!cancelled) {
            setFastaContent(null);
            setFastaError(e instanceof Error ? e.message : String(e));
          }
        });
    } else {
      setFastaContent(null);
      setFastaError(null);
    }

    return () => {
      cancelled = true;
    };
  }, [open, job?.id, job?.outputFiles, fileUrl]);

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
  const executor = job ? jobExecutor(job) : "builtin-engine" as const;
  const legacySimulated = executor === "legacy-simulated";

  // First matching output file of each type — used for both the inline
  // preview fetch (above) and the Download buttons.
  const pdbFile = job?.outputFiles.find((f) => f.endsWith(".pdb")) ?? null;
  const fastaFile = job?.outputFiles.find((f) => f.endsWith(".fasta")) ?? null;

  if (!job) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "max-h-[88vh] gap-0 overflow-hidden p-0",
          hasStructure ? "max-w-5xl xl:max-w-6xl" : "max-w-3xl",
        )}
      >
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
            {/* Executor badge — surfaces whether the native upstream tool or
                the built-in real algorithm engine produced this output. */}
            <Badge
              variant="outline"
              className={
                legacySimulated
                  ? "border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
                  : "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
              }
              title={
                legacySimulated
                  ? "Legacy run (from the pre-real-algorithm era of this app)"
                  : executor === "native"
                    ? "Ran the native upstream tool installed on this host"
                    : "Ran the built-in real algorithm engine (knowledge-based science)"
              }
            >
              {legacySimulated ? "LEGACY" : executor === "native" ? "REAL · NATIVE" : "REAL · ENGINE"}
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

          {/* Structure tab — MolVision embedded studio (3D engine + analysis
              panels + sequence bar); falls back to a representative scaffold
              when the job has no PDB output. */}
          {hasStructure && (
            <TabsContent
              value="structure"
              className="m-0 flex-1 overflow-hidden p-3"
            >
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
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
                      window.open(fileUrl(pdbFile), "_blank")
                    }
                  >
                    <Download className="size-3" />
                    Download
                  </Button>
                )}
              </div>
              {pdbFile && pdbError ? (
                // Honest failure state — the real path + the HTTP/network
                // error (pattern from inline-results.tsx), never the sample
                // structure mislabeled as this job's output.
                <div className="flex h-72 flex-col items-center justify-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-center">
                  <FileWarning className="size-5 text-rose-600 dark:text-rose-400" />
                  <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
                    Failed to load the structure ({pdbError})
                  </p>
                  <code className="max-w-full truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
                    {pdbFile}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    The file exists in the job record but couldn&apos;t be
                    fetched — try the Download button or reopen the dialog.
                  </p>
                </div>
              ) : loadingContent && !pdbContent ? (
                <div className="flex h-72 items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading structure…
                </div>
              ) : (
                <MolStudio
                  pdbText={pdbContent ?? SAMPLE_PDB}
                  name={
                    pdbFile
                      ? (pdbFile.split("/").pop() ?? "structure").replace(/\.pdb$/i, "")
                      : "sample"
                  }
                  variant="full"
                  className="h-[calc(88vh-190px)] min-h-[480px]"
                />
              )}
            </TabsContent>
          )}

          {/* Sequence tab — FASTA viewer (real fetched FASTA; the sample is
              only shown when the job has no FASTA output — fetch failures
              render an honest error card with the real path). */}
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
                      window.open(fileUrl(fastaFile), "_blank")
                    }
                  >
                    <Download className="size-3" />
                    Download
                  </Button>
                )}
              </div>
              {fastaFile && fastaError ? (
                // Honest failure state — the real path + the error, mirroring
                // the Structure tab.
                <div className="flex h-60 flex-col items-center justify-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-center">
                  <FileWarning className="size-5 text-rose-600 dark:text-rose-400" />
                  <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
                    Failed to load the sequence ({fastaError})
                  </p>
                  <code className="max-w-full truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
                    {fastaFile}
                  </code>
                </div>
              ) : loadingContent && !fastaContent ? (
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
                          window.open(fileUrl(f), "_blank")
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
                          window.open(fileUrl(f), "_blank")
                        }
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] text-muted-foreground">
                Files are served from the run&apos;s work directory
                ({executor === "native" ? "native tool artifacts" : "built-in engine artifacts"}).
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
