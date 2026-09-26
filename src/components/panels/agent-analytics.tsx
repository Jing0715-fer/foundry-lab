"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Bot, MessageSquare, Wrench, Workflow, type LucideIcon } from "lucide-react";

interface AgentAnalytics {
  agentId: string;
  title: string;
  color: string;
  icon: string;
  chatMessages: number;
  toolJobs: number;
  workflowNodes: number;
  isBuiltin: boolean;
}

/**
 * AgentAnalyticsDialog — opens from the Agents panel's "Analytics" button.
 * Fetches per-agent usage stats from /api/agents/analytics and renders:
 *   - 3 summary stat cards (total messages, tool jobs, workflow nodes)
 *   - bar chart of chat messages per agent
 *   - bar chart of tool jobs per agent
 *   - pie chart of workflow node distribution (only agents with >0 nodes)
 *   - per-agent breakdown table
 */
export function AgentAnalyticsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<AgentAnalytics[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/agents/analytics")
      .then((r) => r.json())
      .then((d) => setData(d.agents ?? []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Bar chart data: agent name → chat messages
  const chatData = data.map((a) => ({
    name: a.title,
    messages: a.chatMessages,
    color: a.color,
  }));
  // Bar chart data: agent name → tool jobs
  const toolData = data.map((a) => ({
    name: a.title,
    jobs: a.toolJobs,
    color: a.color,
  }));
  // Pie data: workflow node distribution (only agents that actually have nodes)
  const nodeData = data
    .filter((a) => a.workflowNodes > 0)
    .map((a) => ({
      name: a.title,
      value: a.workflowNodes,
      color: a.color,
    }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Agent Analytics
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            Loading…
          </div>
        ) : data.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            No agents found
          </div>
        ) : (
          <div className="space-y-6">
            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                icon={MessageSquare}
                label="Total Messages"
                value={data.reduce((s, a) => s + a.chatMessages, 0)}
                color="text-teal-500"
              />
              <StatCard
                icon={Wrench}
                label="Tool Jobs"
                value={data.reduce((s, a) => s + a.toolJobs, 0)}
                color="text-violet-500"
              />
              <StatCard
                icon={Workflow}
                label="Workflow Nodes"
                value={data.reduce((s, a) => s + a.workflowNodes, 0)}
                color="text-amber-500"
              />
            </div>

            {/* Chat messages bar chart */}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Chat Messages per Agent</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chatData}>
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-20}
                      textAnchor="end"
                      height={60}
                      interval={0}
                    />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="messages" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Tool jobs bar chart */}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Tool Jobs per Agent</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={toolData}>
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-20}
                      textAnchor="end"
                      height={60}
                      interval={0}
                    />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="jobs" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Workflow node distribution pie */}
            {nodeData.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  Workflow Node Distribution
                </h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={nodeData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={70}
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={false}
                      >
                        {nodeData.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Agent table */}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Per-Agent Breakdown</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2">Agent</th>
                      <th className="py-2 text-right">Messages</th>
                      <th className="py-2 text-right">Tool Jobs</th>
                      <th className="py-2 text-right">Nodes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((a) => (
                      <tr key={a.agentId} className="border-b">
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2 rounded-full"
                              style={{ background: a.color }}
                            />
                            <span className="truncate">{a.title}</span>
                            {a.isBuiltin && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                                built-in
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {a.chatMessages}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {a.toolJobs}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {a.workflowNodes}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <Icon className={`size-4 ${color}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
