"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import {
  FlaskConical,
  Plus,
  Play,
  Trash2,
  Eye,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/lib/store";
import type { ResearchReportDTO, RunStatus, DiscussionMessage } from "@/lib/types";

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

const STATUS_META: Record<
  string,
  { label: string; pill: string; accent: string }
> = {
  draft: {
    label: "Draft",
    pill: "bg-muted text-muted-foreground",
    accent: "#94a3b8",
  },
  planning: {
    label: "Planning",
    pill: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    accent: "#3b82f6",
  },
  researching: {
    label: "Researching",
    pill: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
    accent: "#8b5cf6",
  },
  writing: {
    label: "Writing",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "#f59e0b",
  },
  running: {
    label: "Running",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "#f59e0b",
  },
  pending: {
    label: "Pending",
    pill: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    accent: "#3b82f6",
  },
  completed: {
    label: "Completed",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    accent: "#10b981",
  },
  failed: {
    label: "Failed",
    pill: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
    accent: "#ef4444",
  },
  cancelled: {
    label: "Cancelled",
    pill: "bg-muted text-muted-foreground",
    accent: "#6b7280",
  },
  queued: {
    label: "Queued",
    pill: "bg-muted text-muted-foreground",
    accent: "#94a3b8",
  },
};

function StatusPill({ status }: { status: RunStatus | string }) {
  const meta = STATUS_META[status] ?? STATUS_META["draft"];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${meta.pill}`}
    >
      {meta.label}
    </span>
  );
}

const RUNNING_STATES: RunStatus[] = ["running", "pending", "planning", "researching", "writing"];

export function ResearchPanel() {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const toast = useAppStore((s) => s.toast);

  const [reports, setReports] = React.useState<ResearchReportDTO[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [viewReport, setViewReport] = React.useState<ResearchReportDTO | null>(null);

  // Form state.
  const [topic, setTopic] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [numRounds, setNumRounds] = React.useState(2);
  const [temperature, setTemperature] = React.useState(0.6);
  const [leadId, setLeadId] = React.useState<string>("");
  const [memberIds, setMemberIds] = React.useState<string[]>([]);
  const [creating, setCreating] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const [ar, rr] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/research").then((r) => r.json()),
      ]);
      if (Array.isArray(ar)) setAgents(ar);
      if (Array.isArray(rr)) setReports(rr);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [setAgents]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll running research every 3s.
  React.useEffect(() => {
    const hasRunning = reports.some((r) => RUNNING_STATES.includes(r.status));
    if (!hasRunning) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/research");
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) setReports(data);
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [reports]);

  const toggleMember = (id: string) => {
    setMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreate = async () => {
    if (!topic.trim()) {
      toast({
        title: "Missing topic",
        description: "A research topic is required.",
        variant: "destructive",
      });
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          description: description.trim() || undefined,
          numRounds,
          temperature,
          leadId: leadId || undefined,
          memberIds,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const created: ResearchReportDTO = await res.json();
      setReports((prev) => [created, ...prev]);
      setTopic("");
      setDescription("");
      setLeadId("");
      setMemberIds([]);
      setNumRounds(2);
      setTemperature(0.6);
      toast({ title: "Research created", variant: "success" });
    } catch (e) {
      toast({
        title: "Create failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRun = async (id: string) => {
    setReports((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "planning" } : r)),
    );
    try {
      const res = await fetch(`/api/research/${id}/run`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const updated: ResearchReportDTO = await res.json();
      setReports((prev) => prev.map((r) => (r.id === id ? updated : r)));
      toast({ title: "Research completed", variant: "success" });
    } catch (e) {
      toast({
        title: "Run failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      setReports((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "failed" } : r)),
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/research/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReports((prev) => prev.filter((r) => r.id !== id));
      toast({ title: "Report deleted", variant: "success" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Research</h2>
        <p className="text-sm text-muted-foreground">
          Multi-agent research pipeline — planning → researching → writing a final report.
        </p>
      </div>

      {/* New research form */}
      <section className="rounded-xl border bg-card p-4 shadow-sm">
        <header className="mb-3 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Plus className="size-4" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">New Research</h3>
        </header>
        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="research-topic">Topic</Label>
            <Input
              id="research-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. De novo design of SARS-CoV-2 RBD nanobodies"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="research-desc">Description / scope</Label>
            <Textarea
              id="research-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional context, constraints, success criteria…"
              rows={3}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="research-rounds">Rounds</Label>
              <Input
                id="research-rounds"
                type="number"
                min={1}
                max={6}
                value={numRounds}
                onChange={(e) => setNumRounds(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="research-temp">Temperature</Label>
              <Input
                id="research-temp"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value) || 0.6)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Lead agent</Label>
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose lead (optional)…" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Select the team lead agent</p>
          </div>

          <div className="grid gap-1.5">
            <Label>Members ({memberIds.length} selected)</Label>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents available — seed built-ins first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => {
                  const active = memberIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleMember(a.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                        active ? "border-transparent text-white" : "bg-background hover:bg-accent"
                      }`}
                      style={active ? { background: a.color } : undefined}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ background: active ? "#fff" : a.color }}
                      />
                      {a.title}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Add team members</p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create research
            </Button>
          </div>
        </div>
      </section>

      {/* Reports list */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          {reports.length} report{reports.length === 1 ? "" : "s"}
        </h3>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading research…
          </div>
        ) : reports.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <FlaskConical className="size-8 opacity-50" />
              No research yet. Create one above.
            </CardContent>
          </Card>
        ) : (
          reports.map((r) => (
            <ResearchCard
              key={r.id}
              report={r}
              agents={agents}
              onRun={() => handleRun(r.id)}
              onView={() => setViewReport(r)}
              onDelete={() => handleDelete(r.id)}
            />
          ))
        )}
      </div>

      {/* Report dialog */}
      <Dialog open={!!viewReport} onOpenChange={(o) => !o && setViewReport(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewReport?.topic}</DialogTitle>
            <DialogDescription>
              {viewReport?.numRounds ?? 0} round{(viewReport?.numRounds ?? 0) === 1 ? "" : "s"}
              {viewReport?.temperature ? ` · T=${viewReport.temperature}` : ""}
            </DialogDescription>
          </DialogHeader>
          {viewReport?.report ? (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown>{viewReport.report}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No report yet — run the research to generate one.</p>
          )}
          {viewReport && viewReport.discussion.length > 0 && (
            <DiscussionCollapsible messages={viewReport.discussion} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResearchCard({
  report,
  agents,
  onRun,
  onView,
  onDelete,
}: {
  report: ResearchReportDTO;
  agents: { id: string; title: string; color: string }[];
  onRun: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const isRunning = RUNNING_STATES.includes(report.status);
  const lead = agents.find((a) => a.id === report.leadId);
  const members = report.memberIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as { id: string; title: string; color: string }[];
  const accent = (STATUS_META[report.status] ?? STATUS_META["draft"]).accent;

  return (
    <Card
      className="overflow-hidden transition-shadow hover:shadow-md"
      style={{ borderLeftColor: accent, borderLeftWidth: 3 }}
    >
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="size-4 text-amber-500" />
              <h4 className="font-medium leading-tight">{report.topic}</h4>
              <StatusPill status={report.status} />
            </div>
            {report.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">{report.description}</p>
            )}
          </div>
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="size-3" />
            {timeAgo(report.createdAt)}
          </span>
        </div>

        {(lead || members.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {lead && (
              <Badge variant="secondary" className="gap-1 text-[10px]" style={{ background: `${lead.color}1a`, color: lead.color }}>
                <span className="size-1.5 rounded-full" style={{ background: lead.color }} />
                lead: {lead.title}
              </Badge>
            )}
            {members.map((m) => (
              <span
                key={m.id}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                style={{ background: `${m.color}1a`, color: m.color }}
              >
                <span className="size-1.5 rounded-full" style={{ background: m.color }} />
                {m.title}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="default" onClick={onRun} disabled={isRunning}>
            {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onView}
            disabled={!report.report && report.discussion.length === 0}
          >
            <Eye className="size-3.5" />
            View report
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="ml-auto text-destructive hover:text-destructive">
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        {isRunning && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600">
            <Loader2 className="size-3.5 animate-spin" />
            {report.status}…
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DiscussionCollapsible({ messages }: { messages: DiscussionMessage[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-2 rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Discussion transcript ({messages.length} message{messages.length === 1 ? "" : "s"})
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          {messages.map((msg, i) => {
            const color = msg.agentColor ?? "#64748b";
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  <span className="font-medium" style={{ color }}>{msg.agentName}</span>
                  {typeof msg.roundIndex === "number" && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                      round {msg.roundIndex + 1}
                    </span>
                  )}
                  {msg.phase && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{msg.phase}</span>
                  )}
                </div>
                <div className="ml-4 rounded-md bg-muted px-3 py-2 text-sm">
                  <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <ReactMarkdown>{msg.message}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
