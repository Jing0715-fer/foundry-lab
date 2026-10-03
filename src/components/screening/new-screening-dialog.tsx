"use client";

/**
 * NewScreeningDialog — source picker for creating a screening campaign.
 *
 * Four options, each POSTs /api/screening with the right source body:
 *  (a) Demo: Scaffold campaign (~60 rfdiffusion designs)
 *  (b) Demo: AF2 model ranking (20 candidates)
 *  (c) From completed canvas nodes (tool-type nodes with status "completed")
 *  (d) From tool jobs (status "completed")
 *
 * Demo sources run REAL engines server-side and can take 1–2 minutes, so the
 * creating state shows an animated spinner + "Running real engines…"
 * messaging and every trigger button stays disabled until it resolves.
 */

import * as React from "react";
import {
  FlaskConical,
  Loader2,
  Plus,
  Sparkles,
  Workflow,
  Boxes,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/lib/store";
import type { NodeDTO, ScreeningDTO, ToolJobDTO } from "@/lib/types";

/** Canvas node types whose completed runs can seed a screening. */
const TOOL_NODE_TYPES = new Set<string>([
  "rfdiffusion",
  "alphafold",
  "proteinmpnn",
  "rosetta",
  "rfantibody",
  "ligandmpnn",
  "solublempnn",
  "pyrosetta",
  "rf3",
  "esmfold",
  "colabfold",
]);

/** Relative time formatter — "3m ago", "2h ago", "1d ago". */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface NewScreeningDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: (screening: ScreeningDTO) => void;
}

export function NewScreeningDialog({
  open,
  onOpenChange,
  onSuccess,
}: NewScreeningDialogProps) {
  const toast = useAppStore((s) => s.toast);

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [nodes, setNodes] = React.useState<NodeDTO[]>([]);
  const [jobs, setJobs] = React.useState<ToolJobDTO[]>([]);
  const [sourcesLoading, setSourcesLoading] = React.useState(false);

  // Load pickable sources whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSourcesLoading(true);
    (async () => {
      try {
        const [wRes, jRes] = await Promise.all([
          fetch("/api/workflow").then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch("/api/tools/jobs").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (cancelled) return;
        const toolNodes: NodeDTO[] = (wRes?.nodes ?? []).filter(
          (n: NodeDTO) => n.status === "completed" && TOOL_NODE_TYPES.has(n.type),
        );
        const completedJobs: ToolJobDTO[] = Array.isArray(jRes)
          ? jRes.filter((j: ToolJobDTO) => j.status === "completed")
          : [];
        setNodes(toolNodes);
        setJobs(completedJobs);
      } catch {
        /* leave empty lists */
      } finally {
        if (!cancelled) setSourcesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function create(source: {
    kind: "node" | "job" | "demo";
    nodeId?: string;
    jobId?: string;
    demo?: "scaffold" | "models";
  }) {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/screening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          name: name.trim() || undefined,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const screening: ScreeningDTO | undefined = data?.screening;
      if (!screening?.id) throw new Error("Malformed response from server");
      onOpenChange(false);
      onSuccess(screening);
    } catch (e) {
      toast({
        title: "Failed to create screening",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !creating && onOpenChange(o)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-5" />
            New Screening
          </DialogTitle>
          <DialogDescription>
            Harvest design candidates (PDB structures + metrics) into a ranked
            evaluation campaign.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="screening-name">Name</Label>
              <Input
                id="screening-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional — auto-named from source"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="screening-description">Description</Label>
              <Input
                id="screening-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional goal / notes"
              />
            </div>
          </div>

          {/* Demo sources */}
          <section className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Demo campaigns (real engines)
            </h4>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                className="h-auto min-h-11 flex-col items-start gap-0.5 p-3 text-left"
                disabled={creating}
                onClick={() => create({ kind: "demo", demo: "scaffold" })}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Boxes className="size-4 text-primary" />
                  Scaffold campaign
                </span>
                <span className="text-xs text-muted-foreground">
                  ~60 rfdiffusion designs · helix%, clashes, rama…
                </span>
              </Button>
              <Button
                variant="outline"
                className="h-auto min-h-11 flex-col items-start gap-0.5 p-3 text-left"
                disabled={creating}
                onClick={() => create({ kind: "demo", demo: "models" })}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="size-4 text-primary" />
                  AF2 model ranking
                </span>
                <span className="text-xs text-muted-foreground">
                  20 candidates · pLDDT / pTM ranked models
                </span>
              </Button>
            </div>
          </section>

          {/* From completed canvas nodes */}
          <section className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From completed canvas nodes
            </h4>
            <ScrollArea className="h-36 rounded-lg border">
              <div className="p-2">
                {sourcesLoading ? (
                  <div className="space-y-2 p-1">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : nodes.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    No completed tool nodes on the canvas yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {nodes.map((n) => (
                      <li key={n.id}>
                        <button
                          type="button"
                          disabled={creating}
                          onClick={() => create({ kind: "node", nodeId: n.id })}
                          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                          <Workflow className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{n.name}</span>
                          <Badge variant="outline" className="text-[10px] lowercase">
                            {n.type}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </ScrollArea>
          </section>

          {/* From tool jobs */}
          <section className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From tool jobs
            </h4>
            <ScrollArea className="h-36 rounded-lg border">
              <div className="p-2">
                {sourcesLoading ? (
                  <div className="space-y-2 p-1">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : jobs.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    No completed tool jobs yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {jobs.map((j) => (
                      <li key={j.id}>
                        <button
                          type="button"
                          disabled={creating}
                          onClick={() => create({ kind: "job", jobId: j.id })}
                          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                          <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                          <Badge variant="outline" className="text-[10px] lowercase">
                            {j.tool}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {j.presetName ?? j.id.slice(0, 12)}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {j.createdAt ? timeAgo(j.createdAt) : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </ScrollArea>
          </section>

          {creating && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>
                <span className="font-medium">Running real engines…</span>{" "}
                <span className="text-muted-foreground">
                  harvesting candidates (this can take 1–2 minutes).
                </span>
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button disabled={creating} onClick={() => create({ kind: "demo", demo: "scaffold" })}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Run scaffold campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
