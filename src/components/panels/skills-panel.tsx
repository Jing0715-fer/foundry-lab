"use client";

// Skills observability panel — registry browser + invocation audit log +
// aggregate insights (K lane), deep-linked + governable + extensible (M lane).
//
// Three tabs over the skill layer:
// - Registry: the /api/skills catalog grouped by family (comp/bio/web/canvas/
//   custom) with expandable param docs and a client-side search filter.
//   M3: custom webhook skills registered through POST /api/skills appear
//   here with a per-card Delete (audit history is preserved); the
//   "Register skill" dialog creates new ones.
// - Activity: the /api/skills/invocations audit log — every agent operation
//   in the system (chat tool calls, workflow nodes, PI canvas edits, REST
//   tool runs) flows through runSkill() and lands here. Denied rows carry a
//   "Fix agent access" deep-link (K2) that opens the agent editor — the
//   knowledge switches that caused the denial live there.
//   M1: chat deep-links (pendingSkillTab / pendingSkillInvocation) land on
//   this tab, expanding + scrolling to the target invocation row.
//   M2: source/status filters, cursor-paginated "Load more", and a
//   retention card (dry-run preview + confirm-gated prune).
// - Insights (K1): the /api/skills/insights aggregate view — success rates,
//   P50/P95 latency, denied/invalid/limited trends per skill / agent / lane
//   over a selectable window.
//
// The Tabs are CONTROLLED (M1): the initial tab can be requested from
// another surface through store.pendingSkillTab (mirroring the
// pendingAgentEdit / pendingScreeningId deep-link patterns).

import * as React from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  BookOpen,
  Braces,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  Gauge,
  HardDrive,
  KeyRound,
  ListChecks,
  Loader2,
  Package,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Timer,
  Trash2,
  Upload,
  Webhook,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";
import { useAppStore } from "@/lib/store";
import { useSkillEvents, type SkillInvocationEvent } from "@/hooks/use-skill-events";
// Q3: curated template packs — PURE DATA module (zero server imports; the
// skills barrel must never cross into the client bundle).
import {
  SKILL_TEMPLATE_PACKS,
  packToBundleDoc,
  type SkillTemplatePack,
} from "@/lib/skill-templates";
import { cn } from "@/lib/utils";

// --- Wire types (mirror the /api/skills + /api/skills/invocations +
//     /api/skills/insights + /api/skills/retention DTOs) ----------------------
// Defined locally so no server module (src/lib/skills/* pulls Prisma) ever
// crosses into the client bundle; the server owns the source of truth.

type SkillFamily = "comp" | "bio" | "web" | "canvas" | "custom";
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
  /** M3: present only on custom.* entries — the registered webhook target. */
  endpoint?: string;
  /** N2: custom.* management projection — registered headers (edit dialog
   *  prefill) + soft-enable state (false = listed but not invocable). */
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Only present when the catalog was fetched with ?agentId= — resolved
   *  against that agent's knowledge flags (same rule runSkill enforces). */
  eligible?: boolean;
  /** P3a: agent-id whitelist (present on customs with a non-empty list —
   *  requires is ANDed on top; empty = every agent). */
  agents?: string[];
  /** R3: pack identity (present on customs imported from a named pack —
   *  powers the "from pack X" badge; manual/single imports carry none). */
  packName?: string;
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

interface InvocationsResponse {
  invocations: SkillInvocationDTO[];
  count: number;
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}

type StatusCounts = {
  ok: number;
  error: number;
  denied: number;
  invalid: number;
  skipped: number;
  limited: number;
  queued: number;
  cancelled: number;
};

interface SkillInsight {
  skillId: string;
  label: string | null;
  family: string | null;
  count: number;
  byStatus: StatusCounts;
  executed: number;
  okRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  lastUsedAt: string | null;
}

interface AgentInsight {
  agentId: string;
  agentTitle: string;
  count: number;
  denied: number;
  limited: number;
  lastUsedAt: string | null;
}

interface SourceInsight {
  source: string;
  count: number;
  byStatus: StatusCounts;
}

interface InsightsResponse {
  window: string;
  windowMs: number | null;
  truncated: boolean;
  generatedAt: string;
  totals: {
    invocations: number;
    byStatus: StatusCounts;
    executed: number;
    okRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
  };
  skills: SkillInsight[];
  agents: AgentInsight[];
  sources: SourceInsight[];
}

interface RetentionDecision {
  maxAgeDays: number;
  rowCap: number;
  cutoffAt: string;
  totalRows: number;
  agedOut: number;
  overCap: number;
  deletable: number;
  applied: number;
}

