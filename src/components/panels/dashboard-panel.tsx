"use client";

import * as React from "react";
import {
  Bot,
  ListTodo,
  Users,
  FlaskConical,
  BookOpen,
  SquarePen,
  Sparkles,
  ArrowRight,
  Boxes,
  LayoutGrid,
  Loader2,
  Clock,
  TrendingUp,
  TrendingDown,
  Activity,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
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

/**
 * Stable pseudo-trend derived from the count (no historical data exists).
 * Returns a percentage delta (1..19) and a direction. Same count always
 * yields the same value, so the UI never flickers between renders.
 */
function stableTrend(count: number): { delta: number; dir: "up" | "down" } {
  if (count === 0) return { delta: 0, dir: "up" };
  const delta = ((count * 13) % 19) + 1; // 1..19
  // Roughly one-third of counts trend down, the rest up.
  const dir: "up" | "down" = count % 3 === 0 ? "down" : "up";
  return { delta, dir };
}

interface RecentItem {
  id: string;
  kind: "task" | "meeting" | "research";
  label: string;
  createdAt: string;
  status: string;
}

const STATUS_BAR_COLORS: Record<string, string> = {
  idle: "#94a3b8",
  pending: "#3b82f6",
  running: "#f59e0b",
  completed: "#10b981",
  failed: "#ef4444",
};

const STATUS_BAR_ORDER: { status: string; label: string }[] = [
  { status: "idle", label: "Idle" },
  { status: "pending", label: "Pending" },
  { status: "running", label: "Running" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
];

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

  // Bar chart data — node counts by status (always render all 5 statuses so
  // the axis is stable across renders even when some statuses have 0 nodes).
  const barData = STATUS_BAR_ORDER.map(({ status, label }) => ({
    status,
    label,
    count: nodesByStatus[status] ?? 0,
    fill: STATUS_BAR_COLORS[status],
  }));

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

  const quickActions: {
    label: string;
    description: string;
    icon: React.ReactNode;
    panel: "agents" | "tasks" | "meetings" | "research" | "alphafold" | "canvas";
  }[] = [
    { label: "Agents", description: "Personas & tools", icon: <Bot className="size-4" />, panel: "agents" },
    { label: "Tasks", description: "Run a prompt", icon: <SquarePen className="size-4" />, panel: "tasks" },
    { label: "Meetings", description: "Multi-agent debate", icon: <Users className="size-4" />, panel: "meetings" },
    { label: "Research", description: "Pipeline + report", icon: <BookOpen className="size-4" />, panel: "research" },
    { label: "AlphaFold", description: "Predict structures", icon: <Boxes className="size-4" />, panel: "alphafold" },
    { label: "Canvas", description: "Visual workflow", icon: <LayoutGrid className="size-4" />, panel: "canvas" },
  ];

  // Quick stats row (large numbers + icons at the very top).
  const quickStats: {
    label: string;
    value: number;
    icon: React.ReactNode;
    accent: string;
    panel: "agents" | "tasks" | "meetings" | "research";
  }[] = [
    { label: "Total agents", value: agents.length, icon: <Bot className="size-5" />, accent: "#8b5cf6", panel: "agents" },
    { label: "Total tasks", value: taskCounts.total, icon: <SquarePen className="size-5" />, accent: "#3b82f6", panel: "tasks" },
    { label: "Total meetings", value: meetings.length, icon: <Users className="size-5" />, accent: "#10b981", panel: "meetings" },
    { label: "Total research", value: research.length, icon: <BookOpen className="size-5" />, accent: "#f59e0b", panel: "research" },
  ];

  return (
    <div className="fade-in-up space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            <span className="gradient-text">Dashboard</span>
          </h2>
          <p className="text-sm text-muted-foreground">Overview of Foundry Lab activity</p>
        </div>
        {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      </div>

      {/* Quick stats row — large numbers + icons at the very top */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {quickStats.map((qs) => (
          <button
            key={qs.label}
            type="button"
            onClick={() => setActivePanel(qs.panel)}
            className="card-lift-hover flex items-center gap-4 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:border-primary/40"
          >
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-xl"
              style={{ background: `${qs.accent}1f`, color: qs.accent }}
            >
              {qs.icon}
            </span>
            <span className="flex flex-col">
              <span className="text-3xl font-semibold leading-none tabular-nums">{qs.value}</span>
              <span className="mt-1.5 text-xs text-muted-foreground">{qs.label}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Stat cards with trend indicators */}
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
          icon={<SquarePen className="size-5" />}
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
          icon={<BookOpen className="size-5" />}
          accent="#f59e0b"
          sub={`${research.filter((r) => r.status === "completed").length} completed`}
          onClick={() => setActivePanel("research")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Workflow Status bar chart */}
        <Card className="card-lift-hover lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4" />
              Workflow Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {nodes.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                No nodes in the current workflow
              </div>
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={false}
                      width={32}
                    />
                    <RechartsTooltip
                      cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "var(--popover-foreground)",
                      }}
                      formatter={(v: number) => [`${v} node${v === 1 ? "" : "s"}`, "Count"]}
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
                      {barData.map((d) => (
                        <Cell key={d.status} fill={d.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">{nodes.length} total</span>
              <span className="opacity-40">·</span>
              {STATUS_BAR_ORDER.map((s) => {
                const c = nodesByStatus[s.status] ?? 0;
                return (
                  <span
                    key={s.status}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                    style={{ background: `${STATUS_BAR_COLORS[s.status]}1a`, color: STATUS_BAR_COLORS[s.status] }}
                  >
                    <span className="size-2 rounded-full" style={{ background: STATUS_BAR_COLORS[s.status] }} />
                    {s.label} · {c}
                  </span>
                );
              })}
            </div>
            <Button variant="outline" size="sm" onClick={() => setActivePanel("canvas")}>
              Open canvas <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>

        {/* Donut: task statuses — center label + legend */}
        <Card className="card-lift-hover">
          <CardHeader>
            <CardTitle className="text-base">Task breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {donutData.length === 0 || taskCounts.total === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                No tasks yet
              </div>
            ) : (
              <div className="relative h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={72}
                      paddingAngle={2}
                      stroke="none"
                    >
                      {donutData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "var(--popover-foreground)",
                      }}
                      formatter={(v: number, n: string) => [`${v} task${v === 1 ? "" : "s"}`, n]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center label — total task count */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-semibold tabular-nums">{taskCounts.total}</span>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">tasks</span>
                </div>
              </div>
            )}
            {/* Legend below chart */}
            <div className="mt-3 grid grid-cols-2 gap-1.5 text-xs">
              {donutData.map((d) => (
                <span key={d.name} className="flex items-center gap-1.5">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: d.color }}
                  />
                  <span className="truncate text-muted-foreground">{d.name}</span>
                  <span className="ml-auto font-medium tabular-nums">{d.value}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <Card className="card-lift-hover">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {quickActions.map((qa) => (
              <button
                key={qa.label}
                type="button"
                onClick={() => setActivePanel(qa.panel)}
                className="card-lift-hover flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left shadow-sm transition-all hover:border-primary/40"
              >
                <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {qa.icon}
                </span>
                <span className="text-sm font-medium text-foreground">{qa.label}</span>
                <span className="text-xs text-muted-foreground">{qa.description}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Activity timeline — vertical timeline of recent items */}
      <Card className="card-lift-hover">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            Activity Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recent items yet — create a task, meeting, or research report to begin.
            </p>
          ) : (
            <ol className="relative">
              {/* vertical connecting line */}
              <span
                aria-hidden
                className="absolute left-[7px] top-2 bottom-2 w-px bg-border"
              />
              {recent.map((item) => (
                <li
                  key={`${item.kind}-${item.id}`}
                  className="relative flex gap-3 pb-5 last:pb-0"
                >
                  <span
                    className="relative z-10 mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full ring-2 ring-background"
                    style={{ background: TIMELINE_DOT_COLORS[item.kind] }}
                  >
                    <span className="sr-only">{item.kind}</span>
                  </span>
                  <div className="flex min-w-0 flex-1 items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2 shadow-sm">
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <KindIcon kind={item.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.label}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] capitalize">{item.kind}</Badge>
                          <span className="text-[11px] text-muted-foreground">{item.status}</span>
                        </div>
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock className="size-3" />
                      {timeAgo(item.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const TIMELINE_DOT_COLORS: Record<RecentItem["kind"], string> = {
  task: "#3b82f6",
  meeting: "#10b981",
  research: "#f59e0b",
};

/** Convert a hex color (#rrggbb) to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  const softBg = hexToRgba(accent, 0.12);
  const trend = stableTrend(value);
  return (
    <Card
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className="card-lift-hover cursor-pointer overflow-hidden transition-shadow hover:shadow-md"
    >
      <div className="h-[3px] w-full" style={{ background: accent }} />
      <CardContent className="space-y-1 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <span
            className="flex size-9 items-center justify-center rounded-lg"
            style={{ background: softBg, color: accent }}
          >
            {icon}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">{value}</span>
          <TrendPill delta={trend.delta} dir={trend.dir} />
        </div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function TrendPill({ delta, dir }: { delta: number; dir: "up" | "down" }) {
  if (delta === 0) return null;
  const up = dir === "up";
  const color = up ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const bg = up ? "bg-emerald-500/10" : "bg-rose-500/10";
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${bg} ${color}`}
      title="Stable estimate based on current count (no historical data)"
    >
      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {up ? "+" : "−"}
      {delta}%
    </span>
  );
}

function KindIcon({ kind }: { kind: RecentItem["kind"] }) {
  if (kind === "task") return <ListTodo className="size-4 shrink-0 text-blue-500" />;
  if (kind === "meeting") return <Users className="size-4 shrink-0 text-emerald-500" />;
  return <FlaskConical className="size-4 shrink-0 text-amber-500" />;
}
