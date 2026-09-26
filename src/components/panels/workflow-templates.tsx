"use client";

import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from "@/lib/workflow-template-defs";
import type { AgentDTO, EdgeDTO, NodeDTO } from "@/lib/types";
import {
  downloadWorkflowJSON,
  importWorkflow,
  parseWorkflowJSON,
} from "@/lib/workflow-io";
import {
  ArrowRight,
  Bot,
  BookOpen,
  Cpu,
  Database,
  Download,
  Flag,
  History,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  Upload,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Local shape — mirrors WorkflowVersionDTO from the API route.
interface VersionItem {
  id: string;
  label: string;
  createdAt: string;
  current?: boolean;
}

// Map node.type → lucide icon for the card preview.
const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  input: ArrowRight,
  output: Flag,
  agent: Bot,
  meeting: Users,
  research: BookOpen,
  comptool: Cpu,
  biotool: Database,
  task: Sparkles,
};

const CATEGORY_BADGE: Record<
  WorkflowTemplate["category"],
  { label: string; className: string }
> = {
  research: {
    label: "Research",
    className:
      "border-transparent bg-teal-500/15 text-teal-700 dark:text-teal-300",
  },
  design: {
    label: "Design",
    className:
      "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  analysis: {
    label: "Analysis",
    className:
      "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
};

export function WorkflowTemplates({
  onLoaded,
}: {
  /** Optional callback fired after a template loads successfully. */
  onLoaded?: () => void;
}) {
  const workflow = useAppStore((s) => s.workflow);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const toast = useAppStore((s) => s.toast);

  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Version history state — fetched on mount (the dialog mounts this
  // component, so this fires whenever the user opens the templates gallery).
  const [versions, setVersions] = React.useState<VersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [savingVersion, setSavingVersion] = React.useState(false);

  const hasNodes = !!(workflow && workflow.nodes && workflow.nodes.length > 0);

  function handleExport() {
    if (!workflow) return;
    try {
      downloadWorkflowJSON(workflow);
      toast({
        title: "Workflow exported",
        description: `${workflow.nodes.length} nodes · ${workflow.edges.length} edges`,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-selected later.
    e.target.value = "";
    if (!file) return;
    if (importing) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = parseWorkflowJSON(text);
      const result = await importWorkflow(data);
      setWorkflow(result);
      toast({
        title: "Workflow imported",
        description: `${result.nodes.length} nodes · ${result.edges.length} edges`,
        variant: "success",
      });
      setActivePanel("canvas");
      onLoaded?.();
    } catch (err) {
      toast({
        title: "Import failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  }

  async function loadTemplate(t: WorkflowTemplate) {
    if (loadingId) return;
    setLoadingId(t.id);
    try {
      // 1. Resolve refTitle → agent ID (fetch /api/agents once).
      let agents: AgentDTO[] = [];
      if (t.nodes.some((n) => n.refTitle)) {
        const res = await fetch("/api/agents");
        if (res.ok) agents = (await res.json()) ?? [];
      }
      const byTitle = new Map<string, AgentDTO>();
      for (const a of agents) byTitle.set(a.title, a);

      // 2. DELETE all existing nodes (cascades edges via the API).
      if (workflow?.nodes?.length) {
        await Promise.all(
          workflow.nodes.map((n) =>
            fetch(`/api/workflow/nodes/${n.id}`, { method: "DELETE" }),
          ),
        );
      }

      // 3. POST each template node, capturing the real IDs.
      const createdIds: string[] = [];
      for (const n of t.nodes) {
        // Resolve refId: refTitle wins, fallback to refId.
        let refId = n.refId;
        if (n.refTitle) {
          const match = byTitle.get(n.refTitle);
          if (match) refId = match.id;
        }

        const body: Record<string, unknown> = {
          type: n.type,
          name: n.name,
          x: n.x,
          y: n.y,
        };
        if (refId) body.refId = refId;
        if (n.params && Object.keys(n.params).length) {
          body.params = n.params;
        }

        const res = await fetch("/api/workflow/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            `Failed to create node "${n.name}": ${err?.error ?? res.status}`,
          );
        }
        const node: NodeDTO = await res.json();
        createdIds.push(node.id);
      }

      // 4. POST each edge using the real node IDs.
      for (const e of t.edges) {
        const fromNodeId = createdIds[e.from];
        const toNodeId = createdIds[e.to];
        if (!fromNodeId || !toNodeId) continue;
        const body: Record<string, unknown> = { fromNodeId, toNodeId };
        if (e.fromPort) body.fromPort = e.fromPort;
        if (e.toPort) body.toPort = e.toPort;
        const res = await fetch("/api/workflow/edges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // Non-fatal: duplicate/cycle errors are reported but don't abort the
        // whole template load — the user can fix in the canvas.
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.warn(
            `[template] edge ${e.from}→${e.to} failed:`,
            err?.error ?? res.status,
          );
        }
      }

      // 5. Refresh the workflow from the server (canonical truth).
      const wfRes = await fetch("/api/workflow");
      if (wfRes.ok) {
        const wf = await wfRes.json();
        setWorkflow({
          ...wf,
          nodes: (wf.nodes ?? []) as NodeDTO[],
          edges: (wf.edges ?? []) as EdgeDTO[],
        });
      }

      toast({
        title: "Template loaded",
        description: `${t.name} — ${t.nodes.length} nodes created.`,
        variant: "success",
      });
      setActivePanel("canvas");
      onLoaded?.();
    } catch (e) {
      toast({
        title: "Failed to load template",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoadingId(null);
    }
  }

  // --- Version history -------------------------------------------------------

  // Fetch versions whenever the workflow id changes (covers initial dialog
  // open + switching workflows while the dialog is open).
  React.useEffect(() => {
    let cancelled = false;
    if (!workflow?.id) {
      setVersions([]);
      return;
    }
    setVersionsLoading(true);
    fetch(`/api/workflows/${workflow.id}/versions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: { versions?: VersionItem[] }) => {
        if (!cancelled) setVersions(data.versions ?? []);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflow?.id]);

  async function handleSaveVersion() {
    if (!workflow?.id || savingVersion) return;
    const label = window.prompt(
      "Label this version (optional):",
      `Version ${new Date().toLocaleString()}`,
    );
    // prompt returns null when the user hits Cancel.
    if (label === null) return;
    setSavingVersion(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const created: VersionItem = await res.json();
      // Optimistic prepend (newest-first). Mark all others as non-current.
      setVersions((prev) =>
        [{ ...created, current: true }, ...prev.map((v) => ({ ...v, current: false }))],
      );
      toast({
        title: "Version saved",
        description: created.label,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Failed to save version",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingVersion(false);
    }
  }

  function handleRestoreVersion(v: VersionItem) {
    // Non-functional in this demo — restore isn't wired through the API yet.
    toast({
      title: "Restore coming soon",
      description: `Restoring "${v.label}" is not yet implemented.`,
      variant: "default",
    });
  }

  return (
    <div className="space-y-5">
      {/* Export / Import section — sits above the template gallery so the
          user can either reuse a saved workflow or grab a starter template. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Export / Import</h3>
          <span className="text-[11px] text-muted-foreground">
            Save or restore the current canvas as JSON.
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Export card */}
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Download className="size-4" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <div className="space-y-0.5">
                <div className="text-sm font-medium leading-tight">
                  Export current workflow
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  Download a JSON file with all nodes, edges, and parameters.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleExport}
                disabled={!hasNodes}
                className="w-fit"
              >
                <Download className="size-3.5" />
                Export
              </Button>
            </div>
          </div>
          {/* Import card */}
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Upload className="size-4" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <div className="space-y-0.5">
                <div className="text-sm font-medium leading-tight">
                  Import workflow
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  Replace the current canvas with a JSON file. Existing nodes
                  will be removed.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="w-fit"
              >
                {importing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                Import
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden>
          <div className="h-px w-full bg-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
            Templates
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {WORKFLOW_TEMPLATES.map((t) => {
          const cat = CATEGORY_BADGE[t.category];
          const isLoading = loadingId === t.id;
          return (
            <Card
              key={t.id}
              className="flex flex-col gap-3 overflow-hidden transition-shadow hover:shadow-md"
            >
              <div className="h-[3px] w-full bg-gradient-to-r from-violet-500 via-teal-500 to-amber-500" />
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">
                    {t.name}
                  </CardTitle>
                  <Badge variant="outline" className={cn("text-[10px]", cat.className)}>
                    {cat.label}
                  </Badge>
                </div>
                <CardDescription className="text-xs leading-relaxed">
                  {t.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                {/* Node preview row */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {t.nodes.map((n, i) => {
                    const NodeCmp = TYPE_ICON[n.type] ?? Sparkles;
                    const arrow = i < t.nodes.length - 1;
                    return (
                      <React.Fragment key={i}>
                        <span
                          className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-1 text-[10px] font-medium"
                          title={n.type}
                        >
                          <NodeCmp className="size-3" />
                          <span className="max-w-[80px] truncate">{n.name}</span>
                        </span>
                        {arrow && (
                          <ArrowRight className="size-3 text-muted-foreground/50" />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t.nodes.length} nodes · {t.edges.length} edges
                  </span>
                  <Button
                    size="sm"
                    onClick={() => loadTemplate(t)}
                    disabled={!!loadingId}
                  >
                    {isLoading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    Load template
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Version History — sits below the templates grid. Lets the user
          snapshot the current canvas and (eventually) restore prior
          versions. Restore is intentionally non-functional in this demo. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Version History</h3>
          <span className="text-[11px] text-muted-foreground">
            Snapshot the current canvas (mock storage — Restore coming soon).
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1 px-2 text-[11px]"
            onClick={handleSaveVersion}
            disabled={!workflow?.id || savingVersion}
          >
            {savingVersion ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Save className="size-3" />
            )}
            Save version
          </Button>
        </div>

        {!workflow?.id ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
            Open a workflow to view its version history.
          </div>
        ) : versionsLoading ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading versions…
          </div>
        ) : versions.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
            No versions yet. Click "Save version" to snapshot the current
            canvas.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
              >
                <div
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md",
                    v.current
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <History className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">
                      {v.label}
                    </span>
                    {v.current && (
                      <Badge
                        variant="outline"
                        className="border-primary/30 bg-primary/10 px-1.5 py-0 text-[9px] text-primary"
                      >
                        current
                      </Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => handleRestoreVersion(v)}
                  type="button"
                >
                  <RotateCcw className="size-3" />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
