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
  ArrowRight,
  Bot,
  BookOpen,
  Cpu,
  Database,
  Flag,
  Loader2,
  Sparkles,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  return (
    <div className="space-y-4">
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
    </div>
  );
}
