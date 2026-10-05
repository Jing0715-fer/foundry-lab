"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Download,
  Loader2,
  Search,
  Sparkles,
  Star,
  Users,
  X,
} from "lucide-react";
import {
  MARKETPLACE_TEMPLATES,
  type MarketplaceTemplate,
  type MarketplaceCategory,
} from "@/lib/marketplace-templates";
import { useAppStore } from "@/lib/store";
import type { AgentDTO, EdgeDTO, NodeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

const CATEGORY_COLORS: Record<MarketplaceCategory, string> = {
  research: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  design: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  analysis: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  education: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  production: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

const CATEGORIES: Array<"all" | MarketplaceCategory> = [
  "all",
  "research",
  "design",
  "analysis",
  "education",
  "production",
];

export function TemplateMarketplace({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<"all" | MarketplaceCategory>(
    "all",
  );
  const [installingId, setInstallingId] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    let result = MARKETPLACE_TEMPLATES;
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.author.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }
    if (category !== "all") result = result.filter((t) => t.category === category);
    return result;
  }, [query, category]);

  const installTemplate = React.useCallback(
    async (tmpl: MarketplaceTemplate) => {
      if (installingId) return;
      setInstallingId(tmpl.id);
      try {
        const { toast, setActivePanel, workflow, setWorkflow } =
          useAppStore.getState();
        // The current workflow id (multi-workflow contract): the template
        // replaces the graph the user is looking at, and the refresh below
        // re-reads THAT workflow instead of the first one.
        const workflowId = workflow?.id;

        // 1. Resolve refTitle → agent ID (fetch /api/agents once).
        let agents: AgentDTO[] = [];
        if (tmpl.nodes.some((n) => n.refTitle)) {
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
        for (const n of tmpl.nodes) {
          let refId: string | undefined;
          if (n.refTitle) {
            const match = byTitle.get(n.refTitle);
            if (match) refId = match.id;
          }

          const body: Record<string, unknown> = {
            // Target the CURRENT workflow (multi-workflow contract).
            workflowId,
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

        // 4. POST each edge using the real node IDs (non-fatal on dup/cycle).
        for (const e of tmpl.edges) {
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
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn(
              `[marketplace] edge ${e.from}→${e.to} failed:`,
              err?.error ?? res.status,
            );
          }
        }

        // 5. Refresh the workflow from the server (canonical truth) — by id
        //    so a non-first current workflow isn't clobbered.
        const wfRes = await fetch(
          workflowId ? `/api/workflows/${workflowId}` : "/api/workflow",
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
          title: "Template installed",
          description: `${tmpl.name} — ${tmpl.nodes.length} nodes loaded.`,
          variant: "success",
        });
        setActivePanel("canvas");
        onClose();
      } catch (err) {
        useAppStore.getState().toast({
          title: "Install failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setInstallingId(null);
      }
    },
    [installingId, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="flex flex-row items-start justify-between gap-4 border-b px-6 py-4">
          <div className="space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5" />
              Template Marketplace
            </DialogTitle>
            <DialogDescription>
              Install community-curated workflows with one click. This will
              replace the current canvas.
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close marketplace"
          >
            <X className="size-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-3 border-b px-6 py-4">
          {/* Search */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates by name, tag, or author..."
                className="pl-8"
              />
            </div>
          </div>
          {/* Category filter chips */}
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                  category === cat
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Template grid */}
        <ScrollArea className="flex-1 px-6 py-5">
          {filtered.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Search className="size-5 opacity-50" />
              <span>No templates match your filters.</span>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((tmpl, i) => (
                <div
                  key={tmpl.id}
                  className="stagger-in card-lift-glow shine-on-hover group relative flex flex-col rounded-lg border bg-card p-4 shadow-sm transition-all hover:shadow-md"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold leading-tight">
                      {tmpl.name}
                    </h3>
                    <Badge
                      className={cn(
                        "shrink-0 capitalize",
                        CATEGORY_COLORS[tmpl.category],
                      )}
                      variant="secondary"
                    >
                      {tmpl.category}
                    </Badge>
                  </div>
                  <p className="mb-3 line-clamp-2 text-xs text-muted-foreground">
                    {tmpl.description}
                  </p>
                  <div className="mb-3 flex flex-wrap gap-1">
                    {tmpl.tags.slice(0, 4).map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1 truncate">
                      <Users className="size-3 shrink-0" />
                      <span className="truncate">{tmpl.author}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <Star className="size-3" />
                      {tmpl.stars}
                    </span>
                    <span className="flex items-center gap-1">
                      <Download className="size-3" />
                      {tmpl.downloads}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    className="mt-auto w-full gap-1.5"
                    disabled={installingId !== null}
                    onClick={() => void installTemplate(tmpl)}
                  >
                    {installingId === tmpl.id ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Installing…
                      </>
                    ) : (
                      <>
                        <Download className="size-3.5" />
                        Install
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
