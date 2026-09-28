"use client";

// Cluster Execution panel — SSH/HPC dispatch lane (cryoflow-style).
//
// Sections:
//   ① Connections   — CRUD + Test & Probe (identity, python, slurm, tools)
//   ② Probe result  — per-connection environment card
//   ③ Launcher      — pick a comp tool, fill params, choose direct/slurm,
//                     POST /api/tools/run { cluster } → async job
//   ④ Cluster jobs  — live polling (2.5s) of GET /api/tools/jobs, filtered to
//                     cluster-dispatched rows: phase chips, log tails, Stop,
//                     and "View output" via the shared OutputViewerDialog
//                     (outputs sync back to local disk, so the viewer works
//                     unchanged).
//
// Backend contracts: src/lib/cluster/types.ts (ClusterConnectionDTO,
// ClusterProbeDTO, ClusterJobInfoDTO) — verified E2E against the local test
// cluster (mini-services/mock-cluster, :3022 foundry/demo).

import * as React from "react";
import { useAppStore } from "@/lib/store";
import { COMP_TOOLS, getCompTool } from "@/lib/tools";
import type { CompParamField } from "@/lib/tools";
import type { ToolJobDTO } from "@/lib/types";
import type {
  ClusterConnectionDTO,
  ClusterProbeDTO,
  ClusterSubmitMode,
} from "@/lib/cluster/types";
import { OutputViewerDialog } from "@/components/viewers/output-viewer-dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Server,
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  Terminal,
  Cpu,
  Globe,
  ChevronDown,
  ChevronRight,
  FileBox,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtElapsed(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}

const PHASE_STYLE: Record<string, string> = {
  staging: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  running: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  syncing: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  cancelled: "bg-muted text-muted-foreground",
};

/** Draft form state for the connection editor. */
interface ConnDraft {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: string;
  password: string;
  privateKeyPath: string;
  passphrase: string;
  remoteRoot: string;
  remoteToolsDir: string;
  envLines: string;
  useSlurm: boolean;
  slurmPartition: string;
  slurmTimeMin: string;
}

const EMPTY_DRAFT: ConnDraft = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "password",
  password: "",
  privateKeyPath: "",
  passphrase: "",
  remoteRoot: "~/foundry-lab",
  remoteToolsDir: "~/foundry-lab/tools",
  envLines: "",
  useSlurm: false,
  slurmPartition: "",
  slurmTimeMin: "",
};

function draftFromConn(c: ClusterConnectionDTO): ConnDraft {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: String(c.port),
    username: c.username,
    authMethod: c.authMethod,
    password: "",
    privateKeyPath: c.privateKeyPath ?? "",
    passphrase: "",
    remoteRoot: c.remoteRoot,
    remoteToolsDir: c.remoteToolsDir,
    envLines: c.envLines.join("\n"),
    useSlurm: c.useSlurm,
    slurmPartition: c.slurmPartition ?? "",
    slurmTimeMin: c.slurmTimeMin != null ? String(c.slurmTimeMin) : "",
  };
}

/** true when the job row was dispatched to a cluster (DTO cluster block or
 * the persisted _meta.cluster marker). */
function isClusterJob(j: ToolJobDTO): boolean {
  if (j.cluster != null) return true;
  const meta = j.params?._meta as { cluster?: boolean } | undefined;
  return meta?.cluster === true;
}

// ── panel ───────────────────────────────────────────────────────────────────

