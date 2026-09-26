"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import {
  Plus,
  Play,
  Trash2,
  Eye,
  Loader2,
  Sparkles,
  SquarePen,
  CheckCircle2,
  Clock,
  AlertCircle,
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
import { QUICK_START_AGENDA } from "@/lib/agents";
import type { TaskDTO, RunStatus } from "@/lib/types";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";

/** Relative time formatter — "3m ago", "2h ago", "1d ago". */
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
  queued: {
    label: "Queued",
    pill: "bg-muted text-muted-foreground",
    accent: "#94a3b8",
  },
  idle: {
    label: "Idle",
    pill: "bg-muted text-muted-foreground",
    accent: "#94a3b8",
  },
  draft: {
    label: "Draft",
    pill: "bg-muted text-muted-foreground",
    accent: "#94a3b8",
  },
  pending: {
    label: "Pending",
    pill: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    accent: "#3b82f6",
  },
  running: {
    label: "Running",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "#f59e0b",
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
    pill: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
    accent: "#06b6d4",
  },
};

function StatusPill({ status }: { status: RunStatus | string }) {
  const meta = STATUS_META[status] ?? STATUS_META["idle"];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${meta.pill}`}
    >
      {meta.label}
    </span>
  );
}

export function TasksPanel() {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const toast = useAppStore((s) => s.toast);

  const [tasks, setTasks] = React.useState<TaskDTO[]>([]);
  const [loading, setLoading] = React.useState(true);

  // New-task form state.
  const [title, setTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [taskType, setTaskType] = React.useState<string>("general");
  const [selectedAgents, setSelectedAgents] = React.useState<string[]>([]);
  const [tagsInput, setTagsInput] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [resultTask, setResultTask] = React.useState<TaskDTO | null>(null);

  // Initial load — refresh agents + tasks.
  const refresh = React.useCallback(async () => {
    try {
      const [ar, tr] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/tasks").then((r) => r.json()),
      ]);
      if (Array.isArray(ar)) setAgents(ar);
      if (Array.isArray(tr)) setTasks(tr);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [setAgents]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll running tasks every 2s.
  React.useEffect(() => {
    const hasRunning = tasks.some(
      (t) => t.status === "running" || t.status === "pending" || t.status === "queued",
    );
    if (!hasRunning) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/tasks");
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) setTasks(data);
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [tasks]);

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreate = async () => {
    if (!title.trim() || !prompt.trim()) {
      toast({
        title: "Missing fields",
        description: "Title and prompt are required.",
        variant: "destructive",
      });
      return;
    }
    setCreating(true);
    const tags = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          prompt: prompt.trim(),
          taskType,
          agentIds: selectedAgents,
          tags,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const created: TaskDTO = await res.json();
      setTasks((prev) => [created, ...prev]);
      setTitle("");
      setPrompt("");
      setTaskType("general");
      setSelectedAgents([]);
      setTagsInput("");
      toast({ title: "Task created", variant: "success" });
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
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: "running" } : t)),
    );
    try {
      const res = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const updated: TaskDTO = await res.json();
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      toast({ title: "Task completed", variant: "success" });
    } catch (e) {
      toast({
        title: "Run failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "failed" } : t)),
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      toast({ title: "Task deleted", variant: "success" });
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
        <h2 className="text-2xl font-semibold tracking-tight">Tasks</h2>
        <p className="text-sm text-muted-foreground">
          Submit one-off prompts to agents — manual task surface, preserved.
        </p>
      </div>

      {/* New task form */}
      <section className="rounded-xl border bg-card p-4 shadow-sm">
        <header className="mb-3 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <SquarePen className="size-4" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">New Task</h3>
        </header>
        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short title for this task"
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="task-prompt">Prompt</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPrompt(QUICK_START_AGENDA)}
              >
                <Sparkles className="size-3" />
                Use example
              </Button>
            </div>
            <Textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task in detail. Agents will respond using their persona + tools."
              rows={4}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Task type</Label>
              <Select value={taskType} onValueChange={setTaskType}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">general</SelectItem>
                  <SelectItem value="design">design</SelectItem>
                  <SelectItem value="analysis">analysis</SelectItem>
                  <SelectItem value="research">research</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-tags">Tags (comma-separated)</Label>
              <Input
                id="task-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="e.g. antibody, RBD"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Agents ({selectedAgents.length} selected)</Label>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents available — seed built-ins first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => {
                  const active = selectedAgents.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAgent(a.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                        active
                          ? "border-transparent text-white"
                          : "bg-background hover:bg-accent"
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
          </div>

          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create task
            </Button>
          </div>
        </div>
      </section>

      {/* Task list */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </h3>
        {loading ? (
          <PanelSkeleton count={3} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={SquarePen}
            title="No tasks yet"
            description="Create a task above to run a prompt with your agents."
          />
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              agents={agents}
              onRun={() => handleRun(t.id)}
              onView={() => setResultTask(t)}
              onDelete={() => handleDelete(t.id)}
            />
          ))
        )}
      </div>

      {/* Result dialog */}
      <Dialog open={!!resultTask} onOpenChange={(o) => !o && setResultTask(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{resultTask?.title}</DialogTitle>
            <DialogDescription>Task result</DialogDescription>
          </DialogHeader>
          <div className="prose prose-sm dark:prose-invert max-w-none break-words">
            {resultTask?.result ? (
              <ReactMarkdown>{resultTask.result}</ReactMarkdown>
            ) : (
              <p className="text-sm text-muted-foreground">No result yet.</p>
            )}
          </div>
          {resultTask?.logs && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">Logs</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                {resultTask.logs}
              </pre>
            </details>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskCard({
  task,
  agents,
  onRun,
  onView,
  onDelete,
}: {
  task: TaskDTO;
  agents: { id: string; title: string; color: string }[];
  onRun: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const isRunning = task.status === "running" || task.status === "pending" || task.status === "queued";
  const taskAgents = task.agentIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as { id: string; title: string; color: string }[];
  const accent = (STATUS_META[task.status] ?? STATUS_META["idle"]).accent;

  return (
    <Card
      className="overflow-hidden transition-shadow hover:shadow-md"
      style={{ borderLeftColor: accent, borderLeftWidth: 3 }}
    >
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-medium leading-tight">{task.title}</h4>
              <StatusPill status={task.status} />
              <Badge variant="outline" className="text-[10px]">{task.taskType}</Badge>
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
          </div>
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="size-3" />
            {timeAgo(task.createdAt)}
          </span>
        </div>

        {taskAgents.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {taskAgents.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                style={{ background: `${a.color}1a`, color: a.color }}
              >
                <span className="size-1.5 rounded-full" style={{ background: a.color }} />
                {a.title}
              </span>
            ))}
          </div>
        )}

        {task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {task.tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">#{t}</Badge>
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
            disabled={!task.result && task.status !== "failed"}
          >
            <Eye className="size-3.5" />
            View result
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="ml-auto text-destructive hover:text-destructive">
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        {task.status === "completed" && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-600">
            <CheckCircle2 className="size-3.5" />
            Completed {task.completedAt ? timeAgo(task.completedAt) : ""}
          </div>
        )}
        {task.status === "failed" && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5" />
            Run failed — see logs.
          </div>
        )}
        {isRunning && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600">
            <Loader2 className="size-3.5 animate-spin" />
            Running…
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// End of tasks-panel.
