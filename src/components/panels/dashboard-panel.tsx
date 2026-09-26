"use client";

import * as React from "react";
import {
  Bot,
  ListTodo,
  Users,
  FlaskConical,
  Workflow as WorkflowIcon,
  Sparkles,
  ArrowRight,
  Wrench,
  LayoutGrid,
  CircleDot,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import type {
  AgentDTO,
  TaskDTO,
  MeetingDTO,
  ResearchReportDTO,
  WorkflowDTO,
} from "@/lib/types";

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

interface RecentItem {
  id: string;
  kind: "task" | "meeting" | "research";
  label: string;
  createdAt: string;
  status: string;
}

export function DashboardPanel() {
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const [agents, setAgents] = React.useState<AgentDTO[]>([]);
  const [tasks, setTasks] = React.useState<TaskDTO[]>([]);
  const [meetings, setMeetings] = React.useState<MeetingDTO[]>([]);
  const [research, setResearch] = React.useState<ResearchReportDTO[]>([]);
  const [workflow, setWorkflow] = React.useState<WorkflowDTO | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, t, m, r, w] = await Promise.all([
          fetch("/api/agents").then((x) => x.json()),
          fetch("/api/tasks").then((x) => x.json()),
          fetch("/api/meetings").then((x) => x.json()),
          fetch("/api/research").then((x) => x.json()),
          fetch("/api/workflow").then((x) => x.json()),
        ]);
        if (cancelled) return;
        setAgents(Array.isArray(a) ? a : []);
        setTasks(Array.isArray(t) ? t : []);
        setMeetings(Array.isArray(m) ? m : []);
        setResearch(Array.isArray(r) ? r : []);
        setWorkflow(w ?? null);
      } catch {
        // ignore — leave empties
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Aggregate recent activity across tasks/meetings/research (top 5).
  const recent: RecentItem[] = React.useMemo(() => {
    const r: RecentItem[] = [];
    for (const t of tasks) r.push({ id: t.id, kind: "task", label: t.title, createdAt: t.createdAt, status: t.status });
    for (const m of meetings) r.push({ id: m.id, kind: "meeting", label: m.saveName ?? m.agenda.slice(0, 60), createdAt: m.createdAt, status: m.status });
    for (const x of research) r.push({ id: x.id, kind: "research", label: x.topic, createdAt: x.createdAt, status: x.status });
    return r.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 5);
  }, [tasks, meetings, research]);

  const taskCounts = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    running: tasks.filter((t) => t.status === "running" || t.status === "pending" || t.status === "queued").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  const nodes = workflow?.nodes ?? [];
  const nodesByStatus: Record<string, number> = {};
  for (const n of nodes) nodesByStatus[n.status] = (nodesByStatus[n.status] ?? 0) + 1;

  // Donut data — task status breakdown.
  const donutData = [
    { name: "Completed", value: taskCounts.completed, color: "#10b981" },
    { name: "Running", value: taskCounts.running, color: "#3b82f6" },
    { name: "Failed", value: taskCounts.failed, color: "#ef4444" },
    {
      name: "Other",
      value: Math.max(0, taskCounts.total - taskCounts.completed - taskCounts.running - taskCounts.failed),
      color: "#94a3b8",
    },
  ].filter((d) => d.value > 0);

  const quickActions: { label: string; icon: React.ReactNode; panel: "agents" | "tasks" | "meetings" | "research" | "tools" | "canvas" }[] = [
    { label: "Agents", icon: <Bot className="size-4" />, panel: "agents" },
    { label: "Tasks", icon: <ListTodo className="size-4" />, panel: "tasks" },
    { label: "Meetings", icon: <Users className="size-4" />, panel: "meetings" },
    { label: "Research", icon: <FlaskConical className="size-4" />, panel: "research" },
    { label: "Tools", icon: <Wrench className="size-4" />, panel: "tools" },
    { label: "Canvas", icon: <LayoutGrid className="size-4" />, panel: "canvas" },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">Overview of Foundry Lab activity</p>
        </div>
        {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Agents"
          value={agents.length}
          icon={<Bot className="size-5" />}
          accent="#8b5cf6"
          sub={`${agents.filter((a) => a.builtin).length} built-in`}
          onClick={() => setActivePanel("agents")}
        />
        <StatCard
          title="Tasks"
          value={taskCounts.total}
          icon={<ListTodo className="size-5" />}
          accent="#3b82f6"
          sub={`${taskCounts.completed} done · ${taskCounts.running} running`}
          onClick={() => setActivePanel("tasks")}
        />
        <StatCard
          title="Meetings"
          value={meetings.length}
          icon={<Users className="size-5" />}
          accent="#10b981"
          sub={`${meetings.filter((m) => m.type === "team").length} team · ${meetings.filter((m) => m.type === "individual").length} individual`}
          onClick={() => setActivePanel("meetings")}
        />
        <StatCard
          title="Research Reports"
          value={research.length}
          icon={<FlaskConical className="size-5" />}
          accent="#f59e0b"
          sub={`${research.filter((r) => r.status === "completed").length} completed`}
          onClick={() => setActivePanel("research")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Workflow nodes card */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <WorkflowIcon className="size-4" />
              Workflow Nodes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold">{nodes.length}</span>
              <span className="text-sm text-muted-foreground">total nodes</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <NodeStatusChip status="idle" count={nodesByStatus["idle"] ?? 0} />
              <NodeStatusChip status="pending" count={nodesByStatus["pending"] ?? 0} />
              <NodeStatusChip status="running" count={nodesByStatus["running"] ?? 0} />
              <NodeStatusChip status="completed" count={nodesByStatus["completed"] ?? 0} />
              <NodeStatusChip status="failed" count={nodesByStatus["failed"] ?? 0} />
            </div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setActivePanel("canvas")}>
              Open canvas <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>

        {/* Donut: task statuses */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Task breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {donutData.length === 0 || taskCounts.total === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                No tasks yet
              </div>
            ) : (
              <div className="h-40 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={42}
                      outerRadius={64}
                      paddingAngle={2}
                    >
                      {donutData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {donutData.map((d) => (
                <span key={d.name} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: d.color }} />
                  {d.name} ({d.value})
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {quickActions.map((qa) => (
              <Button
                key={qa.label}
                variant="outline"
                className="justify-start"
                onClick={() => setActivePanel(qa.panel)}
              >
                {qa.icon}
                {qa.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent items yet — create a task, meeting, or research report to begin.</p>
          ) : (
            <ul className="space-y-2">
              {recent.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 rounded-md border p-2.5 text-sm">
                  <KindIcon kind={item.kind} />
                  <span className="flex-1 truncate">{item.label}</span>
                  <Badge variant="outline" className="text-xs">{item.kind}</Badge>
                  <span className="text-xs text-muted-foreground">{timeAgo(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
  accent,
  sub,
  onClick,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
  sub?: string;
  onClick?: () => void;
}) {
  return (
    <Card
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className="cursor-pointer overflow-hidden transition-colors hover:bg-accent/50"
    >
      <div className="h-1 w-full" style={{ background: accent }} />
      <CardContent className="space-y-1 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <div className="text-3xl font-semibold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function NodeStatusChip({ status, count }: { status: string; count: number }) {
  const map: Record<string, { color: string; icon: React.ReactNode }> = {
    idle: { color: "#94a3b8", icon: <CircleDot className="size-3" /> },
    pending: { color: "#3b82f6", icon: <Loader2 className="size-3" /> },
    running: { color: "#f59e0b", icon: <Loader2 className="size-3 animate-spin" /> },
    completed: { color: "#10b981", icon: <CheckCircle2 className="size-3" /> },
    failed: { color: "#ef4444", icon: <XCircle className="size-3" /> },
  };
  const s = map[status] ?? map["idle"];
  return (
    <span
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
      style={{ background: `${s.color}1a`, color: s.color }}
    >
      {s.icon}
      {status} · {count}
    </span>
  );
}

function KindIcon({ kind }: { kind: RecentItem["kind"] }) {
  if (kind === "task") return <ListTodo className="size-4 text-blue-500" />;
  if (kind === "meeting") return <Users className="size-4 text-emerald-500" />;
  return <FlaskConical className="size-4 text-amber-500" />;
}
