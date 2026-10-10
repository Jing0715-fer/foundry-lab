"use client";

// Skills observability panel — registry browser + invocation audit log.
//
// Two tabs over the J-lane skill layer:
// - Registry: the /api/skills catalog grouped by family (comp/bio/web/canvas)
//   with expandable param docs and a client-side search filter.
// - Activity: the /api/skills/invocations audit log — every agent operation
//   in the system (chat tool calls, workflow nodes, PI canvas edits, REST
//   tool runs) flows through runSkill() and lands here.

import * as React from "react";
import {
  Activity,
  AlertCircle,
  BookOpen,
  Braces,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";
import { cn } from "@/lib/utils";

// --- Wire types (mirror the /api/skills + /api/skills/invocations DTOs) ------
// Defined locally so no server module (src/lib/skills/* pulls Prisma) ever
// crosses into the client bundle; the server owns the source of truth.

type SkillFamily = "comp" | "bio" | "web" | "canvas";
type SkillRequirement = "bioToolsEnabled" | "webSearchEnabled";

interface SkillParamDef {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  description: string;
}

interface SkillCatalogEntry {
  id: string;
  family: SkillFamily;
  label: string;
  description: string;
  aliases: string[];
  params: SkillParamDef[];
  requires: SkillRequirement[];
  latency: "fast" | "slow";
  example?: Record<string, unknown>;
  /** Only present when the catalog was fetched with ?agentId= — resolved
   * against that agent's knowledge flags (same rule runSkill enforces). */
  eligible?: boolean;
}

interface SkillInvocationDTO {
  id: string;
  skillId: string;
  source: string;
  agentId: string | null;
  agentTitle: string | null;
  workflowId: string | null;
  nodeId: string | null;
  status: string;
  params: Record<string, unknown>;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

// --- Shared helpers ----------------------------------------------------------

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

/** 503 → "503ms", 1234 → "1.2s". */
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- Registry metadata -------------------------------------------------------

const FAMILY_ORDER: SkillFamily[] = ["comp", "bio", "web", "canvas"];

const FAMILY_META: Record<SkillFamily, { label: string; pill: string }> = {
  comp: {
    label: "Computational engines",
    pill: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  },
  bio: {
    label: "Bio knowledge tools",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  web: {
    label: "Web tools",
    pill: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  canvas: {
    label: "PI canvas mutations",
    pill: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
  },
};

const LATENCY_META: Record<string, { label: string; pill: string }> = {
  fast: {
    label: "fast",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  slow: {
    label: "slow",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

const REQUIREMENT_LABELS: Record<SkillRequirement, string> = {
  bioToolsEnabled: "bio tools",
  webSearchEnabled: "web search",
};

// --- Activity metadata -------------------------------------------------------

const INV_STATUS_META: Record<string, { label: string; pill: string }> = {
  ok: {
    label: "ok",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  error: {
    label: "error",
    pill: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  },
  denied: {
    label: "denied",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  invalid: {
    label: "invalid",
    pill: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
  },
  skipped: {
    label: "skipped",
    pill: "border border-dashed border-slate-400/70 bg-transparent text-slate-600 dark:text-slate-400",
  },
};

function Pill({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        className,
      )}
    >
      {label}
    </span>
  );
}

// ==========================================================================
// Panel
// ==========================================================================

export function SkillsPanel() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
        <p className="text-sm text-muted-foreground">
          Every agent operation runs through one skill registry — browse the
          catalog and inspect the invocation audit trail.
        </p>
      </div>

      <Tabs defaultValue="registry" className="space-y-4">
        <TabsList>
          <TabsTrigger value="registry" className="gap-1.5">
            <BookOpen className="size-3.5" />
            Registry
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <Activity className="size-3.5" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="registry" className="space-y-4">
          <RegistryTab />
        </TabsContent>
        <TabsContent value="activity" className="space-y-4">
          <ActivityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ==========================================================================
// Tab 1 — Registry (skill catalog browser)
// ==========================================================================

function RegistryTab() {
  const [skills, setSkills] = React.useState<SkillCatalogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const loadCatalog = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const toggleSkill = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      q
        ? skills.filter(
            (s) =>
              s.id.toLowerCase().includes(q) ||
              s.label.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q),
          )
        : skills,
    [skills, q],
  );

  const grouped = React.useMemo(
    () =>
      FAMILY_ORDER.map((family) => ({
        family,
        items: filtered.filter((s) => s.family === family),
      })).filter((g) => g.items.length > 0),
    [filtered],
  );

  if (loading) {
    return <PanelSkeleton count={5} />;
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Registry unavailable"
        description={`Failed to load the skill catalog. ${error}`}
        action={
          <Button variant="outline" onClick={loadCatalog}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Client-side search over id / label / description. */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills by id, label, or description…"
          className="pl-8"
          aria-label="Search skills"
        />
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {filtered.length} of {skills.length} skill{skills.length === 1 ? "" : "s"}
        {q ? " matching your search" : ""}
      </p>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No matching skills"
          description="Try a different search term — search covers the skill id, label, and description."
        />
      ) : (
        grouped.map(({ family, items }) => {
          const meta = FAMILY_META[family];
          return (
            <section key={family} className="space-y-2" aria-label={meta.label}>
              <header className="flex items-center gap-2">
                <Pill label={family} className={cn("uppercase", meta.pill)} />
                <h3 className="text-sm font-semibold text-foreground">
                  {meta.label}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {items.length}
                </span>
                <div className="h-px flex-1 bg-border" aria-hidden />
              </header>
              <div className="space-y-2">
                {items.map((s) => (
                  <SkillCard
                    key={s.id}
                    skill={s}
                    open={expanded.has(s.id)}
                    onToggle={() => toggleSkill(s.id)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function SkillCard({
  skill,
  open,
  onToggle,
}: {
  skill: SkillCatalogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const latency = LATENCY_META[skill.latency] ?? LATENCY_META["slow"];
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-accent/50"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code className="font-mono text-xs font-medium text-foreground">
                {skill.id}
              </code>
              <span className="text-sm font-medium text-foreground">
                {skill.label}
              </span>
              <Pill label={latency.label} className={latency.pill} />
              {skill.requires.map((r) => (
                <Pill
                  key={r}
                  label={`requires ${REQUIREMENT_LABELS[r]}`}
                  className="bg-muted text-muted-foreground"
                />
              ))}
              {skill.eligible === true && (
                <Pill
                  label="eligible"
                  className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                />
              )}
              {skill.eligible === false && (
                <Pill
                  label="locked"
                  className="bg-rose-500/10 text-rose-700 dark:text-rose-400"
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {skill.description}
            </p>
          </div>
          <ChevronDown
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>

        {open && (
          <div className="space-y-3 border-t px-4 py-3">
            {skill.aliases.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Aliases:</span>{" "}
                {skill.aliases.join(", ")}
              </p>
            )}

            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-foreground">
                Params ({skill.params.length})
              </h4>
              {skill.params.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No parameters — the skill runs on the request context alone.
                </p>
              ) : (
                skill.params.map((p) => (
                  <div
                    key={p.key}
                    className="space-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs">
                      <span className="font-medium text-foreground">
                        {p.key}
                        <span className="text-muted-foreground">:{p.type}</span>
                      </span>
                      {p.required && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                          required
                        </span>
                      )}
                      {p.default !== undefined && (
                        <span className="text-[10px] text-muted-foreground">
                          default {JSON.stringify(p.default)}
                        </span>
                      )}
                      {p.min !== undefined && (
                        <span className="text-[10px] text-muted-foreground">
                          min {p.min}
                        </span>
                      )}
                      {p.max !== undefined && (
                        <span className="text-[10px] text-muted-foreground">
                          max {p.max}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {p.description}
                    </p>
                  </div>
                ))
              )}
            </div>

            {skill.example && (
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-foreground">Example</h4>
                <pre className="overflow-x-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                  {JSON.stringify(skill.example, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ==========================================================================
// Tab 2 — Activity (invocation audit log)
// ==========================================================================

function ActivityTab() {
  const [invocations, setInvocations] = React.useState<SkillInvocationDTO[]>([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const loadInvocations = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/invocations?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInvocations(Array.isArray(data?.invocations) ? data.invocations : []);
      setCount(typeof data?.count === "number" ? data.count : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadInvocations();
  }, [loadInvocations]);

  const toggleInvocation = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          Latest {invocations.length || count} invocation
          {invocations.length === 1 ? "" : "s"}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={loadInvocations}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {loading ? (
        <PanelSkeleton count={4} />
      ) : error ? (
        <EmptyState
          icon={AlertCircle}
          title="Audit log unavailable"
          description={`Failed to load skill invocations. ${error}`}
          action={
            <Button variant="outline" onClick={loadInvocations}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
        />
      ) : invocations.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No skill invocations yet"
          description="Every agent operation — chat tool calls, workflow nodes, PI canvas edits, and REST tool runs — is audited here. Run an agent chat with a bio query (e.g. search PubMed for nanobodies) to see entries appear."
          action={
            <Button variant="outline" onClick={loadInvocations}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />
      ) : (
        /* Long-list pattern: capped height + internal scroll (thin custom
           scrollbar styling comes from the global .overflow-y-auto rules). */
        <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-y-auto pr-1">
          {invocations.map((inv) => (
            <InvocationCard
              key={inv.id}
              inv={inv}
              open={expanded.has(inv.id)}
              onToggle={() => toggleInvocation(inv.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InvocationCard({
  inv,
  open,
  onToggle,
}: {
  inv: SkillInvocationDTO;
  open: boolean;
  onToggle: () => void;
}) {
  const status = INV_STATUS_META[inv.status] ?? INV_STATUS_META["invalid"];
  const summary = inv.error ?? inv.resultSummary;
  const paramKeys = Object.keys(inv.params);

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-2 py-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <code className="font-mono text-xs font-medium text-foreground">
            {inv.skillId}
          </code>
          <Pill label={status.label} className={status.pill} />
          <Pill
            label={inv.source}
            className="bg-muted uppercase text-muted-foreground"
          />
          {inv.agentTitle && (
            <Badge variant="outline" className="text-[10px] font-normal">
              {inv.agentTitle}
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <span className="tabular-nums">{formatDuration(inv.durationMs)}</span>
            <Clock className="size-3" aria-hidden />
            <span>{timeAgo(inv.createdAt)}</span>
          </span>
        </div>

        {/* resultSummary / error — truncated to one line until expanded. */}
        {summary && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="w-full text-left"
            title={open ? "Collapse" : "Expand full text"}
          >
            <p
              className={cn(
                "text-xs leading-relaxed",
                inv.error
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground",
                !open && "line-clamp-1",
              )}
            >
              {summary}
            </p>
          </button>
        )}

        {/* Params — collapsible JSON view (omitted when empty). */}
        {paramKeys.length > 0 && (
          <div className="rounded-md border">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              )}
              <Braces className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              params ({paramKeys.length})
            </button>
            {open && (
              <pre className="max-h-40 overflow-y-auto border-t bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                {JSON.stringify(inv.params, null, 2)}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
