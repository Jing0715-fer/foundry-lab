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
  TemplateLoadConfirm,
  needsTemplateConfirm,
} from "@/components/canvas/template-load-confirm";
import {
  ArrowRight,
  Ban,
  Bot,
  BookOpen,
  CalendarClock,
  Check,
  Cpu,
  Database,
  Download,
  Flag,
  History,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

// Local shape — mirrors WorkflowVersionDTO from the API route.
interface VersionItem {
  id: string;
  label: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  current?: boolean;
}

// Local shape — mirrors ScheduleDTO from the schedule API route.
interface ScheduleItem {
  id: string;
  workflowId: string;
  runAt: string;
  label: string;
  status: "scheduled" | "firing" | "fired" | "failed" | "cancelled";
  firedAt: string | null;
  error: string | null;
  started: number;
  completed: number;
  createdAt: string;
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

  // Destructive-replace confirmations (F-lane #10): loading a template or
  // importing JSON REPLACES the current workflow — with nodes present, both
  // routes gate behind TemplateLoadConfirm first.
  const [confirmTemplate, setConfirmTemplate] = React.useState<WorkflowTemplate | null>(null);
  const [confirmImport, setConfirmImport] = React.useState<ReturnType<typeof parseWorkflowJSON> | null>(null);

  // Version history state — fetched on mount (the dialog mounts this
  // component, so this fires whenever the user opens the templates gallery).
  const [versions, setVersions] = React.useState<VersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [savingVersion, setSavingVersion] = React.useState(false);
  const [restoringVersionId, setRestoringVersionId] = React.useState<string | null>(null);

  // Scheduling state — same pattern as versions: fetch on `workflow?.id`
  // change, optimistic prepend on POST, optimistic remove on DELETE.
  const [schedules, setSchedules] = React.useState<ScheduleItem[]>([]);
  const [scheduleHistory, setScheduleHistory] = React.useState<ScheduleItem[]>([]);
  const [schedulesLoading, setSchedulesLoading] = React.useState(false);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
  const [cancellingScheduleId, setCancellingScheduleId] = React.useState<string | null>(null);
  // datetime-local value + optional label for the "schedule a new run" form.
  const [scheduleRunAt, setScheduleRunAt] = React.useState("");
  const [scheduleLabel, setScheduleLabel] = React.useState("");

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

  // Parse + confirm + run — split so the confirm dialog can re-run the
  // import after the user accepts the replacement.
  async function runImport(data: ReturnType<typeof parseWorkflowJSON>) {
    if (importing) return;
    setImporting(true);
    try {
      // Pass the CURRENT workflow id so the import clears + rebuilds the
      // workflow the user is looking at (multi-workflow contract).
      const result = await importWorkflow(data, workflow?.id);
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

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-selected later.
    e.target.value = "";
    if (!file) return;
    if (importing) return;
    try {
      const text = await file.text();
      const data = parseWorkflowJSON(text);
      // Import is a REPLACE operation — confirm when nodes would be lost.
      if (needsTemplateConfirm(workflow?.nodes?.length)) {
        setConfirmImport(data);
        return;
      }
      await runImport(data);
    } catch (err) {
      toast({
        title: "Import failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  /** Guarded entry: confirm before the destructive replace (F-lane #10). */
  function requestLoadTemplate(t: WorkflowTemplate) {
    if (loadingId) return;
    if (needsTemplateConfirm(workflow?.nodes?.length)) {
      setConfirmTemplate(t);
      return;
    }
    void loadTemplate(t);
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
          // Target the CURRENT workflow (multi-workflow contract) — the
          // template replaces the graph the user is looking at.
          workflowId: workflow?.id,
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

      // 5. Refresh the workflow from the server (canonical truth) — by id,
      //      so a non-first current workflow isn't clobbered by /api/workflow
      //      (which always returns the FIRST workflow).
      const wfRes = await fetch(
        workflow?.id ? `/api/workflows/${workflow.id}` : "/api/workflow",
      );
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `${res.status}`);
      }
      const created: VersionItem = await res.json();
      // Optimistic prepend (newest-first). Mark all others as non-current.
      setVersions((prev) =>
        [{ ...created, current: true }, ...prev.map((v) => ({ ...v, current: false }))],
      );
      toast({
        title: "Version saved",
        description: `${created.label} — ${created.nodeCount} nodes · ${created.edgeCount} edges`,
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

  async function handleRestoreVersion(v: VersionItem) {
    if (!workflow?.id || restoringVersionId) return;
    const ok = window.confirm(
      `Restore "${v.label}"?\n\nThe current canvas (${workflow.nodes.length} nodes) will be replaced with this snapshot (${v.nodeCount} nodes · ${v.edgeCount} edges). Other snapshots are kept.`,
    );
    if (!ok) return;
    setRestoringVersionId(v.id);
    try {
      const res = await fetch(
        `/api/workflows/${workflow.id}/versions/${v.id}/restore`,
        { method: "POST" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `${res.status}`);
      }
      const data: {
        restored: boolean;
        workflow: { id: string; name: string; nodes: NodeDTO[]; edges: EdgeDTO[]; createdAt: string; updatedAt: string };
      } = await res.json();
      // Swap the canvas to the restored workflow (canonical server state).
      setWorkflow(data.workflow);
      toast({
        title: "Version restored",
        description: `${v.label} — ${data.workflow.nodes.length} nodes · ${data.workflow.edges.length} edges`,
        variant: "success",
      });
      setActivePanel("canvas");
      onLoaded?.();
    } catch (e) {
      toast({
        title: "Failed to restore version",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setRestoringVersionId(null);
    }
  }

  // --- Scheduling -------------------------------------------------------------

  // Fetch schedules whenever the workflow id changes (covers initial dialog
  // open + switching workflows while the dialog is open). Same lifecycle
  // pattern as the versions useEffect above. The endpoint returns BOTH the
  // upcoming list and the fired/failed/cancelled history.
  React.useEffect(() => {
    let cancelled = false;
    if (!workflow?.id) {
      setSchedules([]);
      setScheduleHistory([]);
      return;
    }
    setSchedulesLoading(true);
    fetch(`/api/workflows/${workflow.id}/schedule`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: { schedules?: ScheduleItem[]; history?: ScheduleItem[] }) => {
        if (!cancelled) {
          setSchedules(data.schedules ?? []);
          setScheduleHistory(data.history ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSchedules([]);
          setScheduleHistory([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSchedulesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflow?.id]);

  async function handleScheduleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!workflow?.id || savingSchedule) return;
    if (!scheduleRunAt) {
      toast({
        title: "Pick a time",
        description: "Choose when the workflow should run.",
        variant: "destructive",
      });
      return;
    }
    setSavingSchedule(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runAt: scheduleRunAt,
          label: scheduleLabel.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `${res.status}`);
      }
      const data: { schedule: ScheduleItem } = await res.json();
      // Optimistic prepend (newest-first by runAt).
      setSchedules((prev) =>
        [...prev, data.schedule].sort((a, b) => a.runAt.localeCompare(b.runAt)),
      );
      // Reset the form.
      setScheduleRunAt("");
      setScheduleLabel("");
      toast({
        title: "Run scheduled",
        description: `${data.schedule.label} — ${new Date(data.schedule.runAt).toLocaleString()}`,
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Failed to schedule run",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleCancelSchedule(s: ScheduleItem) {
    if (!workflow?.id || cancellingScheduleId) return;
    setCancellingScheduleId(s.id);
    // Optimistic remove — the list updates immediately and the server call
    // runs in the background. If it fails we refetch to restore.
    setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    try {
      const res = await fetch(
        `/api/workflows/${workflow.id}/schedule?scheduleId=${encodeURIComponent(s.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast({
        title: "Run cancelled",
        description: s.label,
        variant: "default",
      });
    } catch (err) {
      toast({
        title: "Failed to cancel run",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      // Refetch to restore the optimistic removal.
      try {
        const r = await fetch(`/api/workflows/${workflow.id}/schedule`);
        if (r.ok) {
          const data: { schedules?: ScheduleItem[]; history?: ScheduleItem[] } = await r.json();
          setSchedules(data.schedules ?? []);
          setScheduleHistory(data.history ?? []);
        }
      } catch {
        // ignore — the toast already reported the failure.
      }
    } finally {
      setCancellingScheduleId(null);
    }
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
                    onClick={() => requestLoadTemplate(t)}
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

      {/* Version History — sits below the templates grid. Snapshots are
          persisted in the DB (nodes + edges with full run state) and can be
          restored — the restore replaces the canvas transactionally. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Version History</h3>
          <span className="text-[11px] text-muted-foreground">
            Snapshots persist in the database and can be restored anytime.
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
                        latest
                      </Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()} · {v.nodeCount} nodes · {v.edgeCount} edges
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => void handleRestoreVersion(v)}
                  disabled={!!restoringVersionId}
                  type="button"
                >
                  {restoringVersionId === v.id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3" />
                  )}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Schedule — queue a workflow run for a future time. Schedules are
          persisted in the DB; the scheduler sweeper fires them automatically
          through the same execution lane as manual runs, even if the server
          restarted in between. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Schedule</h3>
          <span className="text-[11px] text-muted-foreground">
            Queue a run for a future time — persisted and fired automatically.
          </span>
        </div>

        {!workflow?.id ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
            Open a workflow to schedule a run.
          </div>
        ) : (
          <>
            {/* New schedule form */}
            <form
              onSubmit={handleScheduleRun}
              className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[1fr_1fr_auto]"
            >
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="schedule-run-at"
                  className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Run at
                </label>
                <Input
                  id="schedule-run-at"
                  type="datetime-local"
                  value={scheduleRunAt}
                  onChange={(e) => setScheduleRunAt(e.target.value)}
                  disabled={savingSchedule}
                  className="h-9 text-xs"
                  aria-label="Run at"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="schedule-label"
                  className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Label <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="schedule-label"
                  type="text"
                  value={scheduleLabel}
                  onChange={(e) => setScheduleLabel(e.target.value)}
                  disabled={savingSchedule}
                  placeholder="e.g. Nightly batch"
                  className="h-9 text-xs"
                  aria-label="Label (optional)"
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={savingSchedule || !scheduleRunAt}
                  className="h-9 gap-1.5"
                >
                  {savingSchedule ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CalendarClock className="size-3.5" />
                  )}
                  Schedule run
                </Button>
              </div>
            </form>

            {/* Existing schedules list */}
            {schedulesLoading ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading scheduled runs…
              </div>
            ) : schedules.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
                No scheduled runs. Pick a time above to queue one.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {schedules.map((s, i) => {
                  const runAtDate = new Date(s.runAt);
                  const isPast = runAtDate.getTime() < Date.now();
                  const isFiring = s.status === "firing";
                  return (
                    <li
                      key={s.id}
                      className="stagger-in flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                      style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                    >
                      <div
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-md",
                          isFiring
                            ? "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                            : isPast
                              ? "bg-muted text-muted-foreground"
                              : "bg-primary/10 text-primary",
                        )}
                      >
                        {isFiring ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CalendarClock className="size-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">
                            {s.label}
                          </span>
                          {isFiring && (
                            <Badge
                              variant="outline"
                              className="border-teal-500/30 bg-teal-500/10 px-1.5 py-0 text-[9px] text-teal-600 dark:text-teal-400"
                            >
                              firing now
                            </Badge>
                          )}
                          {isPast && !isFiring && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[9px] text-amber-600 dark:text-amber-400"
                            >
                              due
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {runAtDate.toLocaleString()}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => void handleCancelSchedule(s)}
                        disabled={!!cancellingScheduleId || isFiring}
                        type="button"
                        title="Cancel this scheduled run"
                      >
                        {cancellingScheduleId === s.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <X className="size-3" />
                        )}
                        Cancel
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Run history — fired / failed / cancelled rows (persisted). */}
            {scheduleHistory.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Run history
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {scheduleHistory.slice(0, 8).map((s) => {
                    const fired = s.status === "fired";
                    const failed = s.status === "failed";
                    return (
                      <li
                        key={s.id}
                        className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5"
                      >
                        <div
                          className={cn(
                            "flex size-6 shrink-0 items-center justify-center rounded-md",
                            fired
                              ? "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                              : failed
                                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {fired ? (
                            <Check className="size-3" />
                          ) : failed ? (
                            <X className="size-3" />
                          ) : (
                            <Ban className="size-3" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium text-muted-foreground">
                              {s.label}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                "px-1.5 py-0 text-[9px]",
                                fired
                                  ? "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400"
                                  : failed
                                    ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                                    : "",
                              )}
                            >
                              {s.status}
                            </Badge>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {s.firedAt
                              ? `fired ${new Date(s.firedAt).toLocaleString()} — ${s.started} started · ${s.completed} completed`
                              : new Date(s.runAt).toLocaleString()}
                            {failed && s.error ? ` — ${s.error}` : ""}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Bulk cancel — only shown when there are schedules. */}
            {schedules.length > 0 && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    if (!workflow?.id || cancellingScheduleId) return;
                    setCancellingScheduleId("all");
                    setSchedules([]);
                    try {
                      const res = await fetch(
                        `/api/workflows/${workflow.id}/schedule`,
                        { method: "DELETE" },
                      );
                      if (!res.ok) throw new Error(`${res.status}`);
                      toast({
                        title: "All runs cancelled",
                        variant: "default",
                      });
                    } catch (err) {
                      toast({
                        title: "Failed to cancel runs",
                        description:
                          err instanceof Error ? err.message : String(err),
                        variant: "destructive",
                      });
                      // Refetch to restore.
                      try {
                        const r = await fetch(
                          `/api/workflows/${workflow.id}/schedule`,
                        );
                        if (r.ok) {
                          const data: { schedules?: ScheduleItem[]; history?: ScheduleItem[] } =
                            await r.json();
                          setSchedules(data.schedules ?? []);
                          setScheduleHistory(data.history ?? []);
                        }
                      } catch {
                        // ignore
                      }
                    } finally {
                      setCancellingScheduleId(null);
                    }
                  }}
                  disabled={!!cancellingScheduleId}
                  type="button"
                >
                  <Trash2 className="size-3" />
                  Cancel all
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Destructive-replace confirmations (F-lane #10). */}
      <TemplateLoadConfirm
        open={confirmTemplate !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmTemplate(null);
        }}
        templateName={confirmTemplate?.name ?? ""}
        templateNodeCount={confirmTemplate?.nodes.length ?? 0}
        workflowName={workflow?.name ?? null}
        currentNodes={workflow?.nodes?.length ?? 0}
        currentEdges={workflow?.edges?.length ?? 0}
        onConfirm={() => {
          const t = confirmTemplate;
          setConfirmTemplate(null);
          if (t) void loadTemplate(t);
        }}
      />
      <TemplateLoadConfirm
        open={confirmImport !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmImport(null);
        }}
        templateName={confirmImport?.name ?? "Imported workflow"}
        templateNodeCount={confirmImport?.nodes.length ?? 0}
        workflowName={workflow?.name ?? null}
        currentNodes={workflow?.nodes?.length ?? 0}
        currentEdges={workflow?.edges?.length ?? 0}
        onConfirm={() => {
          const data = confirmImport;
          setConfirmImport(null);
          if (data) void runImport(data);
        }}
      />
    </div>
  );
}
