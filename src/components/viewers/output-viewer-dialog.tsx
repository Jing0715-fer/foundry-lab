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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STRUCTURE_TOOLS = new Set(["rfdiffusion", "rfantibody", "rosetta"]);
const SEQUENCE_TOOLS = new Set(["proteinmpnn"]);

const SAMPLE_PDB = generateSamplePdb();
const SAMPLE_FASTA = generateSampleFasta();

function statusPillClass(status: string): string {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (status === "failed") return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
  if (status === "running") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

// ─── Component ────────────────────────────────────────────────────────────────

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

  // Reset to the "summary" tab whenever a new job is opened.
  React.useEffect(() => {
    if (open) setActiveTab("summary");
  }, [open, job?.id]);

  const handleCopyFile = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
      setCopied(path);
      setTimeout(() => setCopied((c) => (c === path ? null : c)), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  const hasStructure = !!job && STRUCTURE_TOOLS.has(job.tool);
  const hasSequence = !!job && SEQUENCE_TOOLS.has(job.tool);
  const hasFiles = !!job?.outputFiles && job.outputFiles.length > 0;
  const hasCommand = !!job?.command;

  if (!job) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
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

          {/* Summary tab — stdout (and stderr if present) */}
          <TabsContent value="summary" className="m-0 flex-1 overflow-hidden p-4">
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  stdout
                </p>
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                  {job.stdout || "(empty)"}
                </pre>
              </div>
              {job.stderr && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                    stderr
                  </p>
                  <pre className="max-h-32 overflow-auto rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive">
                    {job.stderr}
                  </pre>
                </div>
              )}
            </div>
          </TabsContent>

          {/* Structure tab — PDB viewer (always show sample; real PDB text not yet wired) */}
          {hasStructure && (
            <TabsContent
              value="structure"
              className="m-0 flex-1 overflow-y-auto p-4"
            >
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Box className="size-3.5" />
                Showing a representative scaffold for this tool — download the
                actual PDB files from the Files tab.
              </div>
              <PdbViewer pdbText={SAMPLE_PDB} />
            </TabsContent>
          )}

          {/* Sequence tab — FASTA viewer (sample) */}
          {hasSequence && (
            <TabsContent
              value="sequence"
              className="m-0 flex-1 overflow-y-auto p-4"
            >
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Dna className="size-3.5" />
                Showing a representative designed sequence for this tool —
                download the actual FASTA files from the Files tab.
              </div>
              <FastaViewer fastaText={SAMPLE_FASTA} />
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
                        title="Download (sandbox)"
                        disabled
                      >
                        <Download className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] text-muted-foreground">
                Download buttons are non-functional in the sandbox environment.
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