export function ClusterPanel() {
  const toast = useAppStore((s) => s.toast);

  // connections
  const [connections, setConnections] = React.useState<ClusterConnectionDTO[]>([]);
  const [loadingConns, setLoadingConns] = React.useState(true);
  const [draft, setDraft] = React.useState<ConnDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testingId, setTestingId] = React.useState<string | null>(null);

  // probe result for one connection
  const [probeFor, setProbeFor] = React.useState<{ connId: string; probe: ClusterProbeDTO } | null>(null);

  // launcher
  const [toolKey, setToolKey] = React.useState<string>(COMP_TOOLS[0]?.key ?? "alphafold");
  const [paramValues, setParamValues] = React.useState<Record<string, string | number | boolean>>({});
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [launchConnId, setLaunchConnId] = React.useState<string>("");
  const [mode, setMode] = React.useState<ClusterSubmitMode>("slurm");
  const [partition, setPartition] = React.useState<string>("");
  const [gpus, setGpus] = React.useState(1);
  const [cpusPerTask, setCpusPerTask] = React.useState(4);
  const [timeLimit, setTimeLimit] = React.useState("");
  const [launching, setLaunching] = React.useState(false);

  // jobs
  const [jobs, setJobs] = React.useState<ToolJobDTO[]>([]);
  const [expandedJob, setExpandedJob] = React.useState<string | null>(null);
  const [viewerJob, setViewerJob] = React.useState<ToolJobDTO | null>(null);
  const [stoppingId, setStoppingId] = React.useState<string | null>(null);

  // ── data loading ──────────────────────────────────────────────────────────
  const loadConnections = React.useCallback(async () => {
    try {
      const res = await fetch("/api/cluster/connections", { cache: "no-store" });
      const data = await res.json();
      const list: ClusterConnectionDTO[] = Array.isArray(data.connections) ? data.connections : [];
      setConnections(list);
      // keep the launcher's connection select valid
      setLaunchConnId((cur) => {
        if (cur && list.some((c) => c.id === cur)) return cur;
        return list[0]?.id ?? "";
      });
    } catch (e) {
      toast({ title: "Failed to load cluster connections", description: String(e), variant: "destructive" });
    } finally {
      setLoadingConns(false);
    }
  }, [toast]);

  React.useEffect(() => { void loadConnections(); }, [loadConnections]);

  // Reset launcher params whenever the tool changes.
  React.useEffect(() => {
    const def = getCompTool(toolKey);
    const vals: Record<string, string | number | boolean> = {};
    for (const f of def?.paramFields ?? []) {
      vals[f.key] = f.default as string | number | boolean;
    }
    setParamValues(vals);
    setShowAdvanced(false);
  }, [toolKey]);

  // Default mode/partition follow the selected connection's stored prefs.
  const launchConn = connections.find((c) => c.id === launchConnId);
  React.useEffect(() => {
    if (!launchConn) return;
    setMode(launchConn.useSlurm ? "slurm" : "direct");
    setPartition(launchConn.slurmPartition ?? "");
  }, [launchConn]);

  const probePartitions = launchConn?.lastProbe?.slurm.partitions ?? [];

  // ── jobs polling ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/tools/jobs", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data)) {
          // cluster-dispatched jobs only
          setJobs((data as ToolJobDTO[]).filter(isClusterJob));
        }
      } catch { /* transient */ }
    };
    void tick();
    const iv = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // ── actions ───────────────────────────────────────────────────────────────
  const saveConnection = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.host.trim() || !draft.username.trim()) {
      toast({ title: "Missing fields", description: "Name, host and username are required.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        id: draft.id,
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: parseInt(draft.port, 10) || 22,
        username: draft.username.trim(),
        authMethod: draft.authMethod,
        remoteRoot: draft.remoteRoot.trim() || "~/foundry-lab",
        remoteToolsDir: draft.remoteToolsDir.trim() || "~/foundry-lab/tools",
        envLines: draft.envLines.split("\n").map((l) => l.trim()).filter(Boolean),
        useSlurm: draft.useSlurm,
        slurmPartition: draft.slurmPartition.trim() || null,
        slurmTimeMin: draft.slurmTimeMin.trim() ? parseInt(draft.slurmTimeMin, 10) : null,
      };
      if (draft.privateKeyPath.trim()) body.privateKeyPath = draft.privateKeyPath.trim();
      if (draft.id) {
        // secrets: only send when the user typed something (empty = clear,
        // absent = keep stored)
        if (draft.password !== "") body.password = draft.password;
        if (draft.passphrase !== "") body.passphrase = draft.passphrase;
      } else {
        body.password = draft.password;
        body.passphrase = draft.passphrase;
      }
      const res = await fetch(
        draft.id ? `/api/cluster/connections/${draft.id}` : "/api/cluster/connections",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: draft.id ? "Connection updated" : "Connection saved", variant: "success" });
      setDraft(null);
      await loadConnections();
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const deleteConnection = async (c: ClusterConnectionDTO) => {
    if (!window.confirm(`Delete connection "${c.name}"?`)) return;
    try {
      await fetch(`/api/cluster/connections/${c.id}`, { method: "DELETE" });
      toast({ title: "Connection deleted", variant: "success" });
      if (probeFor?.connId === c.id) setProbeFor(null);
      await loadConnections();
    } catch (e) {
      toast({ title: "Delete failed", description: String(e), variant: "destructive" });
    }
  };

  const testConnection = async (c: ClusterConnectionDTO) => {
    setTestingId(c.id);
    try {
      const res = await fetch(`/api/cluster/connections/${c.id}/test`, { method: "POST" });
      const data = await res.json();
      const probe = data.probe as ClusterProbeDTO | undefined;
      if (probe) {
        setProbeFor({ connId: c.id, probe });
        toast({
          title: probe.ok ? `Connected to ${c.name}` : `Probe failed for ${c.name}`,
          description: probe.ok ? `Slurm: ${probe.slurm.available ? "yes" : "no"} · ${probe.tools.filter((t) => t.installed).length}/${probe.tools.length} tools` : (probe.error ?? "SSH unreachable"),
          variant: probe.ok ? "success" : "destructive",
        });
      }
      await loadConnections(); // lastProbe persisted server-side
    } catch (e) {
      toast({ title: "Test failed", description: String(e), variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  const launch = async () => {
    if (!launchConnId) {
      toast({ title: "No connection", description: "Add a cluster connection first.", variant: "destructive" });
      return;
    }
    const def = getCompTool(toolKey);
    if (!def) return;
    setLaunching(true);
    try {
      // only send non-default / filled params
      const params: Record<string, unknown> = {};
      for (const f of def.paramFields) {
        const v = paramValues[f.key];
        if (v === "" || v == null) continue;
        params[f.key] = v;
      }
      const cluster: Record<string, unknown> = {
        connectionId: launchConnId,
        mode,
      };
      if (mode === "slurm") {
        if (partition.trim()) cluster.partition = partition.trim();
        cluster.gpus = gpus;
        cluster.cpusPerTask = cpusPerTask;
        if (timeLimit.trim()) cluster.timeLimitMin = parseInt(timeLimit, 10);
      }
      const res = await fetch("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: toolKey, params, cluster }),
      });
      const data = await res.json();
      if (!res.ok && !data.id && !data.job) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const job: ToolJobDTO | undefined = data.job ?? data;
      toast({
        title: `${def.label} dispatched to cluster`,
        description: `user@host · ${mode === "slurm" ? `Slurm · ${partition || "default partition"}` : "direct"} — poll below for live logs.`,
        variant: "success",
      });
      if (job?.id) setExpandedJob(job.id);
      // immediate refresh
      const jr = await fetch("/api/tools/jobs", { cache: "no-store" });
      const jd = await jr.json();
      if (Array.isArray(jd)) setJobs((jd as ToolJobDTO[]).filter(isClusterJob));
    } catch (e) {
      toast({ title: "Launch failed", description: String(e), variant: "destructive" });
    } finally {
      setLaunching(false);
    }
  };

  const stopJob = async (job: ToolJobDTO) => {
    setStoppingId(job.id);
    try {
      await fetch(`/api/tools/jobs/${job.id}/stop`, { method: "POST" });
      toast({ title: "Stop requested", description: `${job.tool} — cancelling on the cluster.`, variant: "success" });
    } catch (e) {
      toast({ title: "Stop failed", description: String(e), variant: "destructive" });
    } finally {
      setStoppingId(null);
    }
  };

  const hasTestClusterQuickAdd = !connections.some((c) => c.host === "127.0.0.1" && c.port === 3022);
  const activeDef = getCompTool(toolKey);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Server className="size-6 text-emerald-600" /> Cluster Execution
            </h1>
            <p className="text-sm text-muted-foreground">
              Run external tools on SSH-reachable HPC clusters — direct or via Slurm. Outputs sync back automatically.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => { void loadConnections(); }}
            aria-label="Refresh cluster state"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {/* ① Connections */}
        <section className="space-y-3" aria-label="Cluster connections">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Connections
          </h2>

          {loadingConns ? (
            <div className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/30 p-8 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading connections…
            </div>
          ) : connections.length === 0 && !draft ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                <Server className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">No cluster connections yet</p>
                <p className="max-w-md text-xs text-muted-foreground">
                  Add an SSH-reachable cluster (login node). Foundry Lab stages inputs, generates the
                  submission script (direct <code className="font-mono">setsid</code> wrapper or{" "}
                  <code className="font-mono">sbatch</code>), polls state over one batched SSH channel,
                  and syncs outputs back to this workspace.
                </p>
                {hasTestClusterQuickAdd && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        ...EMPTY_DRAFT,
                        name: "Local Test Cluster",
                        host: "127.0.0.1",
                        port: "3022",
                        username: "foundry",
                        password: "demo",
                        useSlurm: true,
                        slurmPartition: "gpu",
                      })
                    }
                  >
                    <Zap className="mr-1 size-3.5" /> Connect to the local test cluster (:3022)
                  </Button>
                )}
                <Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                  <Plus className="mr-1 size-3.5" /> New connection
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-3">
                {connections.map((c) => {
                  const p = c.lastProbe;
                  const toolCount = p ? `${p.tools.filter((t) => t.installed).length}/${p.tools.length}` : null;
                  return (
                    <Card key={c.id}>
                      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "inline-block size-2 shrink-0 rounded-full",
                                p == null ? "bg-muted-foreground/40" : p.ok ? "bg-emerald-500" : "bg-rose-500",
                              )}
                              aria-label={p == null ? "never tested" : p.ok ? "reachable" : "unreachable"}
                            />
                            <p className="truncate text-sm font-semibold">{c.name}</p>
                            <Badge variant="outline" className="shrink-0">{c.authMethod}</Badge>
                            {p?.slurm.available && (
                              <Badge className="shrink-0 bg-emerald-500/10 text-emerald-600">Slurm</Badge>
                            )}
                          </div>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            {c.username}@{c.host}:{c.port} · {c.remoteRoot}
                            {toolCount ? ` · ${toolCount} tools` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => void testConnection(c)} disabled={testingId === c.id}>
                            {testingId === c.id ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Globe className="mr-1 size-3.5" />}
                            Test
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDraft(draftFromConn(c))} aria-label={`Edit ${c.name}`}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void deleteConnection(c)} aria-label={`Delete ${c.name}`}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              {!draft && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                    <Plus className="mr-1 size-3.5" /> New connection
                  </Button>
                  {hasTestClusterQuickAdd && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDraft({
                          ...EMPTY_DRAFT,
                          name: "Local Test Cluster",
                          host: "127.0.0.1",
                          port: "3022",
                          username: "foundry",
                          password: "demo",
                          useSlurm: true,
                          slurmPartition: "gpu",
                        })
                      }
                    >
                      <Zap className="mr-1 size-3.5" /> Local test cluster (:3022)
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {/* Connection editor */}
          {draft && (
            <Card className="border-emerald-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{draft.id ? "Edit connection" : "New connection"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-name">Name</Label>
                    <Input id="cc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Lab GPU cluster" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-auth">Authentication</Label>
                    <Select value={draft.authMethod} onValueChange={(v) => setDraft({ ...draft, authMethod: v })}>
                      <SelectTrigger id="cc-auth"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">Password</SelectItem>
                        <SelectItem value="key">Private key</SelectItem>
                        <SelectItem value="agent">SSH agent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-host">Host</Label>
                    <Input id="cc-host" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="login.hpc.lab.edu" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-port">Port</Label>
                    <Input id="cc-port" type="number" value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-user">Username</Label>
                    <Input id="cc-user" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="foundry" />
                  </div>
                  {draft.authMethod === "password" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="cc-pass">Password</Label>
                      <Input id="cc-pass" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder={draft.id ? "stored — leave blank to keep" : "password"} />
                    </div>
                  )}
                  {draft.authMethod === "key" && (
                    <>
                      <div className="grid gap-1.5">
                        <Label htmlFor="cc-key">Private key path (on this host)</Label>
                        <Input id="cc-key" value={draft.privateKeyPath} onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="cc-passph">Passphrase</Label>
                        <Input id="cc-passph" type="password" value={draft.passphrase} onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })} placeholder={draft.id ? "stored — leave blank to keep" : "optional"} />
                      </div>
                    </>
                  )}
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-root">Remote job root</Label>
                    <Input id="cc-root" value={draft.remoteRoot} onChange={(e) => setDraft({ ...draft, remoteRoot: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-tools">Remote tools dir</Label>
                    <Input id="cc-tools" value={draft.remoteToolsDir} onChange={(e) => setDraft({ ...draft, remoteToolsDir: e.target.value })} />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="cc-env">Environment lines (sourced before every run)</Label>
                  <Textarea
                    id="cc-env"
                    rows={3}
                    value={draft.envLines}
                    onChange={(e) => setDraft({ ...draft, envLines: e.target.value })}
                    placeholder={"module load alphafold2\nconda activate myenv"}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex items-center gap-2">
                    <Switch id="cc-slurm" checked={draft.useSlurm} onCheckedChange={(v) => setDraft({ ...draft, useSlurm: v })} />
                    <Label htmlFor="cc-slurm">Slurm default</Label>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-part">Default partition</Label>
                    <Input id="cc-part" value={draft.slurmPartition} onChange={(e) => setDraft({ ...draft, slurmPartition: e.target.value })} placeholder="gpu" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="cc-time">Walltime (min, optional)</Label>
                    <Input id="cc-time" type="number" value={draft.slurmTimeMin} onChange={(e) => setDraft({ ...draft, slurmTimeMin: e.target.value })} placeholder="cluster default" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
                  <Button size="sm" onClick={() => void saveConnection()} disabled={saving}>
                    {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 size-3.5" />}
                    {draft.id ? "Save changes" : "Save connection"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        <Separator />

        {/* ② Probe result */}
        {probeFor && probeFor.probe && (
          <section className="space-y-3" aria-label="Probe result">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Probe · {connections.find((c) => c.id === probeFor.connId)?.name ?? probeFor.connId.slice(0, 8)}
            </h2>
            {probeFor.probe.ok ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="font-mono">{probeFor.probe.user}@{probeFor.probe.hostname}</Badge>
                  <span className="font-mono">{probeFor.probe.uname.slice(0, 48)}</span>
                  <Badge variant="outline">{probeFor.probe.durationMs} ms</Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MiniFact
                    ok={probeFor.probe.python3?.ok}
                    title="Python 3"
                    detail={probeFor.probe.python3 ? `${probeFor.probe.python3.version} · numpy ${probeFor.probe.python3.numpy ? "✓" : "✗"}` : "—"}
                  />
                  <MiniFact
                    ok={probeFor.probe.slurm?.available}
                    title="Slurm"
                    detail={
                      probeFor.probe.slurm?.available
                        ? probeFor.probe.slurm.partitions.map((p) => p.name).join(" · ") || "available"
                        : "not installed"
                    }
                  />
                  <MiniFact
                    ok={probeFor.probe.conda?.ok}
                    title="Conda"
                    detail={probeFor.probe.conda?.ok ? probeFor.probe.conda.root : "—"}
                  />
                  <MiniFact
                    ok={probeFor.probe.gpus?.length ? true : false}
                    title="GPUs"
                    detail={
                      probeFor.probe.gpus?.length
                        ? probeFor.probe.gpus.map((g) => `${g.count}× ${g.model}`).join(", ")
                        : "none visible"
                    }
                  />
                </div>
                {probeFor.probe.slurm?.partitions?.length ? (
                  <Card>
                    <CardContent className="p-4">
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">Partitions</p>
                      <div className="flex flex-wrap gap-2">
                        {probeFor.probe.slurm.partitions.map((p) => (
                          <Badge key={p.name} variant="outline" className="font-mono text-xs">
                            {p.name} · {p.nodes}N{p.gpusPerNode ? ` · ${p.gpusPerNode} GPU/N` : ""} · {p.maxTime}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
                <Card>
                  <CardContent className="p-4">
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">
                      Tools on this cluster ({probeFor.probe.tools.filter((t) => t.installed).length}/{probeFor.probe.tools.length})
                    </p>
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {probeFor.probe.tools.map((t) => (
                        <div key={t.key} className="flex items-center gap-1.5 text-xs">
                          {t.installed ? (
                        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
                      ) : (
                        <XCircle className="size-3.5 shrink-0 text-rose-500" />
                      )}
                          <span className={cn("truncate", !t.installed && "text-muted-foreground")}>{t.label}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
                <p className="font-medium text-rose-600 dark:text-rose-400">Probe failed</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {probeFor.probe.error ?? "SSH connection could not be established."}
                </p>
                <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
                  <li>Check host/port and that the login node allows password or key auth.</li>
                  <li>If 2FA is required, connect once from a terminal to cache the session.</li>
                  <li>Env lines run in a login shell — a failing <code className="font-mono">module load</code> line can break every command.</li>
                </ul>
              </div>
            )}
          </section>
        )}

        <Separator />

        {/* ③ Launcher */}
        <section className="space-y-3" aria-label="Launch a tool on the cluster">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Launch a tool on the cluster
          </h2>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="lc-tool">Tool</Label>
                  <Select value={toolKey} onValueChange={setToolKey}>
                    <SelectTrigger id="lc-tool"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COMP_TOOLS.map((t) => (
                        <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {activeDef && <p className="text-[11px] text-muted-foreground">{activeDef.description}</p>}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="lc-conn">Connection</Label>
                  <Select value={launchConnId} onValueChange={setLaunchConnId} disabled={connections.length === 0}>
                    <SelectTrigger id="lc-conn">
                      <SelectValue placeholder={connections.length ? "Pick a connection" : "No connections yet"} />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} ({c.username}@{c.host})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* dynamic params */}
              {activeDef && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {activeDef.paramFields.filter((f) => !f.advanced).map((f) => (
                    <LauncherParam
                      key={f.key}
                      field={f}
                      value={paramValues[f.key]}
                      onChange={(v) => setParamValues((pv) => ({ ...pv, [f.key]: v }))}
                    />
                  ))}
                </div>
              )}
              {activeDef && activeDef.paramFields.some((f) => f.advanced) && (
                <div>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowAdvanced((s) => !s)}
                  >
                    {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Advanced parameters
                  </button>
                  {showAdvanced && (
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {activeDef.paramFields.filter((f) => f.advanced).map((f) => (
                        <LauncherParam
                          key={f.key}
                          field={f}
                          value={paramValues[f.key]}
                          onChange={(v) => setParamValues((pv) => ({ ...pv, [f.key]: v }))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* cluster target */}
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>Submission mode</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <ModeCard active={mode === "direct"} onClick={() => setMode("direct")} title="Direct" desc="setsid on the login node" />
                      <ModeCard active={mode === "slurm"} onClick={() => setMode("slurm")} title="Slurm" desc="submit via sbatch" />
                    </div>
                  </div>
                  {mode === "slurm" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor="lc-part">Partition</Label>
                        {probePartitions.length > 0 ? (
                          <Select value={partition} onValueChange={setPartition}>
                            <SelectTrigger id="lc-part"><SelectValue placeholder="default" /></SelectTrigger>
                            <SelectContent>
                              {probePartitions.map((p) => (
                                <SelectItem key={p.name} value={p.name}>
                                  {p.name} · {p.gpusPerNode ? `${p.gpusPerNode} GPU/N` : "CPU"}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input id="lc-part" value={partition} onChange={(e) => setPartition(e.target.value)} placeholder="gpu (test first to list)" />
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="lc-gpus">GPUs</Label>
                        <div className="flex items-center gap-2">
                          <Button type="button" size="sm" variant="outline" onClick={() => setGpus((g) => Math.max(1, g - 1))} aria-label="Fewer GPUs">−</Button>
                          <span className="w-6 text-center text-sm font-semibold">{gpus}</span>
                          <Button type="button" size="sm" variant="outline" onClick={() => setGpus((g) => Math.min(8, g + 1))} aria-label="More GPUs">+</Button>
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="lc-cpu">CPUs / task</Label>
                        <Input id="lc-cpu" type="number" min={1} value={cpusPerTask} onChange={(e) => setCpusPerTask(parseInt(e.target.value, 10) || 4)} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="lc-time">Walltime (min)</Label>
                        <Input id="lc-time" type="number" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="cluster default" />
                      </div>
                    </div>
                  )}
                </div>
                {launchConn && (
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    → {launchConn.username}@{launchConn.host} · {mode}
                    {mode === "slurm" ? ` · ${partition || "default"} · ${gpus} GPU` : ""} · {launchConn.remoteRoot}/jobs/{toolKey}/&lt;jobId&gt;
                  </p>
                )}
              </div>

              <div className="flex justify-end">
                <Button onClick={() => void launch()} disabled={launching || connections.length === 0}>
                  {launching ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Play className="mr-1 size-4" />}
                  Run on cluster
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        <Separator />

        {/* ④ Cluster jobs */}
        <section className="space-y-3" aria-label="Cluster jobs">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Cluster jobs
          </h2>
          {jobs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
              No cluster jobs yet — launch a tool above.
            </div>
          ) : (
            <div className="grid gap-3">
              {jobs.map((job) => {
                const c = job.cluster;
                const phase = c?.phase ?? (job.status === "completed" ? "done" : job.status === "failed" ? "failed" : "running");
                const isLive = ["staging", "running", "syncing"].includes(phase);
                const expanded = expandedJob === job.id;
                return (
                  <Card key={job.id}>
                    <CardContent className="p-4">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setExpandedJob(expanded ? null : job.id)}
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                          <Cpu className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm font-semibold">{job.tool}</span>
                          <Badge className={cn("shrink-0", PHASE_STYLE[phase] ?? "")}>
                            {phase === "running" && <Loader2 className="mr-1 size-3 animate-spin" />}
                            {phase}
                          </Badge>
                          {c && (
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {c.user}@{c.host} · {c.mode}
                              {c.slurmId ? ` · Slurm ${c.slurmId}` : c.pid ? ` · pid ${c.pid}` : ""}
                            </span>
                          )}
                        </button>
                        <div className="flex items-center gap-1.5">
                          {isLive && (
                            <Button size="sm" variant="outline" onClick={() => void stopJob(job)} disabled={stoppingId === job.id}>
                              {stoppingId === job.id ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Square className="mr-1 size-3.5" />}
                              Stop
                            </Button>
                          )}
                          {phase === "done" && (
                            <Button size="sm" variant="outline" onClick={() => setViewerJob(job)}>
                              <FileBox className="mr-1 size-3.5" /> View output
                            </Button>
                          )}
                        </div>
                      </div>

                      {c && (
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                          <span>elapsed {fmtElapsed(job.startedAt)}</span>
                          {c.syncedFiles?.length > 0 && <span>{c.syncedFiles.length} files · {fmtBytes(c.syncedBytes ?? 0)} synced</span>}
                          {job.exitCode != null && <span>exit {job.exitCode}</span>}
                          {c.slurmState && <span>slurm: {c.slurmState}</span>}
                        </div>
                      )}

                      {expanded && (
                        <div className="mt-3 space-y-2">
                          {job.command && (
                            <div className="rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
                              $ {job.command}
                            </div>
                          )}
                          {(c?.logTailOut || job.stdout) && (
                            <div className="max-h-72 overflow-y-auto rounded-md border bg-black/90 p-3">
                              <p className="mb-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-emerald-400">
                                <Terminal className="size-3" /> remote log tail
                              </p>
                              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-emerald-300/90">
                                {(c?.logTailOut || job.stdout || "").slice(-4000)}
                              </pre>
                              {(c?.logTailErr || (phase === "failed" ? job.stderr : "")) && (
                                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-rose-400">
                                  {(c?.logTailErr || job.stderr || "").slice(-2000)}
                                </pre>
                              )}
                            </div>
                          )}
                          {c?.error && (
                            <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-600 dark:text-rose-400">
                              {c.error}
                            </p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Output viewer — outputs synced back to local disk, so the shared
          dialog works unchanged (it fetches via /api/tools/jobs/[id]/file). */}
      <OutputViewerDialog
        job={viewerJob}
        open={viewerJob != null}
        onClose={() => setViewerJob(null)}
      />
    </div>
  );
}

// ── small building blocks ───────────────────────────────────────────────────

function MiniFact({ ok, title, detail }: { ok: boolean | null | undefined; title: string; detail: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5">
          {ok ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-muted-foreground" />}
          <p className="text-xs font-semibold">{title}</p>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={detail}>{detail}</p>
      </CardContent>
    </Card>
  );
}

function ModeCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
        active
          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      <span className="block font-semibold">{title}</span>
      <span className="block text-[10px]">{desc}</span>
    </button>
  );
}

/** One launcher param field (simplified inspector ParamField). */
function LauncherParam({
  field,
  value,
  onChange,
}: {
  field: CompParamField;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const val = value ?? field.default;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`lp-${field.key}`} className="text-xs">
        {field.label}
        {field.required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {field.type === "bool" ? (
        <div className="flex items-center gap-2">
          <Switch id={`lp-${field.key}`} checked={val === true} onCheckedChange={(v) => onChange(v)} />
          <span className="text-xs text-muted-foreground">{val === true ? "on" : "off"}</span>
        </div>
      ) : field.type === "select" && field.options ? (
        <Select value={String(val)} onValueChange={(v) => onChange(v)}>
          <SelectTrigger id={`lp-${field.key}`} className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "number" ? (
        <Input
          id={`lp-${field.key}`}
          type="number"
          className="h-8 text-xs"
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(val ?? 0)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
      ) : (
        <Input
          id={`lp-${field.key}`}
          className="h-8 text-xs"
          value={String(val ?? "")}
          placeholder={field.hint}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.hint && field.type !== "text" && field.type !== "path" && (
        <p className="text-[10px] text-muted-foreground">{field.hint}</p>
      )}
    </div>
  );
}