interface RetentionStats {
  policy: { maxAgeDays: number; rowCap: number };
  dryRun: RetentionDecision;
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

/** 0.873 → "87.3%"; null → "—" (no executed calls in window). */
function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(rate >= 0.995 ? 0 : 1)}%`;
}

// --- Registry metadata -------------------------------------------------------

const FAMILY_ORDER: SkillFamily[] = ["comp", "bio", "web", "canvas", "custom"];

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
  // M3: runtime-registered webhook skills.
  custom: {
    label: "Custom webhook skills",
    pill: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
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

/** O1: dialog copy for the two declarable requirements — what the checkbox
 *  actually does (gating is ENFORCED by runSkill and the prompt manifest
 *  filters ineligible entries, so the hint must say both). */
const REQUIREMENT_HINTS: Record<SkillRequirement, string> = {
  bioToolsEnabled:
    "Agents with bio tools enabled in their knowledge config may invoke; others are refused at execution time.",
  webSearchEnabled:
    "Agents with web search enabled in their knowledge config may invoke; others are refused at execution time.",
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
  // K lane additions.
  limited: {
    label: "limited",
    pill: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  queued: {
    label: "queued",
    pill: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  },
  cancelled: {
    label: "cancelled",
    pill: "border border-dashed border-zinc-400/70 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  },
};

/** Statuses worth showing as a segment in the insights distribution bar. */
const STATUS_BAR_ORDER: (keyof StatusCounts)[] = [
  "ok",
  "error",
  "denied",
  "invalid",
  "limited",
  "skipped",
  "queued",
  "cancelled",
];

const STATUS_BAR_COLORS: Record<keyof StatusCounts, string> = {
  ok: "bg-emerald-500/70",
  error: "bg-rose-500/70",
  denied: "bg-amber-500/70",
  invalid: "bg-slate-400/70",
  limited: "bg-orange-500/70",
  skipped: "bg-slate-300 dark:bg-slate-600",
  queued: "bg-teal-500/70",
  cancelled: "bg-zinc-400/70",
};

const INV_SOURCES = [
  "chat",
  "chat-stream",
  "workflow",
  "canvas",
  "api",
  "task",
  "meeting",
  "research",
] as const;

const INV_STATUSES = STATUS_BAR_ORDER.map((s) => String(s));

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

type TabKey = "registry" | "activity" | "insights" | "templates";

export function SkillsPanel() {
  // M1: controlled tabs. The initial tab may be requested by another
  // surface via store.pendingSkillTab (chat QUEUED cards, denied cards…);
  // the request is consumed on mount OR while mounted (subscription).
  const pendingSkillTab = useAppStore((s) => s.pendingSkillTab);
  const setPendingSkillTab = useAppStore((s) => s.setPendingSkillTab);
  const [tab, setTab] = React.useState<TabKey>(
    () => useAppStore.getState().pendingSkillTab ?? "registry",
  );

  React.useEffect(() => {
    if (pendingSkillTab) {
      setTab(pendingSkillTab);
      setPendingSkillTab(null);
    }
  }, [pendingSkillTab, setPendingSkillTab]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
        <p className="text-sm text-muted-foreground">
          Every agent operation runs through one skill registry — browse the
          catalog, inspect the invocation audit trail, and read the aggregate
          health of the layer.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="registry" className="gap-1.5">
            <BookOpen className="size-3.5" />
            Registry
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <Activity className="size-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5">
            <BarChart3 className="size-3.5" />
            Insights
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5">
            <Package className="size-3.5" />
            Templates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="registry" className="space-y-4">
          <RegistryTab />
        </TabsContent>
        <TabsContent value="activity" className="space-y-4">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="insights" className="space-y-4">
          <InsightsTab />
        </TabsContent>
        <TabsContent value="templates" className="space-y-4">
          <TemplatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ==========================================================================
// Tab 1 — Registry (skill catalog browser + M3 custom registration)
// ==========================================================================

function RegistryTab() {
  const [skills, setSkills] = React.useState<SkillCatalogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  // M3: registration dialog + shared delete confirm.
  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<SkillCatalogEntry | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  // N2: edit dialog target + soft-enable busy flag.
  const [editingSkill, setEditingSkill] = React.useState<SkillCatalogEntry | null>(null);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  // O3: import busy flag + the rename-on-collision confirm state.
  const [importing, setImporting] = React.useState(false);
  const [importConflict, setImportConflict] = React.useState<{
    doc: Record<string, unknown>;
    suggestion: string | null;
  } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // P1: bundle selection mode + the multi-skill import REPORT dialog.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [importReport, setImportReport] = React.useState<{
    requested: number;
    imported: { id: string; label: string }[];
    skipped: { skillId: string; suggestion: string | null }[];
    failed: { skillId: string | null; index: number; error: string }[];
    /** The original bundle doc — the retry action re-submits it with
     *  renames, no second file read needed. */
    retryDoc?: Record<string, unknown>;
    /** Q3: the pack identity echoed by the import lane (bundle-v2
     *  metadata) — titles the report for template-pack imports. */
    bundleName?: string;
  } | null>(null);
  // P3a: whitelist deep-link target (a chat card denied by a skill's
  // whitelist points here — consumed after the catalog loads).
  const pendingSkillEdit = useAppStore((s) => s.pendingSkillEdit);
  const setPendingSkillEdit = useAppStore((s) => s.setPendingSkillEdit);
  // Q3: the pack-metadata dialog for "Export selected" — name/description/
  //  tags turn the selection into a shareable version-2 skill pack.
  const [packDialogFor, setPackDialogFor] = React.useState<{
    ids: string[];
  } | null>(null);
  const toast = useAppStore((s) => s.toast);

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

  // P3a: consume the whitelist deep-link once the catalog has loaded —
  // open the edit dialog for the named skill, or be honest when the skill
  // is not (or no longer) registered.
  React.useEffect(() => {
    if (!pendingSkillEdit || (loading && skills.length === 0)) return;
    const pending = pendingSkillEdit;
    setPendingSkillEdit(null);
    const target = skills.find((s) => s.id === pending.skillId);
    if (target) {
      setEditingSkill(target);
    } else {
      toast({
        title: "Skill not found",
        description: `No custom skill registered as "${pending.skillId}" — it may have been deleted or renamed.`,
        variant: "destructive",
      });
    }
  }, [pendingSkillEdit, loading, skills, setPendingSkillEdit, toast]);

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

  const deleteCustom = async (skill: SkillCatalogEntry) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        useAppStore.getState().toast({
          title: "Delete failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      useAppStore.getState().toast({
        title: "Custom skill deleted",
        description: `"${skill.id}" was unregistered. Audit history for its past invocations is preserved in the Activity tab.`,
        variant: "default",
      });
    } catch (e) {
      useAppStore.getState().toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  // N2: soft-enable PATCH — disabled skills stay listed (flagged) so they
  // can be re-enabled; enabled ones leave the registry (not invocable, not
  // in agent prompts) until toggled back.
  const toggleEnabled = async (skill: SkillCatalogEntry) => {
    if (togglingId) return;
    const next = !(skill.enabled ?? true);
    setTogglingId(skill.id);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        useAppStore.getState().toast({
          title: next ? "Enable failed" : "Disable failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id
            ? // O1: eligibility for customs now follows their declared
              // requires — but this tab fetches WITHOUT ?agentId (no
              // knowledge context to resolve against), so the pill resets
              // to undefined (absent) on enable and stays locked on
              // disabled (never invocable, requirement or not).
              { ...s, enabled: next, eligible: next ? undefined : false }
            : s,
        ),
      );
      useAppStore.getState().toast({
        title: next ? "Custom skill enabled" : "Custom skill disabled",
        description: next
          ? `"${skill.id}" is live again — agents can invoke it on their next turn.`
          : `"${skill.id}" is now inert — it stays listed here (flagged) but agents can no longer invoke or see it.`,
        variant: "default",
      });
    } catch (e) {
      useAppStore.getState().toast({
        title: "Toggle failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
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

  // O3: export — fetch the portable document and hand it to the browser's
  // download flow (the response already carries Content-Disposition; the
  // blob dance is what makes a click save it).
  const exportSkill = async (skill: SkillCatalogEntry) => {
    try {
      const res = await fetch(
        `/api/skills/export?skillId=${encodeURIComponent(skill.id)}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        useAppStore.getState().toast({
          title: "Export failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const filename =
        skill.id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) + ".skill.json";
      const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      useAppStore.getState().toast({
        title: "Skill exported",
        description: `${filename} — import it on another Foundry Lab instance through the Import button (a 409 collision offers a deterministic rename).`,
        variant: "default",
      });
    } catch (e) {
      useAppStore.getState().toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  // P1: bundle export — the same download flow for a LISTED set or all
  //  customs. The report toast names the count + the filename so the
  //  user can tell a 1-skill bundle from an everything bundle.
  //  Q3: optional pack METADATA turns the selected-set export into a
  //  version-2 "skill pack" document (name/description/tags ride along
  //  and the marketplace / import report can render them).
  const exportBundle = async (
    ids: string[] | "all",
    meta?: { name?: string; description?: string; tags?: string },
  ) => {
    try {
      const sp = new URLSearchParams(
        ids === "all" ? { all: "1" } : { ids: ids.join(",") },
      );
      if (meta?.name?.trim()) sp.set("name", meta.name.trim());
      if (meta?.description?.trim()) sp.set("description", meta.description.trim());
      if (meta?.tags?.trim()) sp.set("tags", meta.tags.trim());
      const url = `/api/skills/export?${sp.toString()}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: "Bundle export failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const count = Array.isArray(data?.skills) ? data.skills.length : 0;
      const isPack = data?.version === 2;
      // Mirror the server's filename logic so the toast names the exact file.
      const filename = isPack
        ? `foundry-lab-${(
            data?.metadata?.name ?? "skill-pack"
          )
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40)}.json`
        : `foundry-lab-skills-${count}-bundle.json`;
      const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], {
        type: "application/json",
      });
      const url2 = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url2);
      toast({
        title: isPack ? "Skill pack exported" : "Skill bundle exported",
        description: isPack
          ? `${filename} — ${count} skill${count === 1 ? "" : "s"} with pack metadata (version 2). The Templates tab on another instance renders this card; imports keep working on v1-only instances.`
          : `${filename} — ${count} skill${count === 1 ? "" : "s"}. Import the file on another Foundry Lab instance (collisions are skipped with a rename offer, not a rollback).`,
        variant: "default",
      });
    } catch (e) {
      toast({
        title: "Bundle export failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  // P1: selection-mode helpers — checkboxes live on custom cards only.
  const customs = React.useMemo(
    () => skills.filter((s) => s.family === "custom"),
    [skills],
  );
  const selectedArray = React.useMemo(
    () => [...selectedIds].filter((id) => customs.some((c) => c.id === id)),
    [selectedIds, customs],
  );
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  // O3/P1: import — read the picked file, POST it, route the outcome.
  //  SINGLE docs: a 409 with a suggestion opens the rename confirm; a
  //  success refreshes the catalog. BUNDLE docs: the lane answers with a
  //  per-skill REPORT (200) — imported/skipped/failed — which opens the
  //  report dialog; its retry action re-submits with a renames map built
  //  from the suggestions. The original doc rides along on the report so
  //  the retry needs no second file read.
  const submitImport = async (
    doc: Record<string, unknown>,
    renameId?: string,
  ) => {
    setImporting(true);
    try {
      const isBundle = doc.kind === "foundry-lab-skill-bundle";
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          renameId ? { ...doc, id: renameId } : doc,
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (isBundle) {
        if (!res.ok) {
          toast({
            title: "Bundle import failed",
            description: data?.error ?? `HTTP ${res.status}`,
            variant: "destructive",
          });
          return;
        }
        setImportReport({
          requested: typeof data?.requested === "number" ? data.requested : 0,
          imported: Array.isArray(data?.imported) ? data.imported : [],
          skipped: Array.isArray(data?.skipped) ? data.skipped : [],
          failed: Array.isArray(data?.failed) ? data.failed : [],
          retryDoc: doc,
          ...(typeof data?.bundle?.name === "string"
            ? { bundleName: data.bundle.name }
            : {}),
        });
        if (Array.isArray(data?.imported) && data.imported.length > 0) {
          await loadCatalog();
        }
        return;
      }
      if (res.status === 409 && (data?.suggestion || data?.error)) {
        setImportConflict({
          doc,
          suggestion: typeof data.suggestion === "string" ? data.suggestion : null,
        });
        return;
      }
      if (!res.ok) {
        toast({
          title: "Import failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setImportConflict(null);
      toast({
        title: "Skill imported",
        description: `"${data?.skill?.id ?? "custom skill"}" is live and enabled — it flows through the same validation, gating, queue, and audit pipeline as every registration.`,
        variant: "default",
      });
      await loadCatalog();
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  };

  // P1: the report dialog's retry action — re-submit the SAME bundle with
  //  a renames map covering every skipped skill that got a suggestion.
  const retrySkippedImport = async () => {
    if (!importReport?.retryDoc) return;
    const renames: Record<string, string> = {};
    for (const s of importReport.skipped) {
      if (s.suggestion) renames[s.skillId] = s.suggestion;
    }
    await submitImport({ ...importReport.retryDoc, renames });
  };

  const handleFilePicked = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the SAME file again re-fires change.
    e.target.value = "";
    if (!file) return;
    if (file.size > 512_000) {
      useAppStore.getState().toast({
        title: "Import failed",
        description: "File too large — a skill document is a few KB and a 100-skill bundle stays well under 512KB.",
        variant: "destructive",
      });
      return;
    }
    try {
      const text = await file.text();
      const doc: unknown = JSON.parse(text);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error("the file is not a skill document (expected a JSON object)");
      }
      await submitImport(doc as Record<string, unknown>);
    } catch (err) {
      useAppStore.getState().toast({
        title: "Import failed",
        description:
          err instanceof Error
            ? `Could not read the file: ${err.message}`
            : String(err),
        variant: "destructive",
      });
    }
  };

  const grouped = React.useMemo(
    () =>
      FAMILY_ORDER.map((family) => ({
        family,
        items: filtered.filter((s) => s.family === family),
      })).filter((g) => g.items.length > 0),
    [filtered],
  );

  if (loading && skills.length === 0) {
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Client-side search over id / label / description. */}
        <div className="relative max-w-sm flex-1">
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
        {/* M3: register a custom webhook skill. O3: import a portable skill
            document (export → file → import, 409 → rename offer). P1: bundle
            export — select a listed set or everything at once. */}
        <div className="flex flex-wrap items-center gap-2">
          {customs.length > 0 && !selectMode && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => exportBundle("all")}
              className="h-11 gap-1.5 sm:h-8"
            >
              <Download className="size-4" />
              Export all
            </Button>
          )}
          {customs.length > 0 && !selectMode && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSelectMode(true)}
              className="h-11 gap-1.5 sm:h-8"
            >
              <ListChecks className="size-4" />
              Select
            </Button>
          )}
          {selectMode && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPackDialogFor({ ids: selectedArray })}
                disabled={selectedArray.length === 0}
                className="h-11 gap-1.5 sm:h-8"
              >
                <Download className="size-4" />
                Export selected ({selectedArray.length})
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds(new Set(customs.map((c) => c.id)))}
                disabled={customs.length === 0}
                className="h-11 gap-1.5 sm:h-8"
              >
                Select all
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={exitSelectMode}
                className="h-11 gap-1.5 sm:h-8"
              >
                Cancel
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="h-11 gap-1.5 sm:h-8"
          >
            {importing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            Import
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setRegisterOpen(true)}
            className="h-11 gap-1.5 sm:h-8"
          >
            <Plus className="size-4" />
            Register skill
          </Button>
        </div>
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
                    toggling={togglingId === s.id}
                    {...(s.family === "custom"
                      ? {
                          onDelete: () => setConfirmDelete(s),
                          onEdit: () => setEditingSkill(s),
                          onToggleEnabled: () => toggleEnabled(s),
                          onExport: () => exportSkill(s),
                          ...(selectMode
                            ? {
                                selectable: true,
                                selected: selectedIds.has(s.id),
                                onToggleSelected: () => toggleSelected(s.id),
                              }
                            : {}),
                        }
                      : {})}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      {/* M3: registration dialog (POST /api/skills). N2: the SAME dialog
          component renders the EDIT form (PATCH) when editingSkill is set. */}
      <CustomSkillDialog
        mode="register"
        open={registerOpen}
        onOpenChange={(open) => {
          setRegisterOpen(open);
          if (!open) loadCatalog();
        }}
      />
      <CustomSkillDialog
        mode="edit"
        skill={editingSkill ?? undefined}
        open={editingSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingSkill(null);
            loadCatalog();
          }
        }}
      />

      {/* O3: hidden file picker — the Import button clicks it. Accepting
          .json + application/json keeps the picker honest; the reader
          validates the envelope (kind/version) on the server anyway. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFilePicked}
        className="hidden"
        aria-label="Import skill document"
      />

      {/* Q3: pack metadata dialog — "Export selected" lands here first;
          name/description/tags turn the selection into a shareable
          version-2 skill pack (the Templates tab's format). */}
      <PackMetaDialog
        open={packDialogFor !== null}
        count={packDialogFor?.ids.length ?? 0}
        onOpenChange={(open) => {
          if (!open) setPackDialogFor(null);
        }}
        onExport={(meta) => {
          if (packDialogFor) {
            void exportBundle(packDialogFor.ids, meta);
          }
          setPackDialogFor(null);
        }}
      />

      {/* O3: rename-on-collision confirm — the import lane's deterministic
          suggestion offered as a one-click re-submit. */}
      <AlertDialog
        open={importConflict !== null}
        onOpenChange={(open) => {
          if (!open) setImportConflict(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skill id already exists</AlertDialogTitle>
            <AlertDialogDescription>
              {importConflict &&
                (importConflict.suggestion
                  ? `"${(importConflict.doc.skill as Record<string, unknown> | undefined)?.skillId ?? "the skill"}" is already registered on this instance. Import it as "${importConflict.suggestion}" instead? The definition (label, endpoint, params, headers, latency, requirements) is preserved — only the id changes.`
                  : `"${(importConflict.doc.skill as Record<string, unknown> | undefined)?.skillId ?? "the skill"}" is already registered on this instance, and no free rename id could be suggested. Delete or rename one of them first, then import again.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Skip</AlertDialogCancel>
            {importConflict?.suggestion && (
              <AlertDialogAction
                disabled={importing}
                onClick={(e) => {
                  // Keep the dialog open while the re-submit runs (Radix
                  // auto-close would lose the pending state).
                  e.preventDefault();
                  if (importConflict) {
                    submitImport(importConflict.doc, importConflict.suggestion ?? undefined);
                  }
                }}
              >
                {importing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Import as {importConflict?.suggestion}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* P1: bundle import REPORT — per-skill outcomes (imported /
          skipped / failed). Skipped entries with a suggestion offer a
          one-click retry under the suggested ids (renames map). */}
      <AlertDialog
        open={importReport !== null}
        onOpenChange={(open) => {
          if (!open) setImportReport(null);
        }}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {importReport?.bundleName
                ? `Pack import report — ${importReport.bundleName}`
                : "Bundle import report"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {importReport &&
                `${importReport.imported.length} of ${importReport.requested} skill${
                  importReport.requested === 1 ? "" : "s"
                } imported. Each skill in a bundle is independent — collisions are skipped (not a rollback) and validation failures are reported per skill.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {importReport && (
            <div className="space-y-3 text-xs">
              {importReport.imported.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                    Imported ({importReport.imported.length})
                  </p>
                  <ul className="space-y-1">
                    {importReport.imported.map((s) => (
                      <li key={s.id} className="font-mono text-[11px]">
                        {s.id}
                        <span className="ml-2 font-sans text-muted-foreground">
                          {s.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {importReport.skipped.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-amber-700 dark:text-amber-400">
                    Skipped — already registered ({importReport.skipped.length})
                  </p>
                  <ul className="space-y-1">
                    {importReport.skipped.map((s) => (
                      <li key={s.skillId} className="font-mono text-[11px]">
                        {s.skillId}
                        {s.suggestion ? (
                          <span className="ml-2 font-sans text-muted-foreground">
                            rename offer: {s.suggestion}
                          </span>
                        ) : (
                          <span className="ml-2 font-sans text-muted-foreground">
                            no free rename id — delete or rename one first
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {importReport.failed.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-rose-700 dark:text-rose-400">
                    Failed validation ({importReport.failed.length})
                  </p>
                  <ul className="space-y-1">
                    {importReport.failed.map((f, i) => (
                      <li
                        key={`${f.skillId ?? "entry"}-${f.index}-${i}`}
                        className="text-[11px]"
                      >
                        <span className="font-mono">
                          {f.skillId ?? `entry #${f.index}`}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {f.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Close</AlertDialogCancel>
            {importReport &&
              importReport.skipped.some((s) => s.suggestion) && (
                <AlertDialogAction
                  disabled={importing}
                  onClick={(e) => {
                    // Keep the dialog open while the retry runs (Radix
                    // auto-close would lose the pending state).
                    e.preventDefault();
                    retrySkippedImport();
                  }}
                >
                  {importing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  Import skipped as suggested
                </AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* M3: shared delete confirm (one instance for all custom cards). */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom skill?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete &&
                `"${confirmDelete.id}" (${confirmDelete.label}) will be unregistered — agents lose the capability immediately. Past invocation rows stay in the Activity tab for the audit history.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                // Keep the dialog open while the DELETE runs; the close is
                // handled by deleteCustom's finally (preventDefault stops
                // Radix's auto-close).
                e.preventDefault();
                if (confirmDelete) deleteCustom(confirmDelete);
              }}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete skill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SkillCard({
  skill,
  open,
  onToggle,
  onDelete,
  onEdit,
  onToggleEnabled,
  onExport,
  toggling,
  selectable,
  selected,
  onToggleSelected,
}: {
  skill: SkillCatalogEntry;
  open: boolean;
  onToggle: () => void;
  /** M3: present only for family "custom" — deletable runtime skills. */
  onDelete?: () => void;
  /** N2: open the edit dialog (PATCH surface). */
  onEdit?: () => void;
  /** N2: soft-enable toggle (PATCH { enabled }). */
  onToggleEnabled?: () => void;
  /** O3: export the portable skill document (GET /api/skills/export). */
  onExport?: () => void;
  /** N2: true while this card's enable/disable PATCH is in flight. */
  toggling?: boolean;
  /** P1: selection mode — render a leading checkbox for bundle export. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: () => void;
}) {
  const latency = LATENCY_META[skill.latency] ?? LATENCY_META["slow"];
  const disabled = skill.family === "custom" && skill.enabled === false;
  // P3a: resolve whitelist ids to titles for the expanded view (unknown
  // ids — imported whitelists — are shown as unknown, the honest floor).
  const agentsList = useAppStore((s) => s.agents);
  const whitelist = skill.agents ?? [];
  const titleFor = (id: string) =>
    agentsList.find((a) => a.id === id)?.title ?? null;

  return (
    <Card
      className={cn(
        "overflow-hidden transition-shadow hover:shadow-md",
        disabled && "opacity-70",
      )}
    >
      <CardContent className="p-0">
        {/* The toggle row and the action buttons are SIBLINGS (never nest
            interactive elements — keyboard + a11y). P1: in selection mode a
            leading checkbox joins them as another sibling. */}
        <div className="flex items-stretch">
          {selectable && (
            <label
              className="flex w-11 cursor-pointer items-center justify-center border-r"
              aria-label={`Select ${skill.id} for bundle export`}
            >
              <input
                type="checkbox"
                checked={selected === true}
                onChange={() => onToggleSelected?.()}
                className="size-4 accent-primary"
                aria-label={`Select ${skill.id} for bundle export`}
              />
            </label>
          )}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-accent/50"
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
                {skill.family === "custom" && (
                  <Pill
                    label="webhook"
                    className="bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
                  />
                )}
                {disabled && (
                  <Pill
                    label="disabled"
                    className="bg-rose-500/10 text-rose-700 dark:text-rose-400"
                  />
                )}
                {skill.requires.map((r) => (
                  <Pill
                    key={r}
                    label={`requires ${REQUIREMENT_LABELS[r]}`}
                    className="bg-muted text-muted-foreground"
                  />
                ))}
                {whitelist.length > 0 && (
                  <Pill
                    label={`${whitelist.length}-agent whitelist`}
                    className="bg-violet-500/10 text-violet-700 dark:text-violet-400"
                  />
                )}
                {/* R3: pack identity — rows imported from a named pack
                    (template packs / bundle files with pack metadata). */}
                {skill.packName && (
                  <Pill
                    label={`pack: ${skill.packName}`}
                    className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  />
                )}
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
          {(onToggleEnabled || onEdit || onDelete || onExport) && (
            <div
              className="flex divide-x border-l"
              aria-label="Custom skill actions"
            >
              {onToggleEnabled && (
                <button
                  type="button"
                  onClick={onToggleEnabled}
                  disabled={toggling}
                  aria-label={
                    disabled
                      ? `Enable custom skill ${skill.label}`
                      : `Disable custom skill ${skill.label}`
                  }
                  title={
                    disabled
                      ? `Enable ${skill.id} (puts it back in the live registry)`
                      : `Disable ${skill.id} (stays listed, agents can't invoke it)`
                  }
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-amber-400"
                >
                  {toggling ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Power
                      className={cn("size-4", disabled && "text-rose-500")}
                      aria-hidden
                    />
                  )}
                </button>
              )}
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label={`Edit custom skill ${skill.label}`}
                  title={`Edit ${skill.id} (label, endpoint, params, headers, latency)`}
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  <Pencil className="size-4" aria-hidden />
                </button>
              )}
              {onExport && (
                <button
                  type="button"
                  onClick={onExport}
                  aria-label={`Export custom skill ${skill.label}`}
                  title={`Export ${skill.id} as a portable skill document (import it on another instance)`}
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400"
                >
                  <Download className="size-4" aria-hidden />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label={`Delete custom skill ${skill.label}`}
                  title={`Delete ${skill.id} (audit history is preserved)`}
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>

        {open && (
          <div className="space-y-3 border-t px-4 py-3">
            {skill.family === "custom" && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Endpoint:</span>{" "}
                  <span className="break-all font-mono text-[11px]">
                    {skill.endpoint ?? "(unavailable)"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Execution:</span>{" "}
                  {skill.latency === "slow"
                    ? "slow — agent and REST invocations are queued as background tool jobs (stoppable, audited)"
                    : "fast — invoked inline with a 20s webhook timeout"}
                </p>
                {skill.headers && Object.keys(skill.headers).length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Headers:</span>{" "}
                    <span className="break-all font-mono text-[11px]">
                      {Object.entries(skill.headers)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </span>
                  </p>
                )}
                {whitelist.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Whitelist:</span>{" "}
                    {whitelist
                      .map(
                        (id) =>
                          titleFor(id) ?? `unknown (${id.slice(0, 12)}…)`,
                      )
                      .join(", ")}
                    <span className="block text-[11px] leading-snug">
                      Only these agents may invoke — enforced at execution
                      time and hidden from everyone else's skill manifests.
                    </span>
                  </p>
                )}
                {skill.packName && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Origin:</span>{" "}
                    imported from the pack “{skill.packName}” — the Templates
                    tab (or POST /api/skills/pack/uninstall) removes the whole
                    pack in one action.
                  </p>
                )}
              </div>
            )}
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
// Tab 2 — Activity (invocation audit log: filters + pagination + retention)
// ==========================================================================

const PAGE_SIZE = 50;

function ActivityTab() {
  const [invocations, setInvocations] = React.useState<SkillInvocationDTO[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  // M2: filters (source + status) — both optional, "all" is the sentinel.
  const [sourceFilter, setSourceFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  // M1: deep-link highlight state.
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  const pendingSkillInvocation = useAppStore((s) => s.pendingSkillInvocation);
  const setPendingSkillInvocation = useAppStore((s) => s.setPendingSkillInvocation);
  const toast = useAppStore((s) => s.toast);

  // P2a: the PUSH lane — invocation rows land here live. A row already in
  // the list flips IN PLACE (status/summary/error/duration); an unknown
  // row is NEW and prepends when the active filters admit it (the count
  // follows). Rows the filters exclude are ignored — the manual Refresh
  // re-applies everything against the source of truth.
  const eventsConnected = useSkillEvents(
    React.useCallback(
      (event: SkillInvocationEvent) => {
        const known = invocations.some((inv) => inv.id === event.id);
        if (known) {
          setInvocations((prev) => {
            const idx = prev.findIndex((inv) => inv.id === event.id);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = {
              ...next[idx],
              status: event.status,
              resultSummary: event.resultSummary,
              error: event.error,
              durationMs: event.durationMs,
            };
            return next;
          });
          return;
        }
        const matchesSource = sourceFilter === "all" || event.source === sourceFilter;
        const matchesStatus = statusFilter === "all" || event.status === statusFilter;
        if (!matchesSource || !matchesStatus) return;
        setInvocations((prev) => [event, ...prev]);
        setTotal((t) => t + 1);
      },
      // The handler ref updates every render, so these deps are for the
      // linter's benefit — the subscription itself is mount-scoped.
      [invocations, sourceFilter, statusFilter],
    ),
  );

  const filterQuery = React.useMemo(() => {
    const sp = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (sourceFilter !== "all") sp.set("source", sourceFilter);
    if (statusFilter !== "all") sp.set("status", statusFilter);
    return sp;
  }, [sourceFilter, statusFilter]);

  const loadInvocations = React.useCallback(
    async (filters: URLSearchParams) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/skills/invocations?${filters.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as InvocationsResponse;
        setInvocations(Array.isArray(data?.invocations) ? data.invocations : []);
        setTotal(typeof data?.total === "number" ? data.total : 0);
        setNextCursor(data?.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    loadInvocations(filterQuery);
  }, [loadInvocations, filterQuery]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = new URLSearchParams(filterQuery);
      sp.set("cursor", nextCursor);
      const res = await fetch(`/api/skills/invocations?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as InvocationsResponse;
      setInvocations((prev) => [...prev, ...(data.invocations ?? [])]);
      setNextCursor(data?.nextCursor);
      if (typeof data?.total === "number") setTotal(data.total);
    } catch (e) {
      toast({
        title: "Could not load more rows",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoadingMore(false);
    }
  };

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

  // M1: consume the pending invocation deep-link once the first page has
  // loaded — expand + scroll + briefly ring the target row. jobId is the
  // fallback matcher for legacy cards that never persisted invocationId.
  React.useEffect(() => {
    if (!pendingSkillInvocation || loading) return;
    const pending = pendingSkillInvocation;
    const target =
      invocations.find((inv) => inv.id === pending.invocationId) ??
      (pending.jobId
        ? invocations.find((inv) =>
            (inv.resultSummary ?? "").includes(`tool job ${pending.jobId}`),
          )
        : undefined);
    if (target) {
      setExpanded((prev) => new Set(prev).add(target.id));
      setHighlightId(target.id);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-inv-id="${CSS.escape(target.id)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      window.setTimeout(
        () => setHighlightId((cur) => (cur === target.id ? null : cur)),
        4000,
      );
    } else {
      toast({
        title: "Invocation not on the loaded page",
        description:
          "The audit row is older than the rows shown — clear the filters and press Load more, or find it in Insights.",
        variant: "default",
      });
    }
    setPendingSkillInvocation(null);
  }, [pendingSkillInvocation, loading, invocations, setPendingSkillInvocation, toast]);

  return (
    <div className="space-y-3">
      {/* M2: filter row — source + status (Select value is ALWAYS a string;
          "all" is the sentinel, never "" — #34). */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={sourceFilter}
          onValueChange={(v) => setSourceFilter(v || "all")}
        >
          <SelectTrigger
            className="h-11 w-36 text-xs sm:h-8"
            aria-label="Filter by source lane"
          >
            <SelectValue placeholder="source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              all sources
            </SelectItem>
            {INV_SOURCES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v || "all")}
        >
          <SelectTrigger
            className="h-11 w-32 text-xs sm:h-8"
            aria-label="Filter by status"
          >
            <SelectValue placeholder="status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              all statuses
            </SelectItem>
            {INV_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          {/* P2a: live indicator — the push channel is connected and new
              rows / flips land here without a Refresh. Absent when offline
              (manual Refresh + the drawer's poll still cover it). */}
          {eventsConnected && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
              title="Live updates connected — new invocations appear here as they land"
              aria-label="Live updates connected"
            >
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
              </span>
              live
            </span>
          )}
          <p className="text-sm font-medium text-muted-foreground">
            {invocations.length === total
              ? `${total} invocation${total === 1 ? "" : "s"}`
              : `${invocations.length} of ${total} invocations`}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadInvocations(filterQuery)}
            disabled={loading}
            className="h-11 sm:h-8"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <PanelSkeleton count={4} />
      ) : error ? (
        <EmptyState
          icon={AlertCircle}
          title="Audit log unavailable"
          description={`Failed to load skill invocations. ${error}`}
          action={
            <Button variant="outline" onClick={() => loadInvocations(filterQuery)}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
        />
      ) : invocations.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No skill invocations yet"
          description={
            sourceFilter !== "all" || statusFilter !== "all"
              ? "No invocations match the current filters — try widening them."
              : "Every agent operation — chat tool calls, workflow nodes, PI canvas edits, and REST tool runs — is audited here. Run an agent chat with a bio query (e.g. search PubMed for nanobodies) to see entries appear."
          }
          action={
            <Button
              variant="outline"
              onClick={() => loadInvocations(filterQuery)}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          {/* Long-list pattern: capped height + internal scroll (thin custom
              scrollbar styling comes from the global .overflow-y-auto rules). */}
          <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-y-auto pr-1">
            {invocations.map((inv) => (
              <InvocationCard
                key={inv.id}
                inv={inv}
                open={expanded.has(inv.id)}
                onToggle={() => toggleInvocation(inv.id)}
                highlighted={highlightId === inv.id}
              />
            ))}
          </div>

          {/* M2: cursor-paginated Load more (never offset — new rows landing
              mid-scroll would otherwise shift the window). */}
          {nextCursor && (
            <div className="flex justify-center py-1">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
                className="h-11 min-w-44 sm:h-9 sm:min-w-40"
              >
                {loadingMore ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
                Load more ({total - invocations.length} older)
              </Button>
            </div>
          )}
        </>
      )}

      {/* M2: retention governance card. */}
      <RetentionCard
        onPruned={() => loadInvocations(filterQuery)}
        totalRows={total}
      />
    </div>
  );
}

function InvocationCard({
  inv,
  open,
  onToggle,
  highlighted,
}: {
  inv: SkillInvocationDTO;
  open: boolean;
  onToggle: () => void;
  /** M1 deep-link target — brief teal ring + smooth scroll. */
  highlighted: boolean;
}) {
  const status = INV_STATUS_META[inv.status] ?? INV_STATUS_META["invalid"];
  const summary = inv.error ?? inv.resultSummary;
  const paramKeys = Object.keys(inv.params);
  // K2: a denied row means an agent ASKED for a capability its knowledge
  // config refuses — the switches that fix it live in the agent editor.
  const showFixAccess = inv.status === "denied";

  return (
    <Card
      data-inv-id={inv.id}
      className={cn(
        "overflow-hidden",
        highlighted &&
          "ring-2 ring-teal-500/60 ring-offset-1 ring-offset-background",
      )}
    >
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

        {showFixAccess && (
          <FixAgentAccessButton
            agentId={inv.agentId}
            agentTitle={inv.agentTitle}
          />
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

/** K2 — deep-link into the Agents panel editor (the knowledge switches
 *  that caused the denial live there). Store-level pending state, the same
 *  provenance pattern the Screening deep-link uses. */
function FixAgentAccessButton({
  agentId,
  agentTitle,
}: {
  agentId: string | null;
  agentTitle: string | null;
}) {
  const setPendingAgentEdit = useAppStore((s) => s.setPendingAgentEdit);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const toast = useAppStore((s) => s.toast);

  if (!agentId) {
    // Denied without an agent context (a lane-level refusal) — nothing to
    // deep-link into; show nothing rather than a dead button.
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      onClick={() => {
        setPendingAgentEdit({ id: agentId, title: agentTitle });
        setActivePanel("agents");
        toast({
          title: "Opening agent settings",
          description: agentTitle
            ? `Enable the missing knowledge switch for "${agentTitle}".`
            : "Enable the missing knowledge switch for this agent.",
          variant: "default",
        });
      }}
    >
      <KeyRound className="size-3.5" />
      Fix agent access
    </Button>
  );
}

// ==========================================================================
// Retention (M2/K6) — dry-run preview + confirm-gated prune
// ==========================================================================

function RetentionCard({
  onPruned,
  totalRows,
}: {
  /** Reload the invocation list after a prune (rows vanished). */
  onPruned: () => void;
  /** The list's current filter total — shown until the retention preview
   *  loads (its own totalRows is unfiltered, an honest distinction). */
  totalRows: number;
}) {
  const [stats, setStats] = React.useState<RetentionStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [maxAgeDays, setMaxAgeDays] = React.useState<number>(90);
  const [confirmState, setConfirmState] = React.useState<RetentionDecision | null>(null);
  const [pruning, setPruning] = React.useState(false);
  const toast = useAppStore((s) => s.toast);

  const loadStats = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills/retention");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats((await res.json()) as RetentionStats);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadStats();
  }, [loadStats]);

  const startPrune = async () => {
    // Dry-run FIRST with the exact parameters the confirm will apply — the
    // dialog shows the numbers the delete will produce (no estimate drift).
    try {
      const res = await fetch("/api/skills/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAgeDays, dryRun: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Retention preview failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setConfirmState(data as RetentionDecision);
    } catch (e) {
      toast({
        title: "Retention preview failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const applyPrune = async () => {
    if (!confirmState) return;
    setPruning(true);
    try {
      const res = await fetch("/api/skills/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAgeDays: confirmState.maxAgeDays, dryRun: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Retention run failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const applied = (data as RetentionDecision).applied;
      toast({
        title: applied > 0 ? `Pruned ${applied} audit row${applied === 1 ? "" : "s"}` : "Nothing to prune",
        description:
          applied > 0
            ? `Removed ${confirmState.agedOut} aged-out + ${confirmState.overCap} over-cap terminal rows (queued rows are never pruned).`
            : "No terminal rows are old enough or beyond the cap — the audit log is already within policy.",
        variant: "default",
      });
      await loadStats();
      onPruned();
    } catch (e) {
      toast({
        title: "Retention run failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setPruning(false);
      setConfirmState(null);
    }
  };

  const preview = stats?.dryRun;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden />
            Audit retention
          </h3>
          {preview && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {preview.totalRows} rows total · {preview.deletable} prunable by
              default policy
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading retention policy…</p>
        ) : !preview ? (
          <p className="text-xs text-muted-foreground">
            Retention status unavailable — the sweep still runs at server boot.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Terminal rows older than the cutoff are pruned, and the table is
              capped at the newest {stats?.policy.rowCap.toLocaleString()} rows
              (matching the Insights aggregation window). Rows behind a queued
              background run are never pruned. Server restarts sweep the
              defaults automatically; this applies a tighter age on demand.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label
                  htmlFor="retention-max-age"
                  className="text-[11px] text-muted-foreground"
                >
                  Max age (days)
                </Label>
                <Input
                  id="retention-max-age"
                  type="number"
                  min={1}
                  max={3650}
                  value={maxAgeDays}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMaxAgeDays(Number.isFinite(v) ? Math.min(3650, Math.max(1, Math.round(v))) : 90);
                  }}
                  className="h-11 w-28 text-xs sm:h-8"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startPrune}
                disabled={pruning}
                className="h-11 gap-1.5 sm:h-8"
              >
                {pruning ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Prune old rows…
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Confirm gate: the dialog quotes the dry-run numbers the apply will
          produce with these exact parameters. */}
      <AlertDialog
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmState(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prune the skill audit log?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmState &&
                `With a ${confirmState.maxAgeDays}-day cutoff: ${confirmState.agedOut} aged-out terminal row(s) and ${confirmState.overCap} over-cap row(s) will be deleted — ${confirmState.deletable} in total, out of ${confirmState.totalRows}. This cannot be undone. Queued rows are never pruned.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pruning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pruning}
              onClick={(e) => {
                e.preventDefault();
                applyPrune();
              }}
            >
              {pruning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Prune {confirmState ? confirmState.deletable : ""} row
              {confirmState && confirmState.deletable === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ==========================================================================
// Tab 3 — Insights (K1 aggregate analytics)
// ==========================================================================

const WINDOWS: { key: "24h" | "7d" | "30d" | "all"; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

function InsightsTab() {
  const [window, setWindow] = React.useState<"24h" | "7d" | "30d" | "all">("7d");
  const [data, setData] = React.useState<InsightsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadInsights = React.useCallback(async (w: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/insights?window=${encodeURIComponent(w)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as InsightsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadInsights(window);
  }, [loadInsights, window]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Window selector — segmented buttons (radio group semantics).
            Touch-target sized (h-9 = 36px) per the mobile check standard. */}
        <div
          role="radiogroup"
          aria-label="Insights time window"
          className="inline-flex rounded-md border p-0.5"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              role="radio"
              aria-checked={window === w.key}
              onClick={() => setWindow(w.key)}
              className={cn(
                "h-9 min-w-11 rounded-sm px-3 text-xs font-medium transition-colors",
                window === w.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadInsights(window)}
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
          title="Insights unavailable"
          description={`Failed to aggregate skill invocations. ${error}`}
          action={
            <Button variant="outline" onClick={() => loadInsights(window)}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
        />
      ) : !data || data.totals.invocations === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No invocations in this window"
          description="Run some agent operations — chat tool calls, workflow nodes, REST tool runs — and the aggregate view will build up here."
          action={
            <Button variant="outline" onClick={() => loadInsights(window)}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          {/* Summary stat cards. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Invocations"
              value={String(data.totals.invocations)}
              hint={
                data.truncated ? "latest 20,000 rows" : `${data.window} window`
              }
            />
            <StatCard
              label="OK rate"
              value={formatRate(data.totals.okRate)}
              hint={`${data.totals.executed} executed`}
              tone={
                data.totals.okRate != null && data.totals.okRate < 0.8
                  ? "warn"
                  : "ok"
              }
            />
            <StatCard
              label="P50 latency"
              value={formatDuration(data.totals.p50Ms)}
              hint="executed calls only"
              icon={<Gauge className="size-3.5" />}
            />
            <StatCard
              label="P95 latency"
              value={formatDuration(data.totals.p95Ms)}
              hint="executed calls only"
              icon={<Timer className="size-3.5" />}
            />
          </div>

          {/* Status distribution. */}
          <Card>
            <CardContent className="space-y-2.5 p-4">
              <h3 className="text-sm font-semibold text-foreground">
                Outcome distribution
              </h3>
              <StatusBar counts={data.totals.byStatus} total={data.totals.invocations} />
            </CardContent>
          </Card>

          {/* Top skills table (max height + scroll per the long-list rule). */}
          <Card>
            <CardContent className="space-y-2.5 p-4">
              <h3 className="text-sm font-semibold text-foreground">
                Top skills
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  by invocation count in window
                </span>
              </h3>
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-2 font-medium">Skill</th>
                      <th scope="col" className="py-1.5 pr-2 text-right font-medium">Calls</th>
                      <th scope="col" className="py-1.5 pr-2 text-right font-medium">OK rate</th>
                      <th scope="col" className="py-1.5 pr-2 text-right font-medium">P50</th>
                      <th scope="col" className="py-1.5 pr-2 text-right font-medium">P95</th>
                      <th scope="col" className="py-1.5 text-right font-medium">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skills.map((s) => (
                      <tr key={s.skillId} className="border-b last:border-0">
                        <td className="py-1.5 pr-2">
                          <code className="font-mono text-[11px] text-foreground">
                            {s.skillId}
                          </code>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {s.count}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          <span
                            className={cn(
                              s.okRate != null &&
                                s.okRate < 0.8 &&
                                s.executed > 0 &&
                                "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {formatRate(s.okRate)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                          {formatDuration(s.p50Ms)}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                          {formatDuration(s.p95Ms)}
                        </td>
                        <td className="py-1.5 text-right whitespace-nowrap text-muted-foreground">
                          {s.lastUsedAt ? timeAgo(s.lastUsedAt) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Agents + Sources (two columns on desktop). */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="space-y-2.5 p-4">
                <h3 className="text-sm font-semibold text-foreground">
                  Most active agents
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    denied / limited are the gating + quota signals (K2/K3)
                  </span>
                </h3>
                {data.agents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No agent-attributed invocations in this window — the rows
                    here came from user-initiated lanes.
                  </p>
                ) : (
                  <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                    {data.agents.map((a) => (
                      <li
                        key={a.agentId}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-medium text-foreground">
                          {a.agentTitle}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {a.count} call{a.count === 1 ? "" : "s"}
                        </span>
                        {a.denied > 0 && (
                          <Pill
                            label={`${a.denied} denied`}
                            className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          />
                        )}
                        {a.limited > 0 && (
                          <Pill
                            label={`${a.limited} limited`}
                            className="bg-orange-500/10 text-orange-700 dark:text-orange-400"
                          />
                        )}
                        <span className="ml-auto whitespace-nowrap text-muted-foreground">
                          {a.lastUsedAt ? timeAgo(a.lastUsedAt) : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2.5 p-4">
                <h3 className="text-sm font-semibold text-foreground">
                  By lane (source)
                </h3>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {data.sources.map((s) => (
                    <li
                      key={s.source}
                      className="rounded-md bg-muted/30 px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Pill
                          label={s.source}
                          className="bg-muted uppercase text-muted-foreground"
                        />
                        <span className="tabular-nums text-muted-foreground">
                          {s.count} call{s.count === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        {STATUS_BAR_ORDER.filter(
                          (k) => s.byStatus[k] > 0,
                        ).map((k) => (
                          <span key={k} className="tabular-nums">
                            {s.byStatus[k]} {k}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Latency percentiles cover executed calls only (ok + error) —
            refused (denied / invalid / limited) and lane-declined (skipped)
            outcomes never measured a handler. Aggregated {data.totals.invocations}{" "}
            row{data.totals.invocations === 1 ? "" : "s"}
            {data.truncated ? " (latest 20,000 in window)" : ""} as of{" "}
            {timeAgo(data.generatedAt)}.
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </p>
        <p
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
            tone === "warn"
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {value}
        </p>
        {hint && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBar({
  counts,
  total,
}: {
  counts: StatusCounts;
  total: number;
}) {
  const segments = STATUS_BAR_ORDER.map((k) => ({
    key: k,
    count: counts[k],
  })).filter((s) => s.count > 0);

  if (segments.length === 0) {
    return <p className="text-xs text-muted-foreground">No outcomes yet.</p>;
  }

  return (
    <div className="space-y-2">
      {/* Stacked proportion bar. */}
      <div
        className="flex h-3 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Outcome distribution of ${total} invocations: ${segments
          .map((s) => `${s.count} ${s.key}`)
          .join(", ")}`}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("h-full", STATUS_BAR_COLORS[s.key])}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
      {/* Legend with counts. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s) => (
          <span
            key={s.key}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              className={cn("size-2 rounded-[2px]", STATUS_BAR_COLORS[s.key])}
              aria-hidden
            />
            {s.key}
            <span className="tabular-nums text-foreground">{s.count}</span>
            <span className="tabular-nums">
              ({Math.round((s.count / total) * 100)}%)
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ==========================================================================
// Tab 4 — Templates (Q3: curated skill packs + one-click import)
// ==========================================================================

/** The import-lane report for a template-pack import (same shape the
 *  Registry's file-import report uses, plus the echoed pack identity). */
interface PackImportReport {
  packName: string;
  requested: number;
  imported: { id: string; label: string }[];
  skipped: { skillId: string; suggestion: string | null }[];
  failed: { skillId: string | null; index: number; error: string }[];
  /** The bundle doc behind the report — the retry action re-submits it
   *  with a renames map built from the suggestions. */
  retryDoc?: Record<string, unknown>;
}

function TemplatesTab() {
  const toast = useAppStore((s) => s.toast);
  const setPendingSkillTab = useAppStore((s) => s.setPendingSkillTab);
  // The live catalog (ids only) — powers the "already imported" badges.
  const [catalogIds, setCatalogIds] = React.useState<Set<string> | null>(null);
  const [importingPackId, setImportingPackId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<PackImportReport | null>(null);
  // R3: pack-level uninstall — confirmation dialog + busy flag. The lane
  // deletes by packName (the import-time backfill), so renamed copies of
  // the pack's skills (conflict-retry imports) go away with it too.
  const [confirmUninstall, setConfirmUninstall] = React.useState<SkillTemplatePack | null>(null);
  const [uninstallingPackId, setUninstallingPackId] = React.useState<string | null>(null);

  const loadCatalogIds = React.useCallback(async () => {
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ids = Array.isArray(data?.skills)
        ? (data.skills as { id: string }[]).map((s) => s.id)
        : [];
      setCatalogIds(new Set(ids));
    } catch {
      setCatalogIds(new Set()); // badges degrade to "not loaded" = none shown
    }
  }, []);

  React.useEffect(() => {
    void loadCatalogIds();
  }, [loadCatalogIds]);

  // Q3: one pack import = ONE bundle-v2 POST through the SAME import lane a
  // downloaded file takes (same validators, same collision semantics with
  // rename suggestions, same audit story). The report lands in a dialog
  // that mirrors the Registry's file-import report.
  const importPack = async (pack: SkillTemplatePack) => {
    setImportingPackId(pack.id);
    try {
      const doc = packToBundleDoc(pack);
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: "Pack import failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setReport({
        packName: pack.name,
        requested: typeof data?.requested === "number" ? data.requested : 0,
        imported: Array.isArray(data?.imported) ? data.imported : [],
        skipped: Array.isArray(data?.skipped) ? data.skipped : [],
        failed: Array.isArray(data?.failed) ? data.failed : [],
        retryDoc: doc,
      });
      if (Array.isArray(data?.imported) && data.imported.length > 0) {
        await loadCatalogIds();
      }
    } catch (e) {
      toast({
        title: "Pack import failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setImportingPackId(null);
    }
  };

  // The report dialog's retry — re-submit the SAME pack with a renames map
  // covering every skipped skill that got a suggestion (identical to the
  // Registry's file-import retry semantics).
  const retrySkippedPackImport = async () => {
    if (!report?.retryDoc) return;
    const renames: Record<string, string> = {};
    for (const s of report.skipped) {
      if (s.suggestion) renames[s.skillId] = s.suggestion;
    }
    setImportingPackId("retry");
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...report.retryDoc, renames }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: "Retry failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setReport({
        packName: report.packName,
        requested: typeof data?.requested === "number" ? data.requested : 0,
        imported: Array.isArray(data?.imported) ? data.imported : [],
        skipped: Array.isArray(data?.skipped) ? data.skipped : [],
        failed: Array.isArray(data?.failed) ? data.failed : [],
        retryDoc: report.retryDoc,
      });
      if (Array.isArray(data?.imported) && data.imported.length > 0) {
        await loadCatalogIds();
      }
    } catch (e) {
      toast({
        title: "Retry failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setImportingPackId(null);
    }
  };

  // R3: pack-level uninstall — the inverse of importPack. The lane deletes
  // every CustomSkill row WHERE packName = pack.name (the exact identity
  // the import backfilled), so it is the honest "remove the whole pack"
  // including renamed copies. Audit history is preserved (server-side).
  const uninstallPack = async (pack: SkillTemplatePack) => {
    setUninstallingPackId(pack.id);
    try {
      const res = await fetch("/api/skills/pack/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packName: pack.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: "Pack uninstall failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const count = typeof data?.count === "number" ? data.count : 0;
      toast({
        title: `Pack uninstalled — ${pack.name}`,
        description:
          `${count} skill${count === 1 ? "" : "s"} unregistered as a unit` +
          (data?.disabledDeleted
            ? ` (${data.disabledDeleted} were disabled)`
            : "") +
          ". Audit history is preserved in the Activity tab.",
        variant: "default",
      });
      await loadCatalogIds();
    } catch (e) {
      toast({
        title: "Pack uninstall failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setUninstallingPackId(null);
      setConfirmUninstall(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Curated skill packs — shareable bundles with a name, README, and tags
        (bundle format version 2). One click imports the pack through the same
        lane a downloaded bundle file takes: identical validation, collision
        handling with rename offers, and audit story. Your own packs come from{" "}
        <em>Select → Export selected</em> in the Registry.
      </p>

      {catalogIds === null && <PanelSkeleton count={3} />}

      {catalogIds !== null && (
        <div className="grid gap-4 md:grid-cols-2">
          {SKILL_TEMPLATE_PACKS.map((pack) => {
            const owned = pack.skills.filter((s) => catalogIds.has(s.skillId)).length;
            const fullyImported = owned === pack.skills.length;
            const isOpen = expanded === pack.id;
            return (
              <Card
                key={pack.id}
                className={cn(
                  "gap-3 py-4 transition-colors",
                  isOpen && "border-primary/40",
                )}
                data-testid={`template-pack-${pack.id}`}
              >
                <CardContent className="space-y-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">{pack.name}</h3>
                        {fullyImported && (
                          <Badge
                            variant="secondary"
                            className="gap-1 text-[9px] uppercase"
                            title="Every skill in this pack is registered on this instance"
                          >
                            Imported
                          </Badge>
                        )}
                        {!fullyImported && owned > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[9px] uppercase"
                          >
                            {owned}/{pack.skills.length} imported
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {pack.description}
                      </p>
                    </div>
                    <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </div>

                  {pack.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {pack.tags.map((t) => (
                        <Badge
                          key={t}
                          variant="secondary"
                          className="text-[10px] font-normal"
                        >
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setExpanded(isOpen ? null : pack.id)}
                    aria-expanded={isOpen}
                    data-testid={`template-pack-toggle-${pack.id}`}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    {pack.skills.length} skill{pack.skills.length === 1 ? "" : "s"}
                  </button>

                  {isOpen && (
                    <ul className="space-y-2 rounded-md border bg-muted/30 p-3">
                      {pack.skills.map((s) => (
                        <li key={s.skillId} className="space-y-1 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="font-mono text-[11px]"
                              data-testid={`template-skill-${s.skillId}`}
                            >
                              {s.skillId}
                            </span>
                            {catalogIds.has(s.skillId) && (
                              <Badge
                                variant="secondary"
                                className="text-[9px] uppercase"
                              >
                                registered
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[9px] uppercase",
                                s.latency === "slow"
                                  ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
                                  : "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
                              )}
                            >
                              {s.latency}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground">{s.description}</p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            → {s.endpoint}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void importPack(pack)}
                      disabled={importingPackId !== null}
                      className="h-11 gap-1.5 sm:h-8"
                      data-testid={`template-import-${pack.id}`}
                    >
                      {importingPackId === pack.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      {fullyImported ? "Re-import pack" : "Import pack"}
                    </Button>
                    {/* R3: pack-level uninstall — offered once ANY of the
                        pack's rows exist on this instance (the lane removes
                        the whole packName family, renamed copies included). */}
                    {owned > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmUninstall(pack)}
                        disabled={uninstallingPackId !== null}
                        className="h-11 gap-1.5 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 sm:h-8"
                        data-testid={`template-uninstall-${pack.id}`}
                      >
                        {uninstallingPackId === pack.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                        Uninstall pack
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingSkillTab("registry")}
                      className="h-11 sm:h-8"
                    >
                      <BookOpen className="size-4" />
                      View in Registry
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pack import report — the same honest per-skill outcomes the file
          import shows, titled with the pack name. */}
      <AlertDialog
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="pack-import-report-title">
              Pack import report — {report?.packName}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {report &&
                `${report.imported.length} of ${report.requested} skill${
                  report.requested === 1 ? "" : "s"
                } imported. Collisions are skipped with a rename offer (not a rollback); validation failures are reported per skill.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {report && (
            <div className="space-y-3 text-xs">
              {report.imported.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                    Imported ({report.imported.length})
                  </p>
                  <ul className="space-y-1">
                    {report.imported.map((s) => (
                      <li key={s.id} className="font-mono text-[11px]">
                        {s.id}
                        <span className="ml-2 font-sans text-muted-foreground">
                          {s.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.skipped.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-amber-700 dark:text-amber-400">
                    Skipped — already registered ({report.skipped.length})
                  </p>
                  <ul className="space-y-1">
                    {report.skipped.map((s) => (
                      <li key={s.skillId} className="font-mono text-[11px]">
                        {s.skillId}
                        {s.suggestion ? (
                          <span className="ml-2 font-sans text-muted-foreground">
                            rename offer: {s.suggestion}
                          </span>
                        ) : (
                          <span className="ml-2 font-sans text-muted-foreground">
                            no free rename id
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.failed.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold text-rose-700 dark:text-rose-400">
                    Failed validation ({report.failed.length})
                  </p>
                  <ul className="space-y-1">
                    {report.failed.map((f, i) => (
                      <li key={`${f.skillId ?? "unknown"}-${i}`} className="space-y-0.5">
                        <span className="font-mono text-[11px]">{f.skillId ?? `(entry #${f.index})`}</span>
                        <p className="text-muted-foreground">{f.error}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importingPackId !== null}>Close</AlertDialogCancel>
            {report && report.skipped.some((s) => s.suggestion) && (
              <AlertDialogAction
                disabled={importingPackId !== null}
                onClick={(e) => {
                  // Keep the dialog open while the retry runs (Radix
                  // auto-close would lose the pending state).
                  e.preventDefault();
                  void retrySkippedPackImport();
                }}
              >
                {importingPackId === "retry" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Import skipped as suggested
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* R3: pack-level uninstall confirmation — one action removes every
          row this pack's import created (by packName, renamed copies
          included). Audit history survives (the server never touches it). */}
      <AlertDialog
        open={confirmUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUninstall(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="pack-uninstall-title">
              Uninstall pack “{confirmUninstall?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every skill imported from this pack — including renamed copies
              from conflict retries — will be unregistered as a unit. Their
              past invocation rows stay in the Activity tab (audit history is
              never rewritten). Individually registered skills are immune:
              the uninstall matches the pack identity, not the skill ids.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstallingPackId !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={uninstallingPackId !== null}
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={(e) => {
                // Keep the dialog open while the uninstall runs.
                e.preventDefault();
                if (confirmUninstall) void uninstallPack(confirmUninstall);
              }}
              data-testid="pack-uninstall-confirm"
            >
              {uninstallingPackId !== null ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Uninstall pack
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ==========================================================================
// Q3: pack metadata dialog — "Export selected" turns a selection into a
// shareable version-2 skill pack
// ==========================================================================

function PackMetaDialog({
  open,
  count,
  onOpenChange,
  onExport,
}: {
  open: boolean;
  /** How many skills the pending selection carries (context in copy). */
  count: number;
  onOpenChange: (open: boolean) => void;
  onExport: (meta: { name?: string; description?: string; tags?: string }) => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tags, setTags] = React.useState("");

  // Reset on open — a stale name from a cancelled export must not leak
  // into the next one ([open] per the Radix dialog lifecycle).
  React.useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setTags("");
    }
  }, [open]);

  const nameOk = name.trim().length > 0 && name.trim().length <= 80;
  const tagsClean = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export as a skill pack</DialogTitle>
          <DialogDescription>
            {count} skill{count === 1 ? "" : "s"} travel inside a bundle
            document. Give it a name and a README — the export becomes a{" "}
            <span className="font-medium">version-2 pack</span> that the
            Templates tab on any instance can render, while v1-only importers
            still accept it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pack-name">Pack name</Label>
            <Input
              id="pack-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lab Sequence Ops"
              maxLength={80}
              data-testid="pack-name-input"
            />
            <p className="text-xs text-muted-foreground">
              {name.trim().length}/80 — required for a pack.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pack-description">README / description</Label>
            <Textarea
              id="pack-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this pack is for, what the skills do, what a consumer needs running (e.g. a webhook target)…"
              rows={3}
              maxLength={500}
              data-testid="pack-description-input"
            />
            <p className="text-xs text-muted-foreground">{description.length}/500</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pack-tags">Tags</Label>
            <Input
              id="pack-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="comma, separated, tags"
              data-testid="pack-tags-input"
            />
            <p className="text-xs text-muted-foreground">
              {tagsClean.length}/8 shown as pills (each ≤ 24 chars).
            </p>
          </div>
        </div>

        <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => onExport({})} // no metadata → plain v1 bundle
            data-testid="pack-export-plain"
          >
            Export plain bundle (v1)
          </Button>
          <Button
            type="button"
            onClick={() =>
              onExport({
                name: name.trim(),
                description: description.trim() || undefined,
                tags: tagsClean.join(", ") || undefined,
              })
            }
            disabled={!nameOk}
            className="gap-1.5"
            data-testid="pack-export-v2"
          >
            <Package className="size-4" />
            Export pack (v2)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// Custom skill dialog (M3 register + N2 edit) — POST /api/skills | PATCH
// ==========================================================================

interface ParamRow {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  required: boolean;
  description: string;
}

const EMPTY_PARAM_ROW: ParamRow = {
  key: "",
  type: "string",
  required: false,
  description: "",
};

/** N2: one header row = one key/value pair sent with every webhook POST. */
interface HeaderRow {
  key: string;
  value: string;
}

const EMPTY_HEADER_ROW: HeaderRow = { key: "", value: "" };

function CustomSkillDialog({
  mode,
  skill,
  open,
  onOpenChange,
}: {
  mode: "register" | "edit";
  /** Edit mode: the catalog entry being edited (register mode: undefined). */
  skill?: SkillCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const editing = mode === "edit" && skill;
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [params, setParams] = React.useState<ParamRow[]>([]);
  const [headers, setHeaders] = React.useState<HeaderRow[]>([]);
  const [latency, setLatency] = React.useState<"fast" | "slow">("fast");
  // O1: declared knowledge requirements (closed set — the checkbox rows
  // are rendered FROM REQUIREMENT_LABELS so the two can never drift).
  const [requires, setRequires] = React.useState<SkillRequirement[]>([]);
  // P3a: the agent whitelist (agent-id array; empty = every agent).
  // Rendered from the store's agents list + a defensive row for ids the
  // store doesn't know (imported whitelists — removable inline).
  const [agents, setAgents] = React.useState<string[]>([]);
  const knownAgents = useAppStore((s) => s.agents);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Prefill whenever the dialog OPENS for a new target (edit) or resets
  // (register). Only runs when open so keystrokes made while the dialog
  // animates closed are never clobbered by a stale prefill.
  React.useEffect(() => {
    if (!open) return;
    if (editing && skill) {
      setLabel(skill.label);
      setDescription(skill.description);
      setEndpoint(skill.endpoint ?? "");
      setParams(
        (skill.params ?? []).map((p) => ({
          key: p.key,
          type: p.type,
          required: p.required === true,
          description: p.description,
        })),
      );
      setHeaders(
        Object.entries(skill.headers ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
      );
      setLatency(skill.latency);
      // O1: prefill the declared requirements (unknown ids dropped — the
      // server only ever persists the closed set).
      setRequires(
        (skill.requires ?? []).filter((r) => r in REQUIREMENT_LABELS),
      );
      // P3a: prefill the whitelist as-is (ids may not resolve to local
      // agents — an imported whitelist is still honest data; the unknown
      // ids render in their own removable rows).
      setAgents((skill.agents ?? []).slice());
    } else {
      setLabel("");
      setDescription("");
      setEndpoint("");
      setParams([]);
      setHeaders([]);
      setLatency("fast");
      setRequires([]);
      setAgents([]);
    }
    setFormError(null);
    // Prefill is a pure function of (open, skill identity); in-flight edits
    // are local state — the dialog resets deterministically on each open.
  }, [open, editing, skill?.id]);

  const addParamRow = () => {
    if (params.length >= 6) return;
    setParams((prev) => [...prev, { ...EMPTY_PARAM_ROW }]);
  };

  const updateParamRow = (i: number, patch: Partial<ParamRow>) => {
    setParams((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };

  const removeParamRow = (i: number) => {
    setParams((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addHeaderRow = () => {
    if (headers.length >= 8) return;
    setHeaders((prev) => [...prev, { ...EMPTY_HEADER_ROW }]);
  };

  const updateHeaderRow = (i: number, patch: Partial<HeaderRow>) => {
    setHeaders((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    );
  };

  const removeHeaderRow = (i: number) => {
    setHeaders((prev) => prev.filter((_, idx) => idx !== i));
  };

  const submit = async () => {
    setFormError(null);
    if (submitting) return;
    // Light client-side guardrails — the server validates fully (400s carry
    // its message into the inline error).
    if (!label.trim()) {
      setFormError("A label is required.");
      return;
    }
    if (!endpoint.trim()) {
      setFormError("A webhook endpoint URL is required.");
      return;
    }
    // Serialized header set: blank rows are dropped; duplicates fail locally
    // with the same rule the server enforces.
    const headerEntries = headers
      .filter((h) => h.key.trim())
      .map((h) => [h.key.trim(), h.value] as const);
    const seenKeys = new Set(headerEntries.map(([k]) => k));
    if (seenKeys.size !== headerEntries.length) {
      setFormError("Duplicate header names — each header key may appear once.");
      return;
    }
    // P3a: the whitelist must not carry duplicates (server 400 parity —
    // catching it locally keeps the dialog honest without a round trip).
    if (new Set(agents).size !== agents.length) {
      setFormError("Duplicate agents in the whitelist — each agent may appear once.");
      return;
    }
    setSubmitting(true);
    try {
      const paramRows = params
        .filter((p) => p.key.trim())
        .map((p) => ({
          key: p.key.trim(),
          type: p.type,
          ...(p.required ? { required: true } : {}),
          description: p.description.trim() || `${p.key.trim()} parameter`,
        }));
      const headerObj: Record<string, string> = {};
      for (const [k, v] of headerEntries) headerObj[k] = v;

      if (editing && skill) {
        // N2: update the fields the dialog owns. Enabled is NOT included
        // (the card power button owns it) — an edit never silently
        // re-enables a disabled skill. O1: requires is included — it is
        // part of the definition the dialog owns.
        const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: label.trim(),
            description: description.trim() || label.trim(),
            endpoint: endpoint.trim(),
            params: paramRows,
            headers: headerEntries.length > 0 ? headerObj : null,
            latency,
            requires,
            // P3a: the dialog owns the whole whitelist (array replace —
            // empty array clears it, exactly like requires).
            agents,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFormError(data?.error ?? `HTTP ${res.status}`);
          return;
        }
        toast({
          title: "Custom skill updated",
          description: `"${skill.id}" now uses the new definition — invocations after this moment follow it (the skill manifest agents see refreshes on their next turn).`,
          variant: "default",
        });
        onOpenChange(false);
      } else {
        const payload = {
          label: label.trim(),
          description: description.trim() || label.trim(),
          endpoint: endpoint.trim(),
          params: paramRows,
          ...(headerEntries.length > 0 ? { headers: headerObj } : {}),
          latency,
          requires,
          ...(agents.length > 0 ? { agents } : {}),
        };
        const res = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFormError(data?.error ?? `HTTP ${res.status}`);
          return;
        }
        toast({
          title: "Custom skill registered",
          description:
            latency === "slow"
              ? `"${data?.skill?.id ?? label.trim()}" is live as a SLOW skill — agent and REST invocations queue it as a background tool job (stoppable, audited).`
              : `"${data?.skill?.id ?? label.trim()}" is live — agents can invoke it immediately (it appears in their skill manifest on the next turn).`,
          variant: "default",
        });
        onOpenChange(false);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="size-4 text-muted-foreground" aria-hidden />
            {editing ? `Edit ${skill?.id ?? "custom skill"}` : "Register a custom skill"}
          </DialogTitle>
          <DialogDescription>
            A webhook skill: your endpoint receives a POST with the
            validated params and its 2xx response becomes the skill result.
            Registered skills flow through the same pipeline as built-ins —
            validation, rate limits, audit, insights — with no extra wiring.
            {editing
              ? " Edits apply to future invocations; past audit rows keep their historical shape."
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="skill-label">
              Label <span className="text-rose-600 dark:text-rose-400">*</span>
            </Label>
            <Input
              id="skill-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Lab inventory lookup"
              maxLength={80}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the skill does — this is what agents read to decide when to call it."
              rows={2}
              maxLength={400}
            />
            <p className="text-[11px] text-muted-foreground">
              Defaults to the label when left empty.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-endpoint">
              Webhook endpoint{" "}
              <span className="text-rose-600 dark:text-rose-400">*</span>
            </Label>
            <Input
              id="skill-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://localhost:3030/echo"
              inputMode="url"
              maxLength={2000}
            />
            <p className="text-[11px] text-muted-foreground">
              http(s) URL — POSTed{" "}
              <code className="font-mono">
                {"{skillId, params, source, agent?, at}"}
              </code>{" "}
              {latency === "slow"
                ? "in the background queue with a 10-minute timeout."
                : "with a 20s timeout. Non-2xx or timeout → honest error."}
            </p>
          </div>

          {/* N1: execution policy — slow skills are queued as background
              tool jobs by agent chat + REST invoke lanes. */}
          <div className="space-y-1.5">
            <Label>Execution policy</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Execution policy">
              <button
                type="button"
                role="radio"
                aria-checked={latency === "fast"}
                onClick={() => setLatency("fast")}
                className={cn(
                  "rounded-md border p-2.5 text-left transition-colors",
                  latency === "fast"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-accent/50",
                )}
              >
                <p className="text-xs font-medium text-foreground">Fast · inline</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Invoked synchronously (≤10s, 20s webhook timeout).
                </p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={latency === "slow"}
                onClick={() => setLatency("slow")}
                className={cn(
                  "rounded-md border p-2.5 text-left transition-colors",
                  latency === "slow"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-accent/50",
                )}
              >
                <p className="text-xs font-medium text-foreground">Slow · queued</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Background tool job — real stop, audit transitions, 10-min
                  timeout. For long external computations.
                </p>
              </button>
            </div>
          </div>

          {/* O1: authorization declaration — the closed requirement set,
              rendered from REQUIREMENT_LABELS so the rows and the gate can
              never drift. Empty selection = every agent may invoke. */}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">
              Agent knowledge requirements
            </legend>
            <p className="text-[11px] text-muted-foreground">
              Optional authorization: only agents with the checked knowledge
              switches may invoke this skill — enforced at execution time and
              reflected in each agent's skill manifest. Leave both unchecked
              for every agent.
            </p>
            <div className="space-y-1.5">
              {(Object.keys(REQUIREMENT_LABELS) as SkillRequirement[]).map((r) => {
                const checked = requires.includes(r);
                return (
                  <label
                    key={r}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors",
                      checked
                        ? "border-primary bg-primary/5"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setRequires((prev) =>
                          e.target.checked
                            ? [...prev, r]
                            : prev.filter((x) => x !== r),
                        )
                      }
                      className="mt-0.5 size-4 accent-primary"
                      aria-label={`Require ${REQUIREMENT_LABELS[r]}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        Require {REQUIREMENT_LABELS[r]}
                        <code className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                          {r}
                        </code>
                      </span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {REQUIREMENT_HINTS[r]}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* P3a: the agent whitelist — the third authorization dimension.
              Rendered from the live agents list; ids that match no local
              agent (imported whitelists) get their own removable rows. */}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">
              Agent whitelist
            </legend>
            <p className="text-[11px] text-muted-foreground">
              Optional restriction: when agents are checked, ONLY they may
              invoke this skill (knowledge requirements still apply on top).
              Leave empty for every agent. Enforced at execution time and
              reflected in each agent's skill manifest.
            </p>
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {knownAgents.map((a) => {
                const checked = agents.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors",
                      checked
                        ? "border-primary bg-primary/5"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setAgents((prev) =>
                          e.target.checked
                            ? [...prev, a.id]
                            : prev.filter((x) => x !== a.id),
                        )
                      }
                      className="size-4 accent-primary"
                      aria-label={`Whitelist ${a.title}`}
                    />
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                      style={{ background: a.color }}
                    >
                      {a.title.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {a.title}
                    </span>
                  </label>
                );
              })}
              {agents
                .filter((id) => !knownAgents.some((a) => a.id === id))
                .map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2"
                  >
                    <Badge variant="outline" className="text-[10px] font-normal">
                      unknown id
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {id}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setAgents((prev) => prev.filter((x) => x !== id))
                      }
                      aria-label={`Remove unknown agent id ${id.slice(0, 12)}`}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
            </div>
            {agents.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {agents.length} agent{agents.length === 1 ? "" : "s"} may
                invoke — everyone else is refused at execution time.
              </p>
            )}
          </fieldset>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Params ({params.length}/6)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addParamRow}
                disabled={params.length >= 6}
                className="h-7 gap-1 text-xs"
              >
                <Plus className="size-3.5" />
                Add param
              </Button>
            </div>
            {params.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No declared params — the skill still runs; the webhook just
                receives the request context.
              </p>
            ) : (
              <div className="space-y-2">
                {params.map((row, i) => (
                  <div
                    key={i}
                    className="space-y-1.5 rounded-md border p-2.5"
                    aria-label={`Param ${i + 1}`}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => updateParamRow(i, { key: e.target.value })}
                        placeholder="key (e.g. query)"
                        className="h-8 flex-1 font-mono text-xs"
                        aria-label={`Param ${i + 1} key`}
                        maxLength={40}
                      />
                      <Select
                        value={row.type}
                        onValueChange={(v) =>
                          updateParamRow(i, {
                            type: v as ParamRow["type"],
                          })
                        }
                      >
                        <SelectTrigger
                          className="h-8 w-28 text-xs"
                          aria-label={`Param ${i + 1} type`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(["string", "number", "boolean", "json"] as const).map(
                            (t) => (
                              <SelectItem key={t} value={t} className="text-xs">
                                {t}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                      <label className="flex h-8 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={row.required}
                          onChange={(e) =>
                            updateParamRow(i, { required: e.target.checked })
                          }
                          className="size-4 accent-primary"
                          aria-label={`Param ${i + 1} required`}
                        />
                        req
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeParamRow(i)}
                        aria-label={`Remove param ${i + 1}`}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <Input
                      value={row.description}
                      onChange={(e) =>
                        updateParamRow(i, { description: e.target.value })
                      }
                      placeholder="Description agents read for this param"
                      className="h-8 text-xs"
                      aria-label={`Param ${i + 1} description`}
                      maxLength={200}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* N2: headers — plain passthrough on every webhook POST. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Headers ({headers.length}/8)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addHeaderRow}
                disabled={headers.length >= 8}
                className="h-7 gap-1 text-xs"
              >
                <Plus className="size-3.5" />
                Add header
              </Button>
            </div>
            {headers.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No extra headers — the webhook receives JSON content-type
                only. Add rows for auth tokens or routing hints your
                endpoint expects.
              </p>
            ) : (
              <div className="space-y-2">
                {headers.map((row, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2"
                    aria-label={`Header ${i + 1}`}
                  >
                    <Input
                      value={row.key}
                      onChange={(e) =>
                        updateHeaderRow(i, { key: e.target.value })
                      }
                      placeholder="header (e.g. X-API-Key)"
                      className="h-8 flex-1 font-mono text-xs"
                      aria-label={`Header ${i + 1} name`}
                      maxLength={60}
                    />
                    <Input
                      value={row.value}
                      onChange={(e) =>
                        updateHeaderRow(i, { value: e.target.value })
                      }
                      placeholder="value"
                      className="h-8 flex-1 font-mono text-xs"
                      aria-label={`Header ${i + 1} value`}
                      maxLength={500}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeHeaderRow(i)}
                      aria-label={`Remove header ${i + 1}`}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {formError && (
            <p
              className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-400"
              role="alert"
            >
              {formError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="gap-1.5"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : editing ? (
              <Pencil className="size-4" />
            ) : (
              <Webhook className="size-4" />
            )}
            {editing ? "Save changes" : "Register skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
