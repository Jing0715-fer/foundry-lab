"use client";

// Skills panel (S-line UI) — the standardized capability protocol surface.
//
// Two data sources, one refresh action:
//   GET /api/skills                    → the catalog (registry + per-skill
//                                        invocation stats from the audit table)
//   GET /api/skills/invocations?limit=50 → the recent audit feed
//
// The catalog is grouped by category (Compute / Bio / Search) with one Card
// per skill: mono id, gate badge, description, humanized timeout, a compact
// params table, the exact fence example line the system prompt teaches the
// LLM, and live usage stats when the audit table has rows for it. The
// invocations feed is the audit trail — every agent operation is time-boxed,
// gated, and observable, and this is where you watch it happen.

import * as React from "react";
import {
  Cpu,
  Dna,
  Globe,
  History,
  Loader2,
  Timer,
  Puzzle,
  RefreshCw,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";
import { cn } from "@/lib/utils";

// --- DTO mirrors (client-side; the API routes own the wire format) ---------

interface SkillParamDTO {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default: string | number | boolean | null;
  enumValues: string[] | null;
  min: number | null;
  max: number | null;
  description: string;
}

interface SkillStatsDTO {
  invocations: number;
  completed: number;
  failed: number;
  timeout: number;
  denied: number;
  avgMs: number;
}

interface SkillDTO {
  id: string;
  name: string;
  category: "compute" | "bio" | "search";
  gate: "tools" | "search" | "none";
  description: string;
  timeoutMs: number;
  params: SkillParamDTO[];
  exampleLine: string;
  stats: SkillStatsDTO | null;
}

interface SkillInvocationDTO {
  id: string;
  skillId: string;
  skillName: string;
  category: "compute" | "bio" | "search";
  caller: string;
  agentId: string | null;
  agentTitle: string | null;
  status: "completed" | "failed" | "timeout" | "denied";
  durationMs: number;
  params: Record<string, unknown>;
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
}

// --- Category presentation ---------------------------------------------------

const CATEGORY_META: Record<
  SkillDTO["category"],
  { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }
> = {
  compute: {
    label: "Compute",
    icon: Cpu,
    hint: "Engine-backed design jobs (may run for minutes)",
  },
  bio: {
    label: "Bio",
    icon: Dna,
    hint: "Bioinformatics queries (BLAST, PubMed, PDB…)",
  },
  search: {
    label: "Search",
    icon: Globe,
    hint: "Live web search for literature and context",
  },
};

const CATEGORY_ORDER: SkillDTO["category"][] = ["compute", "bio", "search"];

// Gate → badge presentation. The gate is the PERMISSION the invoking agent's
// knowledge config must satisfy; "none" means every agent can call it.
const GATE_META: Record<
  SkillDTO["gate"],
  { label: string; variant: "secondary" | "outline" | "default" }
> = {
  tools: { label: "Agent tools", variant: "secondary" },
  search: { label: "Web search", variant: "outline" },
  none: { label: "Always on", variant: "default" },
};

// Audit status → pill color (emerald/rose/amber/slate only — no indigo/blue).
const INVOCATION_STATUS_PILL: Record<SkillInvocationDTO["status"], string> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  timeout: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  denied: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

// --- Humanizers ---------------------------------------------------------------

/** 600000 → "10 min"; 30000 → "30 s"; 90000 → "1.5 min". */
function fmtTimeout(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  if (ms < 3_600_000) {
    const min = ms / 60_000;
    return `${min % 1 === 0 ? min : min.toFixed(1)} min`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** 304 → "304ms"; 1347 → "1.3s"; 125_000 → "2m 5s". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  // Malformed / missing timestamps must not render "NaNd ago" (QA P2-14c).
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 0) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Format a param default for the table (null → "—", booleans → true/false). */
function fmtDefault(v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// --- Sub-components -----------------------------------------------------------

/** One catalog skill card. Kept as a pure display component (no fetches) so
 *  the parent controls the data lifecycle in a single place. */
function SkillCard({ skill }: { skill: SkillDTO }) {
  const gate = GATE_META[skill.gate];
  return (
    <Card className="flex flex-col gap-3 p-4">
      {/* id + name + gate badge */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold leading-tight">
              {skill.name}
            </span>
            <code className="font-mono text-[11px] text-muted-foreground">
              {skill.id}
            </code>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {skill.description}
          </p>
        </div>
        <Badge variant={gate.variant} className="shrink-0 text-[10px]">
          {gate.label}
        </Badge>
      </div>

      {/* timeout + usage stats — one muted meta line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Timer className="size-3" aria-hidden />
          Timeout {fmtTimeout(skill.timeoutMs)}
        </span>
        {skill.stats && skill.stats.invocations > 0 && (
          <span aria-hidden>·</span>
        )}
        {skill.stats && skill.stats.invocations > 0 && (
          <span>
            {skill.stats.invocations} invocation
            {skill.stats.invocations === 1 ? "" : "s"} ·{" "}
            {Math.round(
              (skill.stats.completed / skill.stats.invocations) * 100,
            )}
            % success · avg {fmtDuration(skill.stats.avgMs)}
          </span>
        )}
      </div>

      {/* Params table — compact + muted, only when the skill takes params. */}
      {skill.params.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <caption className="sr-only">
              Parameters for {skill.name}
            </caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Param
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Type
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Default
                </th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {skill.params.map((p) => (
                <tr key={p.name} className="border-t border-border/60">
                  <td className="py-1 pr-3">
                    <span className="font-mono">{p.name}</span>
                    {p.required && (
                      <span
                        className="ml-1 font-semibold text-rose-600 dark:text-rose-400"
                        title="Required"
                        aria-label="required"
                      >
                        *
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3">{p.type}</td>
                  <td className="py-1 pr-3 font-mono">
                    {fmtDefault(p.default)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The exact fence line the system prompt teaches the LLM — copy this
          and the invocation will validate. Shown with the fence prefix so it
          reads as the protocol it is. */}
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span className="select-none opacity-70">```skill{"\n"}</span>
        {skill.exampleLine}
        <span className="select-none opacity-70">{"\n```"}</span>
      </pre>
    </Card>
  );
}

/** One audit-feed row: status pill, skill, agent, caller, duration, time,
 *  and a 2-line-clamped result/error excerpt. */
function InvocationRow({ inv }: { inv: SkillInvocationDTO }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            INVOCATION_STATUS_PILL[inv.status],
          )}
        >
          {inv.status}
        </span>
        <span className="truncate font-mono text-xs">{inv.skillId}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {fmtDuration(inv.durationMs)} · {timeAgo(inv.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="truncate">{inv.agentTitle ?? "—"}</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase">
          {inv.caller}
        </Badge>
      </div>
      {/* Result excerpt — 2-line clamp; error wins when present. */}
      {(inv.error || inv.resultSummary) && (
        <p
          className={cn(
            "mt-1.5 line-clamp-2 text-[11px] leading-relaxed",
            inv.error
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground",
          )}
          title={inv.error ?? inv.resultSummary ?? undefined}
        >
          {inv.error ?? inv.resultSummary}
        </p>
      )}
    </div>
  );
}

// --- Panel --------------------------------------------------------------------

export function SkillsPanel() {
  const [skills, setSkills] = React.useState<SkillDTO[] | null>(null);
  const [invocations, setInvocations] = React.useState<
    SkillInvocationDTO[] | null
  >(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // Catalog load failures are honest errors (retry offered); the audit feed
  // failing alone degrades to its own inline message without nuking the
  // catalog, so the two states are tracked separately.
  const [error, setError] = React.useState<string | null>(null);
  const [feedError, setFeedError] = React.useState<string | null>(null);

  /** Fetch both endpoints. `initial` gates the skeleton vs. refresh spinner. */
  const load = React.useCallback(async (initial: boolean) => {
    if (initial) {
      setLoading(true);
      setError(null);
    } else {
      setRefreshing(true);
    }
    // Catalog and feed fail independently — Promise.allSettled so a dead
    // audit table never hides the (registry-driven) catalog.
    const [catalogRes, feedRes] = await Promise.allSettled([
      fetch("/api/skills"),
      fetch("/api/skills/invocations?limit=50"),
    ]);
    if (catalogRes.status === "fulfilled" && catalogRes.value.ok) {
      const data = await catalogRes.value.json().catch(() => null);
      if (data && Array.isArray(data.skills)) {
        setSkills(data.skills as SkillDTO[]);
        setError(null);
      } else {
        setError("The skills catalog returned an unexpected payload.");
      }
    } else if (catalogRes.status === "fulfilled") {
      setError(`Couldn't load the catalog (HTTP ${catalogRes.value.status}).`);
    } else {
      setError("Couldn't reach the server for the skills catalog.");
    }
    if (feedRes.status === "fulfilled" && feedRes.value.ok) {
      const rows = await feedRes.value.json().catch(() => null);
      if (Array.isArray(rows)) {
        setInvocations(rows as SkillInvocationDTO[]);
        setFeedError(null);
      } else {
        setFeedError("The audit feed returned an unexpected payload.");
      }
    } else {
      setFeedError("The invocation audit feed couldn't be loaded.");
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  React.useEffect(() => {
    void load(true);
  }, [load]);

  // Header stats strip — derived from the per-skill stats (audit-backed).
  const totalInvocations =
    skills?.reduce((acc, s) => acc + (s.stats?.invocations ?? 0), 0) ?? 0;
  const totalCompleted =
    skills?.reduce((acc, s) => acc + (s.stats?.completed ?? 0), 0) ?? 0;
  const successRate =
    totalInvocations > 0
      ? `${Math.round((totalCompleted / totalInvocations) * 100)}%`
      : "—";

  if (loading) {
    return (
      <div className="space-y-6 p-4 md:p-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <PanelSkeleton count={4} />
      </div>
    );
  }

  if (error && !skills) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={Puzzle}
          title="Couldn't load the skills catalog"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load(true)}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const byCategory = new Map<SkillDTO["category"], SkillDTO[]>();
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, []);
  for (const s of skills ?? []) {
    byCategory.get(s.category)?.push(s);
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header: title + protocol description + stats strip + refresh */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Standardized capability protocol for the agent layer — every agent
              operation is validated, gated, time-boxed, and audited.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(false)}
            disabled={refreshing}
            className="shrink-0"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
        </div>
        <dl className="grid grid-cols-3 gap-2 sm:max-w-md">
          <div className="rounded-lg border bg-card px-3 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Skills
            </dt>
            <dd className="text-lg font-semibold leading-tight">
              {skills?.length ?? 0}
            </dd>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Invocations
            </dt>
            <dd className="text-lg font-semibold leading-tight">
              {totalInvocations}
            </dd>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Success rate
            </dt>
            <dd className="text-lg font-semibold leading-tight">
              {successRate}
            </dd>
          </div>
        </dl>
        {error && (
          <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
        )}
      </header>

      {/* Catalog — grouped by category, stacked on mobile, 2-up from sm. */}
      <div className="space-y-6">
        {CATEGORY_ORDER.map((cat) => {
          const items = byCategory.get(cat) ?? [];
          if (items.length === 0) return null;
          const meta = CATEGORY_META[cat];
          const CatIcon = meta.icon;
          return (
            <section key={cat} aria-label={`${meta.label} skills`}>
              <header className="mb-2.5 flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <CatIcon className="size-3.5" />
                </span>
                <h3 className="text-sm font-semibold">
                  {meta.label}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {items.length}
                  </span>
                </h3>
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  {meta.hint}
                </span>
              </header>
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((s) => (
                  <SkillCard key={s.id} skill={s} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Recent invocations — the audit feed. max-h-96 with the thin custom
          scrollbar (global .overflow-y-auto styling handles the look). */}
      <section aria-label="Recent skill invocations">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <History className="size-3.5" />
          </span>
          <h3 className="text-sm font-semibold">Recent invocations</h3>
          {invocations && invocations.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {/* True total from the per-skill audit stats, not the page
                  size (QA P2-14b). */}
              audit trail · {totalInvocations} total · showing latest{" "}
              {invocations.length}
            </span>
          )}
        </header>
        {feedError ? (
          <p className="rounded-lg border bg-card px-3 py-3 text-xs text-muted-foreground">
            {feedError}
          </p>
        ) : !invocations || invocations.length === 0 ? (
          <EmptyState
            icon={History}
            title="No skill invocations yet"
            description="Chat with an agent to see the audit trail fill up."
            className="py-8"
          />
        ) : (
          <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
            {invocations.map((inv) => (
              <InvocationRow key={inv.id} inv={inv} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
