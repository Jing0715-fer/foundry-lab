"use client";

/**
 * Environment sheet — Environment & Toolchain panel (host scan + installs).
 *
 * Installation-status page for everything the app needs:
 *   ① Runtime dependencies  — python3 / numpy / scipy / biopython / git
 *      (with live version detection + one-click pip install when missing)
 *   ② Built-in real algorithm engines — the shipped Python science engines
 *      (diffusion, folding, inverse folding, scoring, antibody), each with a
 *      live self-test status + algorithm citations
 *   ③ External tools — the heavyweight upstream packages (RFdiffusion,
 *      ProteinMPNN, Rosetta…) plus AlphaFold2 (provided on the GPU cluster
 *      via `module load alphafold2` — connect it under Cluster): native
 *      install status, one-click installs with a live-streaming terminal,
 *      and which built-in engine serves as the real-algorithm fallback
 *   ④ Recent install jobs with their full logs.
 */

import * as React from "react";
import {
  Wrench,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Download,
  ExternalLink,
  Terminal,
  Loader2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Boxes,
  PackageCheck,
  FlaskConical,
  BookOpen,
  Info,
  Layers,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/lib/store";
import { PanelSkeleton } from "@/components/empty-state";
import { cn } from "@/lib/utils";

// ── API types (mirror /api/tools/scan + /api/tools/install) ─────────────────

interface RuntimeRow {
  key: string;
  label: string;
  description: string;
  installed: boolean;
  version: string | null;
  installMethod: string;
  installCommand: string;
  installLabel: string;
  docs: string;
  oneClick: boolean;
  sizeHint: string | null;
  category: string;
}

interface EngineRow {
  key: string;
  label: string;
  script: string;
  description: string;
  algorithms: string[];
  serves: string[];
  provenance: { refs: string[]; accuracy: string } | null;
  ok: boolean;
  detail: string;
}

interface ToolRow {
  key: string;
  label: string;
  category: string;
  description: string;
  installed: boolean;
  installMethod: string;
  installCommand: string;
  installLabel: string;
  docs: string;
  oneClick: boolean;
  sizeHint?: string;
  builtinEngine?: string;
  executorReady: boolean;
}

interface FoundryStatusDTO {
  installed: boolean;
  python: string | null;
  cli: string | null;
  version: string | null;
  torch: string | null;
  cuda: boolean;
  checkpoints: { name: string; path: string; size: string }[];
  capabilities: { mpnn: boolean; rfd3: boolean; rf3: boolean };
  selftestOk: boolean;
  selftestDetail: string;
}

interface ScanResponse {
  scannedAt: string;
  runtime: RuntimeRow[];
  engines: EngineRow[];
  tools: ToolRow[];
  foundry: FoundryStatusDTO | null;
  summary: {
    runtime: { installed: number; total: number; coreReady: boolean; allReady: boolean };
    engines: { ok: number; total: number };
    tools: { nativeInstalled: number; total: number; withEngineFallback: number };
  };
  activeInstall: InstallJobDTO | null;
  recentInstalls: InstallJobDTO[];
}

interface InstallJobDTO {
  id: string;
  key: string;
  label: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logs: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const TOOL_CATEGORY_LABELS: Record<string, string> = {
  platform: "Foundry Platform & Model Stack",
  design: "De-novo Design",
  "inverse-folding": "Inverse Folding",
  "structure-prediction": "Structure Prediction",
  scoring: "Scoring & Analysis",
};
const TOOL_CATEGORY_ORDER = [
  "platform",
  "design",
  "inverse-folding",
  "structure-prediction",
  "scoring",
];

const ENGINE_LABELS: Record<string, string> = {
  "engine-diffusion": "Backbone Diffusion",
  "engine-fold": "Structure Prediction",
  "engine-mpnn": "Inverse Folding",
  "engine-score": "Knowledge-Based Scoring",
  "engine-antibody": "Antibody Design",
};

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ToolsPanel() {
  const toast = useAppStore((s) => s.toast);
  const [scan, setScan] = React.useState<ScanResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [scanning, setScanning] = React.useState(false);
  const [scanError, setScanError] = React.useState<string | null>(null);

  // Install dialog state.
  const [installJob, setInstallJob] = React.useState<InstallJobDTO | null>(null);
  const [installOpen, setInstallOpen] = React.useState(false);
  const [startingInstall, setStartingInstall] = React.useState<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const logBoxRef = React.useRef<HTMLDivElement>(null);

  const runScan = React.useCallback(
    async (silent = false) => {
      if (!silent) setScanning(true);
      try {
        const res = await fetch("/api/tools/scan", { cache: "no-store" });
        if (!res.ok) throw new Error(`Scan failed (${res.status})`);
        const data = (await res.json()) as ScanResponse;
        setScan(data);
        setScanError(null);
      } catch (e) {
        setScanError((e as Error).message);
      } finally {
        setScanning(false);
        setLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    void runScan();
  }, [runScan]);

  // If a scan arrives with an active install job, surface it in the dialog.
  React.useEffect(() => {
    if (scan?.activeInstall && !installOpen) {
      setInstallJob(scan.activeInstall);
      setInstallOpen(true);
    }
  }, [scan?.activeInstall, installOpen]);

  // Poll the open install job until it finishes.
  React.useEffect(() => {
    if (!installOpen || !installJob) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    if (installJob.status !== "running") {
      if (pollRef.current) clearInterval(pollRef.current);
      // One final scan to refresh statuses when an install finishes.
      if (pollRef.current || installJob.status === "completed") void runScan(true);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/tools/install/${installJob.id}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const job = (await res.json()) as InstallJobDTO;
        setInstallJob(job);
        if (job.status !== "running") {
          if (job.status === "completed") {
            toast({
              title: `${job.label} installed`,
              description: "Re-scanning environment…",
            });
          }
          void runScan(true);
        }
      } catch {
        /* transient poll failure — keep trying */
      }
    }, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [installOpen, installJob, runScan, toast]);

  // Auto-scroll the install log.
  React.useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [installJob?.logs.length]);

  const startInstall = React.useCallback(
    async (key: string, label: string) => {
      setStartingInstall(key);
      try {
        const res = await fetch("/api/tools/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast({
            title: "Cannot start install",
            description: data.error ?? "Unknown error",
            variant: "destructive",
          });
          return;
        }
        setInstallJob(data as InstallJobDTO);
        setInstallOpen(true);
      } catch (e) {
        toast({
          title: "Install request failed",
          description: (e as Error).message,
          variant: "destructive",
        });
      } finally {
        setStartingInstall(null);
      }
    },
    [toast],
  );

  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6">
        <PanelSkeleton count={4} />
      </div>
    );
  }

  const summary = scan?.summary;

  // Root is a full-height scroll container: the panel renders inside a
  // fixed-height Sheet (side="left"), so it must own its scrolling — same
  // pattern as ClusterPanel. Content is centered with max-w-3xl.
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <Wrench className="size-5 text-primary" />
            <h2 className="text-lg font-semibold tracking-tight">
              Environment &amp; Toolchain
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Installation status for every dependency the studio uses — runtime,
            built-in real algorithm engines, and external research tools.
            Uninstalled items with a{" "}
            <span className="font-medium text-foreground">Install</span> button
            support one-click installation.
          </p>
        </div>
        {/* mr-8 keeps the button clear of the Sheet's absolute close (X)
            button, which floats at the top-right corner of the sheet. */}
        <Button
          variant="outline"
          size="sm"
          className="mr-8 shrink-0"
          onClick={() => void runScan()}
          disabled={scanning}
        >
          {scanning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Re-scan
        </Button>
      </div>

      {scanError && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 p-4 text-sm">
            <XCircle className="size-4 shrink-0 text-destructive" />
            <div className="flex-1">
              <p className="font-medium">Environment scan failed</p>
              <p className="text-muted-foreground">{scanError}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void runScan()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Summary cards ────────────────────────────────────────────────── */}
      {scan && summary && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard
            icon={<Cpu className="size-4" />}
            title="Runtime"
            value={`${summary.runtime.installed}/${summary.runtime.total}`}
            caption={summary.runtime.coreReady ? "core ready" : "python3 + numpy required"}
            ok={summary.runtime.coreReady}
          />
          <SummaryCard
            icon={<Boxes className="size-4" />}
            title="Real algorithm engines"
            value={`${summary.engines.ok}/${summary.engines.total}`}
            caption={summary.engines.ok === summary.engines.total ? "all self-tests pass" : "self-test failures"}
            ok={summary.engines.ok === summary.engines.total}
          />
          <SummaryCard
            icon={<PackageCheck className="size-4" />}
            title="External tools (native)"
            value={`${summary.tools.nativeInstalled}/${summary.tools.total}`}
            caption={`${summary.tools.withEngineFallback} covered by built-in engines`}
            ok={summary.tools.withEngineFallback === summary.tools.total}
          />
        </div>
      )}

      {/* ── ① Runtime dependencies ───────────────────────────────────────── */}
      {scan && (
        <section className="space-y-3" aria-labelledby="runtime-heading">
          <SectionHeader
            id="runtime-heading"
            icon={<Cpu className="size-4" />}
            title="Runtime Dependencies"
            count={scan.runtime.length}
            hint="Required by the built-in engines. Missing items can be installed with one click."
          />
          <div className="grid gap-3 md:grid-cols-2">
            {scan.runtime.map((r) => (
              <RuntimeCard
                key={r.key}
                row={r}
                onInstall={() => void startInstall(r.key, r.label)}
                installing={startingInstall === r.key}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── ② Built-in engines ──────────────────────────────────────────── */}
      {scan && (
        <section className="space-y-3" aria-labelledby="engines-heading">
          <SectionHeader
            id="engines-heading"
            icon={<FlaskConical className="size-4" />}
            title="Built-in Real Algorithm Engines"
            count={scan.engines.length}
            hint="Shipped Python science engines — every run is a real algorithm (Chou-Fasman, Miyazawa-Jernigan, Shrake-Rupley, NeRF, Metropolis MC). No neural-network weights needed."
          />
          <div className="space-y-3">
            {scan.engines.map((e) => (
              <EngineCard key={e.key} engine={e} />
            ))}
          </div>
        </section>
      )}

      {/* ── ②½ Foundry platform (official RosettaCommons model stack) ──── */}
      {scan && scan.foundry && (
        <FoundryPlatformCard
          foundry={scan.foundry}
          onInstall={() => void startInstall("foundry", "Foundry (RosettaCommons)")}
          installing={startingInstall === "foundry"}
        />
      )}

      {/* ── ③ External tools ────────────────────────────────────────────── */}
      {scan && (
        <section className="space-y-3" aria-labelledby="external-heading">
          <SectionHeader
            id="external-heading"
            icon={<Wrench className="size-4" />}
            title="External Tools"
            count={scan.tools.length}
            hint="Heavyweight upstream packages. When the native tool is missing, the mapped built-in engine executes the same job with real algorithms — installs upgrade you to the native implementation."
          />
          {TOOL_CATEGORY_ORDER.map((cat) => {
            const rows = scan.tools.filter((t) => t.category === cat);
            if (!rows.length) return null;
            return (
              <div key={cat} className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {TOOL_CATEGORY_LABELS[cat] ?? cat}
                </h4>
                <div className="grid gap-3 md:grid-cols-2">
                  {rows.map((t) => (
                    <ToolCard
                      key={t.key}
                      row={t}
                      engines={scan.engines}
                      onInstall={() => void startInstall(t.key, t.label)}
                      installing={startingInstall === t.key}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* ── ④ Recent installs ───────────────────────────────────────────── */}
      {scan && scan.recentInstalls.length > 0 && (
        <RecentInstalls
          jobs={scan.recentInstalls}
          onOpen={(job) => {
            setInstallJob(job);
            setInstallOpen(true);
          }}
        />
      )}

      {/* ── Install dialog (live terminal) ──────────────────────────────── */}
      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
              <Terminal className="size-4" />
              Installing {installJob?.label ?? ""}
              {installJob && (
                <Badge
                  variant="outline"
                  className={
                    installJob.status === "running"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : installJob.status === "completed"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400"
                  }
                >
                  {installJob.status}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="font-mono text-[11px] break-all">
              {installJob?.command}
            </DialogDescription>
          </DialogHeader>
          {installJob && (
            <div className="space-y-3">
              {installJob.status === "running" && (
                <Progress value={100} className="h-1 animate-pulse" />
              )}
              <div
                ref={logBoxRef}
                className="max-h-[50vh] overflow-y-auto overflow-x-hidden rounded-md border bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200"
                aria-live="polite"
              >
                {installJob.logs.map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      "wrap-anywhere",
                      line.includes("✔")
                        ? "text-emerald-400"
                        : line.includes("✘") || line.toLowerCase().includes("error")
                          ? "text-rose-400"
                          : undefined
                    )}
                  >
                    {line}
                  </div>
                ))}
                {installJob.status === "running" && (
                  <div className="text-zinc-500">
                    <Loader2 className="mr-1 inline size-3 animate-spin" />
                    running…
                  </div>
                )}
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>
                  started {timeAgo(installJob.startedAt)}
                  {installJob.finishedAt && installJob.exitCode != null
                    ? ` · exit ${installJob.exitCode}`
                    : ""}
                </span>
                {installJob.status === "completed" && (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    statuses refresh automatically after install
                  </span>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SummaryCard({
  icon,
  title,
  value,
  caption,
  ok,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  caption: string;
  ok: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            ok
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{title}</p>
          <p className="text-lg font-semibold leading-tight">{value}</p>
          <p className="truncate text-[11px] text-muted-foreground">{caption}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  id,
  icon,
  title,
  count,
  hint,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <h3 id={id} className="text-sm font-semibold tracking-tight">
        {title}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          ({count})
        </span>
      </h3>
      <p className="hidden flex-1 truncate text-xs text-muted-foreground lg:block">
        — {hint}
      </p>
    </div>
  );
}

function RuntimeCard({
  row,
  onInstall,
  installing,
}: {
  row: RuntimeRow;
  onInstall: () => void;
  installing: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{row.label}</p>
            <StatusBadge installed={row.installed} />
            {row.installed && row.version && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {row.version}
              </Badge>
            )}
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {row.description}
          </p>
        </div>
        <div className="shrink-0">
          {!row.installed && row.oneClick ? (
            <Button size="sm" onClick={onInstall} disabled={installing}>
              {installing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              Install
            </Button>
          ) : !row.installed ? (
            <Button size="sm" variant="ghost" asChild>
              <a href={row.docs} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                Docs
              </a>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Split a registry sizeHint into a short size token for the Install button
 * and a longer human explanation shown beside it (wraps, never overflows).
 * "~4 GB (CUDA torch + DGL…; NVIDIA GPU required)" → { size: "~4 GB", detail: "CUDA torch + DGL…" }
 */
function splitSizeHint(hint: string): { size: string; detail: string } {
  const trimmed = hint.trim();
  if (!trimmed) return { size: "", detail: "" };
  const m = trimmed.match(
    /^(~?\s*\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)|license-gated|cluster-provided)\s*(.*)$/i
  );
  if (!m) return { size: trimmed, detail: "" };
  let detail = m[2].trim();
  detail = detail.replace(/^\(\s*/, "").replace(/\s*\)$/, "").trim();
  return { size: m[1].replace(/\s+/g, " ").trim(), detail };
}

function StatusBadge({ installed }: { installed: boolean }) {
  return installed ? (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
    >
      <CheckCircle2 className="size-3" />
      installed
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
    >
      <XCircle className="size-3" />
      missing
    </Badge>
  );
}

function EngineCard({ engine }: { engine: EngineRow }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        className="cursor-pointer select-none py-3"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        aria-expanded={open}
      >
        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          <CardTitle className="text-sm">{engine.label}</CardTitle>
          <Badge
            variant="outline"
            className={
              engine.ok
                ? "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
                : "border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-400"
            }
          >
            {engine.ok ? "self-test PASS" : "self-test FAIL"}
          </Badge>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {engine.script}
          </Badge>
          <div className="ml-auto flex flex-wrap gap-1">
            {engine.serves.map((s) => (
              <Badge key={s} variant="outline" className="text-[10px]">
                {s}
              </Badge>
            ))}
          </div>
        </div>
        {!open && (
          <CardDescription className="mt-1 line-clamp-1 text-xs">
            {engine.description}
          </CardDescription>
        )}
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">{engine.description}</p>
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Real algorithms &amp; published data
            </p>
            <ul className="space-y-1">
              {engine.algorithms.map((a) => (
                <li key={a} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 size-1 shrink-0 rounded-full bg-primary" />
                  {a}
                </li>
              ))}
            </ul>
          </div>
          {engine.provenance && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <BookOpen className="size-3" /> Provenance &amp; accuracy
              </p>
              <ul className="mb-1.5 space-y-0.5">
                {engine.provenance.refs.map((r) => (
                  <li key={r} className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500/70" />
                    {r}
                  </li>
                ))}
              </ul>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {engine.provenance.accuracy}
              </p>
            </div>
          )}
          <p className="break-all rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
            {engine.detail.slice(0, 160)}
            {engine.detail.length > 160 ? "…" : ""}
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function ToolCard({
  row,
  engines,
  onInstall,
  installing,
}: {
  row: ToolRow;
  engines: EngineRow[];
  onInstall: () => void;
  installing: boolean;
}) {
  const engine = engines.find((e) => e.key === row.builtinEngine);
  const { size, detail } = splitSizeHint(row.sizeHint ?? "");
  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{row.label}</p>
          {row.installed ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
            >
              <CheckCircle2 className="size-3" />
              native
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
            >
              <XCircle className="size-3" />
              not installed
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {row.description}
        </p>

        {/* Fallback engine row */}
        {engine && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5">
            <Info className="size-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              Fallback:
            </span>
            <Badge
              variant="outline"
              className={
                engine.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
                  : "border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-400"
              }
            >
              {ENGINE_LABELS[engine.key] ?? engine.key} · real algorithms
            </Badge>
          </div>
        )}

        <div className="flex flex-wrap items-start gap-2 pt-1">
          {row.oneClick && !row.installed && (
            <Button
              size="sm"
              onClick={onInstall}
              disabled={installing}
              className="max-w-full"
            >
              {installing ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <Download className="size-3.5 shrink-0" />
              )}
              <span className="truncate">Install {size}</span>
            </Button>
          )}
          {row.oneClick && !row.installed && detail && (
            <span
              className="min-w-0 flex-1 basis-40 text-[11px] leading-snug text-muted-foreground"
              title={detail}
            >
              {detail}
            </span>
          )}
          {row.installed && (
            <Badge variant="secondary" className="text-[10px]">
              native execution active
            </Badge>
          )}
          <Button size="sm" variant="ghost" asChild>
            <a href={row.docs} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              Docs
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Foundry platform card ───────────────────────────────────────────────────

function FoundryPlatformCard({
  foundry,
  onInstall,
  installing,
}: {
  foundry: FoundryStatusDTO;
  onInstall: () => void;
  installing: boolean;
}) {
  const { installed } = foundry;
  return (
    <section className="space-y-3" aria-labelledby="foundry-heading">
      <SectionHeader
        id="foundry-heading"
        icon={<Layers className="size-4" />}
        title="Foundry Platform (RosettaCommons)"
        count={foundry.checkpoints.length}
        hint="Official biomolecular foundation-model platform — RFD3 / MPNN family / RF3 unified through atomworks. When ready, MPNN-family jobs execute the REAL trained network."
      />
      <Card className="overflow-hidden">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">rc-foundry</p>
            {installed ? (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
              >
                <CheckCircle2 className="size-3" />
                installed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
              >
                <XCircle className="size-3" />
                not installed
              </Badge>
            )}
            {foundry.version && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{foundry.version}
              </Badge>
            )}
            {foundry.torch && (
              <Badge variant="outline" className="font-mono text-[10px]">
                torch {foundry.torch}
                {foundry.cuda ? " · CUDA" : " · CPU"}
              </Badge>
            )}
            <Button size="sm" variant="ghost" asChild className="ml-auto">
              <a
                href="https://github.com/RosettaCommons/foundry"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3.5" />
                Docs
              </a>
            </Button>
          </div>

          {installed ? (
            <>
              {/* Capabilities */}
              <div className="grid gap-2 sm:grid-cols-3">
                <FoundryCapability
                  label="MPNN family"
                  ready={foundry.capabilities.mpnn}
                  readyText="REAL trained network — LigandMPNN / ProteinMPNN / SolubleMPNN via foundry's MPNNInferenceEngine (official legacy weights)."
                  notReadyText={
                    foundry.selftestOk
                      ? "Engine imports OK but no MPNN checkpoints — run `foundry install proteinmpnn ligandmpnn solublempnn`."
                      : `Self-test failed: ${foundry.selftestDetail}`
                  }
                />
                <FoundryCapability
                  label="RFD3 (design)"
                  ready={foundry.capabilities.rfd3}
                  readyText="Checkpoint present — de-novo backbone generation available (GPU strongly recommended; diffusion is slow on CPU)."
                  notReadyText="Weights not downloaded — `foundry install rfd3` (needs ~1–2 GB + GPU for practical runtimes)."
                />
                <FoundryCapability
                  label="RF3 (folding)"
                  ready={foundry.capabilities.rf3}
                  readyText="Checkpoint present — structure prediction & designability validation."
                  notReadyText="Weights not downloaded — `foundry install rf3` (needs cuEquivariance + CUDA GPU)."
                />
              </div>

              {/* Checkpoints */}
              {foundry.checkpoints.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {foundry.checkpoints.map((c) => (
                    <Badge
                      key={c.path}
                      variant="outline"
                      className="font-mono text-[10px]"
                      title={c.path}
                    >
                      {c.name} · {c.size}
                    </Badge>
                  ))}
                </div>
              )}

              <p className="break-all rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                venv: {foundry.python}
              </p>

              <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Execution tier active: ProteinMPNN / LigandMPNN / SolubleMPNN
                  jobs on this host now run the real trained network through
                  foundry (priority over legacy repos and the built-in
                  statistical engine). Sequences land in the job workDir as
                  FASTA with a JSON result blob (incl. recovery metrics) in
                  stdout.
                </p>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                RosettaCommons&apos; central platform for biomolecular
                foundation models. One-click installs the rc-foundry wheel
                (CPU torch) plus the MPNN-family checkpoints — instantly
                upgrading inverse-folding jobs from the built-in statistical
                engine to the real trained networks. RFD3/RF3 weights can be
                added later with{" "}
                <span className="font-mono text-[10px]">
                  foundry install rfd3 rf3
                </span>{" "}
                (GPU required).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={onInstall}
                  disabled={installing}
                  className="max-w-full"
                >
                  {installing ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Download className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">
                    Install
                    <span className="ml-1 text-[10px] opacity-70">~1.9 GB</span>
                  </span>
                </Button>
                <span className="min-w-0 flex-1 basis-40 text-[11px] leading-snug text-muted-foreground">
                  Already have foundry elsewhere? Point{" "}
                  <span className="font-mono text-[10px]">$FOUNDRY_PYTHON</span>{" "}
                  at that venv&apos;s python.
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function FoundryCapability({
  label,
  ready,
  readyText,
  notReadyText,
}: {
  label: string;
  ready: boolean;
  readyText: string;
  notReadyText: string;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        ready
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-dashed bg-muted/30"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {ready ? (
          <CheckCircle2 className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle className="size-3 shrink-0 text-muted-foreground" />
        )}
        <p className="text-[11px] font-medium">{label}</p>
        <span className="ml-auto text-[10px] font-medium text-muted-foreground">
          {ready ? "ready" : "missing weights"}
        </span>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {ready ? readyText : notReadyText}
      </p>
    </div>
  );
}

function RecentInstalls({
  jobs,
  onOpen,
}: {
  jobs: InstallJobDTO[];
  onOpen: (job: InstallJobDTO) => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <section className="space-y-2" aria-labelledby="installs-heading">
      <div className="flex items-center gap-2">
        <button
          className="flex items-center gap-1 text-sm font-semibold tracking-tight"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          <span id="installs-heading">Recent Installs</span>
          <span className="text-xs font-normal text-muted-foreground">
            ({jobs.length})
          </span>
        </button>
      </div>
      {open && (
        <div className="max-h-72 overflow-y-auto">
          <div className="space-y-2">
            {jobs.map((job) => (
              <button
                key={job.id}
                className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => onOpen(job)}
              >
                <Terminal className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{job.label}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {job.command}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {timeAgo(job.startedAt)}
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      job.status === "running"
                        ? "border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
                        : job.status === "completed"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
                          : "border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-400"
                    }
                  >
                    {job.status}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
