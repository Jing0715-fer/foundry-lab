"use client";

import * as React from "react";
import {
  Bot,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Database,
  ArrowRightToLine,
  Flag,
  Box,
  X,
  Loader2,
  Play,
  Trash2,
  ChevronDown,
  ChevronRight,
  Copy,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
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

/** Debounced PATCH for node updates. */
function useDebouncedPatch() {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  return React.useCallback((id: string, body: Record<string, unknown>, delay = 350) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await fetch(`/api/workflow/nodes/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        /* swallow — optimistic state already applied */
      }
    }, delay);
  }, []);
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
      <div className="grid gap-1.5">
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

  // For comptool nodes, hide param fields whose prefix doesn't match the current toolKey.
  if (node.type === "comptool" && param.key.startsWith("param_")) {
    const toolKey = String(node.params.toolKey ?? "rfdiffusion");
    const prefix = `param_${toolKey}_`;
    if (!param.key.startsWith(prefix)) return null;
  }

  return (
    <div className="grid gap-1.5">
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

  if (spec.params.length === 0) {
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

/** Logs tab content. */
function LogsTab({ node }: { node: NodeDTO }) {
  if (node.status === "running") {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Running…
      </div>
    );
  }
  return (
    <pre className="m-3 max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
      {node.logs?.trim() || "No logs yet."}
    </pre>
  );
}

/** Result tab content. */
function ResultTab({ node }: { node: NodeDTO }) {
  if (node.status === "running") {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Running…
      </div>
    );
  }
  if (!node.result || !node.result.trim()) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        Not run yet.
      </div>
    );
  }
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none p-3">
      <ReactMarkdown>{node.result}</ReactMarkdown>
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

  const patch = useDebouncedPatch();
  const [running, setRunning] = React.useState(false);
  const [runningAll, setRunningAll] = React.useState(false);
  const [duplicating, setDuplicating] = React.useState(false);

  const id = inspectId ?? selectedId;
  const node = React.useMemo(
    () => (workflow?.nodes ?? []).find((n) => n.id === id) ?? null,
    [workflow, id],
  );

  const spec = React.useMemo(
    () => (node ? nodeSpec(node.type) : undefined),
    [node],
  );

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

  if (!node || !spec) return null;

  const color = NODE_COLORS[spec.color as keyof typeof NODE_COLORS] ?? NODE_COLORS.slate;
  const isRunning = node.status === "running" || running;

  const onRename = (name: string) => {
    upsertNode({ ...node, name });
    patch(node.id, { name });
  };

  const onPatchParam = (key: string, value: string | number | boolean) => {
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
      upsertNode(updated);
      toast({
        title: "Node finished",
        description: `${node.name} → ${updated.status}`,
        variant: updated.status === "failed" ? "destructive" : "success",
      });
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
    setRunningAll(true);
    try {
      const res = await fetch("/api/workflow/run", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // Refetch the workflow to pull fresh node statuses.
      const wfRes = await fetch("/api/workflow");
      if (wfRes.ok) {
        const wf = await wfRes.json();
        useAppStore.getState().setWorkflow(wf);
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
    try {
      await fetch(`/api/workflow/nodes/${node.id}`, { method: "DELETE" });
    } catch {
      /* ignore — remove from local state anyway */
    }
    removeNode(node.id);
    toast({ title: "Node deleted", description: node.name });
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
            <TabsTrigger value="result">Result</TabsTrigger>
          </TabsList>
          <ScrollArea className="min-h-0 flex-1">
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
              <ResultTab node={node} />
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
                  This removes the node and any connected edges. This cannot be undone.
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
      </aside>
    </TooltipProvider>
  );
}

export const NodeInspector = React.memo(NodeInspectorImpl);
