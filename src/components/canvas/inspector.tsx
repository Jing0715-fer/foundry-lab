"use client";

import * as React from "react";
import {
  Bot,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Database,
  FileBox,
  ArrowRightToLine,
  Flag,
  Box,
  FlaskConical,
  X,
  Server,
  Loader2,
  Play,
  Trash2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Grid3X3,
  Table2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import { withHistorySuppressed } from "@/lib/history-apply";
import { SweepDialog } from "./sweep-dialog";
import { SweepCompareDialog } from "./sweep-compare-dialog";
import { NODE_COLORS, nodeSpec } from "@/lib/workflow-catalog";
import type { NodeDTO, NodeSpec, ParamSchema, AgentDTO } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { OutputViewerDialog } from "@/components/viewers/output-viewer-dialog";
import { InlineResults, type ResultExecutor } from "@/components/viewers/inline-results";
import type { ToolJobDTO } from "@/lib/types";
import { COMP_TOOLS } from "@/lib/tools";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import ReactMarkdown from "react-markdown";

/** Render the lucide icon for a spec.icon string. */
function SpecIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  switch (name) {
    case "bot":
      return <Bot className={className} />;
    case "square-pen":
      return <SquarePen className={className} />;
    case "users":
      return <Users className={className} />;
    case "book-open":
      return <BookOpen className={className} />;
    case "cpu":
      return <Cpu className={className} />;
    case "database":
      return <Database className={className} />;
    case "arrow-right-to-line":
      return <ArrowRightToLine className={className} />;
    case "flag":
      return <Flag className={className} />;
    default:
      return <Box className={className} />;
  }
}

const STATUS_STYLES: Record<string, string> = {
  idle: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
  running: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 border-cyan-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
};

/** Fire one merged PATCH body. Module-level so the unmount cleanup can use
 *  it without re-binding (it touches nothing reactive). */
function flushPendingPatch(id: string, body: Record<string, unknown>): void {
  void (async () => {
    try {
      const res = await fetch(`/api/workflow/nodes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // The server is the source of truth for this node's name/params
      // again — drop the dirty mark that protected them from the poll.
      if (res.ok) useAppStore.getState().clearNodeDirty(id);
    } catch {
      /* swallow — optimistic state already applied; retried on next edit */
    }
  })();
}

/** Debounced PATCH for node updates.
 *
 *  One pending body + timer PER NODE: a rename followed within the debounce
 *  window by a param edit MERGES into a single PATCH instead of cancelling
 *  the rename (the old single-timer version silently dropped the earlier
 *  field). Successful PATCHes also clear the node's dirty mark so the 3s
 *  status poll may resume merging server rows (see store.mergeNodes). */
function useDebouncedPatch() {
  const pending = React.useRef(
    new Map<
      string,
      { body: Record<string, unknown>; timer: ReturnType<typeof setTimeout> | null }
    >(),
  );

  const patch = React.useCallback(
    (id: string, body: Record<string, unknown>, delay = 350) => {
      const entry =
        pending.current.get(id) ?? { body: {} as Record<string, unknown>, timer: null };
      // Merge the new fields over the not-yet-flushed body (later edits of
      // the SAME field win, different fields accumulate).
      entry.body = { ...entry.body, ...body };
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        pending.current.delete(id);
        flushPendingPatch(id, entry.body);
      }, delay);
      pending.current.set(id, entry);
    },
    [],
  );

  // Flush any still-pending bodies when the inspector unmounts (selection
  // cleared / panel switched) so the last keystroke isn't lost to the timer.
  React.useEffect(() => {
    const map = pending.current;
    return () => {
      for (const [id, entry] of map) {
        if (entry.timer) clearTimeout(entry.timer);
        flushPendingPatch(id, entry.body);
      }
      map.clear();
    };
  }, []);

  return patch;
}

/** Agent picker — used for agent nodes' refId param. */
function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: AgentDTO[];
  value: string;
  onChange: (v: string) => void;
}) {
  const agentsLoading = useAppStore((s) => s.agentsLoading);
  return (
    <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
      <SelectTrigger className="w-full" size="sm">
        <SelectValue placeholder={agentsLoading ? "Loading agents…" : "Pick an agent"} />
      </SelectTrigger>
      <SelectContent>
        {!agentsLoading && agents.length === 0 ? (
          <SelectItem value="__none__">No agents — create one first</SelectItem>
        ) : (
          <>
            <SelectItem value="__none__">— none —</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.title}
              </SelectItem>
            ))}
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/** Render one ParamSchema field. */
function ParamField({
  param,
  value,
  onChange,
  agents,
}: {
  param: ParamSchema;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
  agents: AgentDTO[];
}) {
  const v = value ?? param.default;

  switch (param.type) {
    case "number":
      return (
        <Input
          type="number"
          value={typeof v === "number" ? v : Number(v) || 0}
          min={param.min}
          max={param.max}
          step={param.step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-8 text-sm"
        />
      );
    case "select":
      return (
        <Select value={String(v ?? "")} onValueChange={onChange}>
          <SelectTrigger className="w-full" size="sm">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(param.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "bool":
      return (
        <div className="flex h-8 items-center">
          <Switch checked={Boolean(v)} onCheckedChange={onChange} />
          <span className="ml-2 text-xs text-muted-foreground">
            {Boolean(v) ? "on" : "off"}
          </span>
        </div>
      );
    case "textarea":
      return (
        <Textarea
          value={String(v ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.placeholder}
          className="min-h-20 text-sm"
        />
      );
    case "text":
    case "path":
      return (
        <Input
          type="text"
          value={String(v ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.placeholder}
          className="h-8 text-sm"
        />
      );
    default:
      return null;
  }
}

/** A single labeled param row. */
function ParamRow({
  param,
  node,
  agents,
  onPatchParam,
}: {
  param: ParamSchema;
  node: NodeDTO;
  agents: AgentDTO[];
  onPatchParam: (key: string, value: string | number | boolean) => void;
}) {
  // For agent nodes, render the refId param as an agent picker.
  if (node.type === "agent" && param.key === "refId") {
    return (
      <div className="grid grid-cols-1 gap-1.5">
        <label className="text-xs font-medium">{param.label}</label>
        <AgentPicker
          agents={agents}
          value={String(node.params.refId ?? "")}
          onChange={(v) => onPatchParam("refId", v)}
        />
        {param.hint && <p className="text-[11px] text-muted-foreground">{param.hint}</p>}
      </div>
    );
  }

  // For the alphafold tool node, hide param fields whose prefix doesn't
  // match a legacy `param_<toolKey>_*` layout (migrated DB nodes).
  if (param.key.startsWith("param_")) {
    // Legacy prefixed params no longer exist in the spec — nothing matches.
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-1.5">
      <label className="flex items-center justify-between text-xs font-medium">
        <span>{param.label}</span>
        {param.unit && (
          <span className="text-[10px] font-normal text-muted-foreground">
            {param.unit}
          </span>
        )}
      </label>
      <ParamField
        param={param}
        value={node.params[param.key]}
        agents={agents}
        onChange={(v) => onPatchParam(param.key, v)}
      />
      {param.hint && <p className="text-[11px] text-muted-foreground">{param.hint}</p>}
    </div>
  );
}

/** Minimal connection DTO shape used by the cluster target section. */
interface ClusterConnLite {
  id: string;
  name: string;
  username: string;
  host: string;
  useSlurm: boolean;
  slurmPartition: string | null;
  af2?: {
    partition?: string;
    node?: string;
    module?: string;
  } | null;
  lastProbe: {
    slurm: { partitions: { name: string; gpusPerNode: number }[] };
  } | null;
}

/** Cluster dispatch section for tool nodes (the AlphaFold node).
 *
 * Manages the node's `_cluster` param (stored as a JSON STRING so it fits the
 * string|number|boolean param surface). The workflow engine's
 * extractClusterTarget parses it back and routes the tool run to the
 * SSH cluster instead of local execution. The salloc mode follows the
 * AlphaFold tutorial (mgt → salloc → gpu05 → module alphafold2). */
function ClusterTargetSection({
  node,
  onPatchParam,
}: {
  node: NodeDTO;
  onPatchParam: (key: string, value: string | number | boolean) => void;
}) {
  // Lazy-load connections the first time the section is enabled.
  const [connList, setConnList] = React.useState<ClusterConnLite[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [connError, setConnError] = React.useState<string | null>(null);

  const raw = (node.params as Record<string, unknown>)._cluster;
  type ClusterTargetLite = {
    connectionId?: string;
    mode?: string;
    partition?: string;
    node?: string;
    module?: string;
    cudaDevice?: string;
  };
  let target: ClusterTargetLite | null = null;
  if (typeof raw === "string" && raw.trim()) {
    try { target = JSON.parse(raw) as ClusterTargetLite; } catch { target = null; }
  } else if (raw && typeof raw === "object") {
    target = raw as ClusterTargetLite;
  }
  const enabled = !!target?.connectionId;
  const activeConn = connList.find((c) => c.id === target?.connectionId);
  const partitions = activeConn?.lastProbe?.slurm?.partitions ?? [];

  const loadConns = React.useCallback(async () => {
    setLoaded(true);
    try {
      const res = await fetch("/api/cluster/connections", { cache: "no-store" });
      const data = await res.json();
      setConnList(Array.isArray(data.connections) ? data.connections : []);
    } catch (e) {
      setConnError(String(e));
    }
  }, []);

  React.useEffect(() => {
    if (enabled && !loaded) void loadConns();
  }, [enabled, loaded, loadConns]);

  const write = (
    next: {
      connectionId?: string;
      mode?: string;
      partition?: string;
      node?: string;
      module?: string;
      cudaDevice?: string;
    } | null,
  ) => {
    if (!next || !next.connectionId) {
      onPatchParam("_cluster", "");
      return;
    }
    onPatchParam("_cluster", JSON.stringify(next));
  };

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Server className="size-3.5 text-emerald-600" />
          Run on cluster
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(on) => {
            if (on) {
              // Load connections first (async) so the first toggle-on can
              // immediately persist a REAL connectionId — writing "" would
              // self-disable the switch on the same frame.
              void (async () => {
                let list = connList;
                if (!loaded || list.length === 0) {
                  try {
                    const res = await fetch("/api/cluster/connections", { cache: "no-store" });
                    const data = await res.json();
                    list = Array.isArray(data.connections) ? (data.connections as ClusterConnLite[]) : [];
                    setConnList(list);
                  } catch { /* connError surfaces in the section */ }
                  setLoaded(true);
                }
                write({
                  connectionId: list[0]?.id ?? "",
                  mode: "salloc",
                  partition: list[0]?.af2?.partition ?? list[0]?.slurmPartition ?? undefined,
                  node: list[0]?.af2?.node ?? "gpu05",
                  module: list[0]?.af2?.module ?? "alphafold2",
                  cudaDevice: String(node.params.gpu ?? "0"),
                });
              })();
            } else {
              write(null);
            }
          }}
          aria-label="Run this tool on a cluster"
        />
      </div>

      {enabled && (
        <div className="mt-2.5 space-y-2">
          {connError ? (
            <p className="text-[11px] text-rose-600">Failed to load connections: {connError}</p>
          ) : connList.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No cluster connections configured — add one in the Cluster panel
              (sidebar → Cluster).
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">Connection</label>
                <Select
                  value={target?.connectionId ?? ""}
                  onValueChange={(v) => {
                    const conn = connList.find((c) => c.id === v);
                    write({
                      connectionId: v,
                      mode: target?.mode ?? (conn?.useSlurm ? "slurm" : "direct"),
                      partition: target?.partition ?? conn?.slurmPartition ?? undefined,
                    });
                  }}
                >
                  <SelectTrigger className="w-full" size="sm"><SelectValue placeholder="Pick a connection" /></SelectTrigger>
                  <SelectContent>
                    {connList.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.username}@{c.host})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => write({ ...target, connectionId: target?.connectionId ?? "", mode: "salloc" })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                    target?.mode === "salloc"
                      ? "border-emerald-500/60 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  salloc
                  <span className="block text-[10px] font-normal">tutorial flow</span>
                </button>
                <button
                  type="button"
                  onClick={() => write({ ...target, connectionId: target?.connectionId ?? "", mode: "direct" })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                    target?.mode === "direct"
                      ? "border-emerald-500/60 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  Direct
                  <span className="block text-[10px] font-normal">setsid on login node</span>
                </button>
                <button
                  type="button"
                  onClick={() => write({ ...target, connectionId: target?.connectionId ?? "", mode: "slurm" })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                    target?.mode === "slurm"
                      ? "border-emerald-500/60 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  Slurm
                  <span className="block text-[10px] font-normal">submit via sbatch</span>
                </button>
              </div>
              {(target?.mode === "slurm" || target?.mode === "salloc") && (
                <div className="grid grid-cols-1 gap-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground">Partition</label>
                  {partitions.length > 0 ? (
                    <Select
                      value={target?.partition ?? ""}
                      onValueChange={(v) => write({ ...target, connectionId: target?.connectionId ?? "", partition: v })}
                    >
                      <SelectTrigger className="w-full" size="sm"><SelectValue placeholder="default" /></SelectTrigger>
                      <SelectContent>
                        {partitions.map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.name}{p.gpusPerNode ? ` · ${p.gpusPerNode} GPU/N` : " · CPU"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={target?.partition ?? ""}
                      onChange={(e) => write({ ...target, connectionId: target?.connectionId ?? "", partition: e.target.value })}
                      placeholder="brain2"
                      className="h-7 text-xs"
                    />
                  )}
                </div>
              )}
              {target?.mode === "salloc" && (
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="grid grid-cols-1 gap-1">
                    <label className="text-[11px] font-medium text-muted-foreground">GPU node</label>
                    <Input
                      value={target?.node ?? ""}
                      onChange={(e) => write({ ...target, connectionId: target?.connectionId ?? "", node: e.target.value })}
                      placeholder="gpu05"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Module</label>
                    <Input
                      value={target?.module ?? ""}
                      onChange={(e) => write({ ...target, connectionId: target?.connectionId ?? "", module: e.target.value })}
                      placeholder="alphafold2"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    <label className="text-[11px] font-medium text-muted-foreground">GPU card</label>
                    <Input
                      value={target?.cudaDevice ?? ""}
                      onChange={(e) => write({ ...target, connectionId: target?.connectionId ?? "", cudaDevice: e.target.value.replace(/[^0-9,]/g, "") })}
                      placeholder="0"
                      className="h-7 text-xs"
                      inputMode="numeric"
                    />
                  </div>
                </div>
              )}
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Stored as the node&apos;s <code className="font-mono">_cluster</code> param — the
                workflow engine stages inputs, submits over SSH (salloc → ssh node →
                module load → run), polls until the cluster job finishes, and syncs
                outputs back here.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Params tab content. */
function ParamsTab({
  node,
  spec,
  agents,
  onPatchParam,
}: {
  node: NodeDTO;
  spec: NodeSpec;
  agents: AgentDTO[];
  onPatchParam: (key: string, value: string | number | boolean) => void;
}) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const basic = spec.params.filter((p) => !p.advanced);
  const advanced = spec.params.filter((p) => p.advanced);
  // Tool nodes get the cluster dispatch section beneath their params —
  // routes the run to an SSH/HPC cluster (the AlphaFold tutorial flow).
  const isToolNode = !!spec.toolKey;

  if (spec.params.length === 0 && !isToolNode) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        This node has no configurable parameters.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {basic.map((p) => (
        <ParamRow
          key={p.key}
          param={p}
          node={node}
          agents={agents}
          onPatchParam={onPatchParam}
        />
      ))}
      {isToolNode && (
        <ClusterTargetSection node={node} onPatchParam={onPatchParam} />
      )}
      {advanced.length > 0 && (
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-full justify-start text-xs">
              {showAdvanced ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              {showAdvanced ? "Hide" : "Show"} advanced ({advanced.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-3 border-l-2 border-border pl-3">
              {advanced.map((p) => (
                <ParamRow
                  key={p.key}
                  param={p}
                  node={node}
                  agents={agents}
                  onPatchParam={onPatchParam}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** Logs tab content. Renders live-updating logs as they stream in via SSE
 * (the running case used to show only a "Running…" spinner — now we surface
 * whatever logs the backend has emitted so far, with a small live indicator
 * when the buffer is still empty).
 *
 * The <pre> is auto-scrolled to the bottom on each update so the user sees
 * the latest log line without manually scrolling. A "Download" button
 * exports the current logs buffer as a .txt file (handy for sharing run
 * output in bug reports). */
function LogsTab({ node }: { node: NodeDTO }) {
  const logs = node.logs?.trim();
  const preRef = React.useRef<HTMLPreElement | null>(null);

  // Auto-scroll to the bottom on each log update — but only if the user is
  // already near the bottom (within 60px). This preserves scroll position
  // when the user is reading older log lines.
  React.useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleDownload = () => {
    if (!logs) return;
    const blob = new Blob([logs], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${node.name.replace(/[^\w-]+/g, "_")}_logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!logs && node.status === "running") {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Starting…
      </div>
    );
  }
  if (!logs) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        No logs yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          logs · {logs.length.toLocaleString()} chars
          {node.status === "running" && (
            <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <Loader2 className="size-2.5 animate-spin" /> live
            </span>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={handleDownload}
          type="button"
        >
          <Download className="size-3" />
          Download
        </Button>
      </div>
      <pre
        ref={preRef}
        className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere"
      >
        {logs}
      </pre>
    </div>
  );
}

/** Build the API URL for workflow-node outputs (no ToolJob row exists). */
function nodeFileApiUrl(path: string): string {
  return `/api/tools/file?path=${encodeURIComponent(path)}`;
}

/** Result tab content. For COMP-TOOL nodes the results are shown DIRECTLY:
 * the real output file list (with sizes, type icons, copy/download actions)
 * plus inline previews — 3D structure viewer for PDB, colored sequence
 * viewer for FASTA, metric cards for JSON, tables for CSV, images, and
 * monospace text for everything else. A collapsible "Run summary" section
 * carries the markdown summary; the full-screen viewer dialog is one click
 * away. Non-tool nodes keep the live-streaming markdown rendering. */
function ResultTab({
  node,
  outputFiles,
  executor,
  onOpenViewer,
  viewerOpen,
}: {
  node: NodeDTO;
  outputFiles: string[];
  executor: ResultExecutor | null;
  onOpenViewer: (() => void) | null;
  viewerOpen: boolean;
}) {
  const result = node.result?.trim();
  const isToolNode = outputFiles.length > 0 || executor !== null;

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${node.name.replace(/[^\w-]+/g, "_")}_result.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!result && outputFiles.length === 0 && node.status === "running") {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {isToolNode ? "Running — output files will appear here…" : "Generating…"}
      </div>
    );
  }
  if (!result && outputFiles.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        Not run yet.
      </div>
    );
  }

  // Tool nodes: the output file list + inline previews render directly.
  if (outputFiles.length > 0) {
    return (
      <InlineResults
        files={outputFiles}
        fileUrl={nodeFileApiUrl}
        executor={executor ?? "builtin-engine"}
        onOpenFullViewer={onOpenViewer ?? undefined}
        summary={result}
        compact
        suspend={viewerOpen}
      />
    );
  }

  // Everything else (incl. tool nodes that produced no files): markdown.
  const md = result ?? "";
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          result · {md.length.toLocaleString()} chars
          {node.status === "failed" && (
            <span className="ml-1 text-rose-600 dark:text-rose-400">· failed</span>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={handleDownload}
          type="button"
        >
          <Download className="size-3" />
          Download
        </Button>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{md}</ReactMarkdown>
      </div>
    </div>
  );
}

/** The right-column inspector. Returns null when nothing is selected. */
function NodeInspectorImpl() {
  const workflow = useAppStore((s) => s.workflow);
  const selectedId = useAppStore((s) => s.selectedId);
  const inspectId = useAppStore((s) => s.inspectId);
  const tab = useAppStore((s) => s.inspectorTab);
  const setTab = useAppStore((s) => s.setInspectorTab);
  const agents = useAppStore((s) => s.agents);
  const upsertNode = useAppStore((s) => s.upsertNode);
  const removeNode = useAppStore((s) => s.removeNode);
  const select = useAppStore((s) => s.select);
  const inspect = useAppStore((s) => s.inspect);
  const setNodeStatus = useAppStore((s) => s.setNodeStatus);
  const toast = useAppStore((s) => s.toast);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const setPendingScreeningId = useAppStore((s) => s.setPendingScreeningId);

  const patch = useDebouncedPatch();
  const [running, setRunning] = React.useState(false);
  const [runningAll, setRunningAll] = React.useState(false);
  const [duplicating, setDuplicating] = React.useState(false);
  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [sweepOpen, setSweepOpen] = React.useState(false);
  const [compareOpen, setCompareOpen] = React.useState(false);

  const id = inspectId ?? selectedId;
  const node = React.useMemo(
    () => (workflow?.nodes ?? []).find((n) => n.id === id) ?? null,
    [workflow, id],
  );

  const spec = React.useMemo(
    () => (node ? nodeSpec(node.type) : undefined),
    [node],
  );

  // ── C2 provenance: promoted-input source chip ────────────────────────────
  // Input nodes minted by screening promotion carry the screening id in
  // refId. Resolve its name (best-effort) for the header chip; the chip's
  // Open button deep-links the Screening panel to that campaign.
  const promoteSourceId = node?.type === "input" ? node.refId : null;
  const [promoteSourceName, setPromoteSourceName] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!promoteSourceId) {
      setPromoteSourceName(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/screening/${promoteSourceId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setPromoteSourceName(data?.screening?.name ?? null);
      } catch {
        if (!cancelled) setPromoteSourceName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promoteSourceId]);

  // Params this node can sweep (drives the Sweep button + dialog mount).
  // Mirrors the dialog's UNSWEEPABLE_KEYS + advanced filtering so the button
  // only appears when there is actually something to vary.
  const sweepableParamCount = React.useMemo(
    () =>
      spec
        ? spec.params.filter(
            (p) =>
              !p.advanced &&
              p.key !== "refId" &&
              p.key !== "gpu" &&
              p.key !== "cudaDevice",
          ).length
        : 0,
    [spec],
  );

  // Tool nodes: parse the real output file list from the engine's
  // ##OUTPUTS## trailer in the logs (paths under outputs/<tool>/<run>/).
  const compToolKey =
    node?.type && COMP_TOOLS.some((t) => t.key === node.type)
      ? node.type
      : node?.type === "alphafold"
        ? "alphafold"
        : null;
  const outputFiles = React.useMemo(() => {
    if (!compToolKey || !node?.logs) return [];
    const idx = node.logs.lastIndexOf("##OUTPUTS## ");
    if (idx === -1) return [];
    try {
      const arr = JSON.parse(
        node.logs.slice(idx + "##OUTPUTS## ".length).split("\n")[0],
      ) as unknown;
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  }, [compToolKey, node?.logs]);
  // Executor provenance — derived from the engine banner in the logs. Its
  // absence on a successful run means the native upstream tool executed.
  const executor: ResultExecutor | null = React.useMemo(() => {
    if (!compToolKey || !node) return null;
    const logs = node.logs ?? "";
    if (/\[built-in real algorithm engine\]/i.test(logs)) return "builtin-engine";
    if (/^\[SIMULATED/i.test(logs) || /\(simulated\)/i.test(logs) || /FOUNDRY-LAB SIMULATION/i.test(logs)) {
      return "legacy-simulated";
    }
    if (node.status === "completed") return "native";
    return "builtin-engine";
  }, [compToolKey, node, node?.logs]);
  const viewerJob: ToolJobDTO | null = React.useMemo(() => {
    if (!compToolKey || !node || outputFiles.length === 0) return null;
    const logs = node.logs ?? "";
    // Executor provenance for the badge — REUSE the outer `executor` memo so
    // the dialog badge and the inline Result-tab badge always agree (a
    // legacy-simulated node with outputs shows LEGACY in both, not just in
    // the inline view). Falls back to "native" when the memo is undecided.
    return {
      id: `node-${node.id}`,
      tool: compToolKey,
      presetName: null,
      params: {
        _meta: {
          executor:
            executor === "builtin-engine" || executor === "legacy-simulated"
              ? executor
              : "native",
          realToolUsed: true,
        },
      },
      status: node.status === "failed" ? "failed" : "completed",
      pid: null,
      stdout: logs,
      stderr: "",
      outputFiles,
      exitCode: node.status === "failed" ? 1 : 0,
      command: logs.split("\n")[0] ?? "",
      triggeredBy: "workflow",
      agentId: null,
      environmentId: null,
      startedAt: node.startedAt,
      finishedAt: node.completedAt,
      createdAt: node.createdAt,
    };
  }, [compToolKey, node, outputFiles, executor]);

  // ⌘+Enter / Ctrl+Enter to run this node. Ref holds the latest run function
  // so the keyboard listener doesn't need to re-bind on every keystroke.
  const runRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live progress via SSE — open an EventSource whenever the inspected node
  // is running or pending. The server polls the DB every 500ms and emits a
  // "status" event per poll, plus a terminal "done" event when the node
  // reaches a completed/failed state. We surface each update in the store so
  // the Logs/Result tabs + progress bar all animate live. The "done" toast
  // is fired here (the onRun POST's own success toast was removed to avoid
  // duplicates) — we also toast inside the status handler for terminal
  // states, guarded by a `finished` flag, because the effect's cleanup may
  // close the EventSource before the "done" event arrives (zustand updates
  // synchronously, which re-renders and re-runs the effect, calling es.close()
  // before the next SSE event tick).
  React.useEffect(() => {
    if (!node) return;
    if (node.status !== "running" && node.status !== "pending") return;

    let finished = false;
    const nodeId = node.id;
    const es = new EventSource(`/api/workflow/nodes/${nodeId}/stream`);

    es.addEventListener("status", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          status: NodeDTO["status"];
          progress?: number;
          logs?: string;
          result?: string;
        };
        setNodeStatus(
          nodeId,
          data.status,
          data.progress,
          data.result,
          data.logs,
        );
        if (data.status === "completed" || data.status === "failed") {
          if (!finished) {
            finished = true;
            toast({
              title: "Node finished",
              description: data.status,
              variant: data.status === "failed" ? "destructive" : "success",
            });
            es.close();
          }
          // Comp-tool nodes: jump straight to the Result tab so the real
          // output file list + previews are the FIRST thing the user sees
          // (this is the whole point of the direct-results UX).
          if (
            data.status === "completed" &&
            compToolKey &&
            typeof data.logs === "string" &&
            data.logs.includes("##OUTPUTS## ")
          ) {
            setTab("result");
          }
        }
      } catch {
        // Malformed payload — ignore this tick.
      }
    });

    es.addEventListener("done", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { status?: string };
        if (!finished) {
          finished = true;
          toast({
            title: "Node finished",
            description: data.status ?? "completed",
            variant: data.status === "failed" ? "destructive" : "success",
          });
        }
      } catch {
        // ignore
      }
      es.close();
    });

    es.addEventListener("error", (e) => {
      // The native EventSource error event has no `data`; our backend's
      // custom `event: error` frame does. Distinguish via `e.data`.
      const ev = e as MessageEvent;
      if (ev.data) {
        try {
          const data = JSON.parse(ev.data) as { error?: string };
          if (data.error) {
            toast({
              title: "Stream error",
              description: data.error,
              variant: "destructive",
            });
          }
        } catch {
          // ignore
        }
      }
      es.close();
    });

    return () => {
      es.close();
    };
  }, [node?.id, node?.status, compToolKey, setTab, setNodeStatus, toast]);

  if (!node || !spec) return null;

  const color = NODE_COLORS[spec.color as keyof typeof NODE_COLORS] ?? NODE_COLORS.slate;
  const isRunning = node.status === "running" || running;

  const onRename = (name: string) => {
    // Mark dirty BEFORE the optimistic write so the 3s status poll can't
    // clobber the new name while the debounced PATCH is still pending.
    useAppStore.getState().markNodeDirty(node.id);
    upsertNode({ ...node, name });
    patch(node.id, { name });
  };

  const onPatchParam = (key: string, value: string | number | boolean) => {
    useAppStore.getState().markNodeDirty(node.id);
    // For agent nodes, refId is a top-level field (not in params JSON).
    if (node.type === "agent" && key === "refId") {
      const updated = { ...node, refId: String(value) || null };
      upsertNode(updated);
      patch(node.id, { refId: String(value) || null });
      return;
    }
    const params = { ...node.params, [key]: value };
    upsertNode({ ...node, params });
    patch(node.id, { params });
  };

  const onClose = () => {
    select(null);
    inspect(null);
  };

  const onRun = async () => {
    if (isRunning) return;
    setRunning(true);
    setNodeStatus(node.id, "running", 10);
    setTab("logs");
    try {
      const res = await fetch(`/api/workflow/nodes/${node.id}/run`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const updated: NodeDTO = await res.json();
      // The SSE effect above will toast "Node finished" when it observes the
      // terminal status — no need to toast here too (would duplicate).
      upsertNode(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNodeStatus(node.id, "failed", 100, `Error: ${msg}`, node.logs);
      toast({ title: "Run failed", description: msg, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };
  // Keep the ref in sync with the latest onRun closure.
  runRef.current = onRun;

  const onDuplicate = async () => {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const res = await fetch("/api/workflow/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Target the node's own workflow (multi-workflow contract).
          workflowId: node.workflowId,
          type: node.type,
          name: `${node.name} copy`,
          x: node.x + 40,
          y: node.y + 40,
          refId: node.refId ?? undefined,
          params: node.params,
        }),
      });
      if (!res.ok) throw new Error("duplicate failed");
      const created: NodeDTO = await res.json();
      upsertNode(created);
      useAppStore.getState().select(created.id);
      useAppStore.getState().inspect(created.id);
      toast({ title: "Duplicated", description: `${node.name} → ${created.name}` });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    } finally {
      setDuplicating(false);
    }
  };

  const onRunAll = async () => {
    const wf = useAppStore.getState().workflow;
    if (!wf) return;
    setRunningAll(true);
    try {
      const res = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Target the CURRENT workflow; the server 409s when a node is
        // already running (double-execution guard).
        body: JSON.stringify({ workflowId: wf.id }),
      });
      if (res.status === 409) {
        toast({ title: "Workflow is already running" });
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // Refetch the CURRENT workflow to pull fresh node statuses.
      const wfRes = await fetch(`/api/workflows/${wf.id}`);
      if (wfRes.ok) {
        const fresh = await wfRes.json();
        useAppStore.getState().setWorkflow(fresh);
      }
      toast({ title: "Workflow run complete", variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Workflow run failed", description: msg, variant: "destructive" });
    } finally {
      setRunningAll(false);
    }
  };

  const onDelete = async () => {
    // Push history, remove optimistically — and RESTORE the node when the
    // server DELETE fails (the old code awaited the fetch without checking
    // res.ok, so an HTTP 500 still toasted "Node deleted").
    const s = useAppStore.getState();
    const before = s.workflow;
    if (before) {
      useHistoryStore.getState().push({
        nodes: before.nodes,
        edges: before.edges,
        viewport: s.viewport,
      });
    }
    // Suppressed: the inline push above is the single capture for this op.
    withHistorySuppressed(() => removeNode(node.id));
    try {
      const res = await fetch(`/api/workflow/nodes/${node.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Node deleted", description: node.name, variant: "success" });
    } catch {
      // Rollback: re-add the node + its edges exactly as they were.
      const cur = useAppStore.getState().workflow;
      if (cur && before) {
        const nodeRow = before.nodes.find((n) => n.id === node.id);
        const lostEdges = before.edges.filter(
          (e) =>
            (e.fromNodeId === node.id || e.toNodeId === node.id) &&
            !cur.edges.some((x) => x.id === e.id),
        );
        if (nodeRow) {
          withHistorySuppressed(() => {
            useAppStore.getState().setWorkflow({
              ...cur,
              nodes: [...cur.nodes, nodeRow],
              edges: [...cur.edges, ...lostEdges],
            });
          });
        }
      }
      toast({
        title: "Delete failed",
        description: "The node is still on the server — restored locally.",
        variant: "destructive",
      });
    }
  };

  return (
    <TooltipProvider delayDuration={250}>
      <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
        {/* Animated progress bar at the top while running */}
        {isRunning && (
          <div className="relative h-0.5 w-full overflow-hidden bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-300"
              style={{
                width: `${Math.max(4, Math.min(100, node.progress || 10))}%`,
              }}
            />
          </div>
        )}

        {/* Header with subtle gradient accent matching node color */}
        <header
          className={cn(
            "relative flex flex-col gap-2 overflow-hidden border-b p-3",
            "inspector-accent",
          )}
        >
          {/* Colored top border accent */}
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70",
              color.bg,
            )}
          />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md border",
                color.soft,
                color.border,
                color.text,
              )}
            >
              <SpecIcon name={spec.icon} className="size-4" />
            </span>
            <Input
              value={node.name}
              onChange={(e) => onRename(e.target.value)}
              className="h-8 flex-1 text-sm font-medium"
              aria-label="Node name"
            />
            <Button variant="ghost" size="icon" className="size-8" onClick={onClose} title="Close">
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("border", STATUS_STYLES[node.status] ?? STATUS_STYLES.idle)}>
              {node.status}
            </Badge>
            <span className="text-xs text-muted-foreground">{spec.label}</span>
            {promoteSourceId && (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 py-0.5 pl-1.5 pr-1 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                <FlaskConical className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  from {promoteSourceName ? `“${promoteSourceName}”` : "screening"}
                </span>
                <button
                  type="button"
                  className="ml-0.5 shrink-0 rounded-full px-1 underline underline-offset-2 transition-opacity hover:opacity-80"
                  title="Open this screening campaign"
                  onClick={() => {
                    setPendingScreeningId(promoteSourceId);
                    setActivePanel("screening");
                  }}
                >
                  Open
                </button>
              </span>
            )}
            {spec.usesLLM && (
              <Badge variant="secondary" className="ml-auto text-[10px]">LLM</Badge>
            )}
          </div>
        </header>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="m-2 grid w-[calc(100%-1rem)] grid-cols-3">
            <TabsTrigger value="params">Params</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="result" className="gap-1">
              Result
              {outputFiles.length > 0 && (
                <span
                  className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold tabular-nums text-primary"
                  title={`${outputFiles.length} output files`}
                >
                  {outputFiles.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          {/* Radix sizes the viewport's inner wrapper with `display: table;
              min-width: 100%`, which expands to the content's intrinsic
              width — so one long unwrapped log line (e.g. the ##OUTPUTS##
              file list) or a wide hint sentence makes the WHOLE panel wider
              than the sidebar and clips everything past the right border.
              Overriding the wrapper to `display: block` lays content out at
              the panel width so text wraps; genuinely-wide content is then
              reachable via the ScrollArea's horizontal scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <TabsContent value="params" className="m-0">
              <ParamsTab
                node={node}
                spec={spec}
                agents={agents}
                onPatchParam={onPatchParam}
              />
            </TabsContent>
            <TabsContent value="logs" className="m-0">
              <LogsTab node={node} />
            </TabsContent>
            <TabsContent value="result" className="m-0">
              <ResultTab
                node={node}
                outputFiles={compToolKey ? outputFiles : []}
                executor={executor}
                onOpenViewer={viewerJob ? () => setViewerOpen(true) : null}
                viewerOpen={viewerOpen}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>

        <Separator />

        {/* Footer actions */}
        <footer className="flex flex-col gap-2 p-3">
          <div className="flex gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onRun}
                  disabled={isRunning}
                  className="flex-1"
                  size="sm"
                >
                  {isRunning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  Run
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">⌘+Enter to run</TooltipContent>
            </Tooltip>
            {viewerJob && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => setViewerOpen(true)}
                    variant="outline"
                    size="sm"
                    className="gap-1"
                  >
                    <FileBox className="size-4" />
                    Outputs
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  View {outputFiles.length} real output file(s)
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onDuplicate}
                  disabled={duplicating}
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                >
                  {duplicating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  Duplicate
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Duplicate this node</TooltipContent>
            </Tooltip>
            {sweepableParamCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => setSweepOpen(true)}
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    data-sweep-button
                  >
                    <Grid3X3 className="size-4" />
                    Sweep
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Parameter sweep — expand this node into variants
                </TooltipContent>
              </Tooltip>
            )}
            {node?.sweepGroup && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => setCompareOpen(true)}
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    data-sweep-compare-button
                  >
                    <Table2 className="size-4" />
                    Compare
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Sweep comparison — metrics across every variant of this sweep
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <Button
            onClick={onRunAll}
            disabled={runningAll}
            variant="secondary"
            size="sm"
            className="w-full"
          >
            {runningAll ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Run All
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                <Trash2 className="size-4" />
                Delete node
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{node.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the node and any connected edges. You can undo
                  this with Ctrl+Z (Cmd+Z on Mac).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </footer>
        {node && spec && sweepableParamCount > 0 && (
          <SweepDialog
            node={node}
            spec={spec}
            open={sweepOpen}
            onOpenChange={setSweepOpen}
          />
        )}
        {node?.sweepGroup && (
          <SweepCompareDialog
            node={node}
            open={compareOpen}
            onOpenChange={setCompareOpen}
          />
        )}
        {viewerJob && (
          <OutputViewerDialog
            job={viewerJob}
            open={viewerOpen}
            onClose={() => setViewerOpen(false)}
            nodeMode
          />
        )}
      </aside>
    </TooltipProvider>
  );
}

export const NodeInspector = React.memo(NodeInspectorImpl);
