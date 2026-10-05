"use client";

import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useAppStore } from "@/lib/store";
import { useChatStore } from "@/lib/chat-store";
import { nodeSpec } from "@/lib/workflow-catalog";
import {
  downloadWorkflowJSON,
  importWorkflow,
  parseWorkflowJSON,
} from "@/lib/workflow-io";
import type { AgentDTO, NodeDTO } from "@/lib/types";

import {
  Navigation,
  Zap,
  Plus,
  Bot,
  Play,
  RotateCcw,
  Square,
  Download,
  Upload,
  SquarePen,
  Users,
  BookOpen,
  Cpu,
  Boxes,
  Database,
  ArrowRightToLine,
  Flag,
  Loader2,
} from "lucide-react";

const CARD_W = 248;
const CARD_H = 116;
const PAD = 40;

/**
 * Find a free spot near the viewport center that doesn't overlap existing
 * nodes. Uses a spiral search — same idea as the palette's findFreeSpot but
 * inlined here so we don't have to touch palette.tsx (out of scope).
 */
function findFreeSpot(
  existing: { x: number; y: number }[],
  centerX: number,
  centerY: number,
): { x: number; y: number } {
  if (existing.length === 0) return { x: centerX, y: centerY };
  const overlaps = (c: { x: number; y: number }) =>
    existing.some(
      (e) =>
        Math.abs(e.x - c.x) < CARD_W + PAD * 0.5 &&
        Math.abs(e.y - c.y) < CARD_H + PAD * 0.5,
    );
  const candidates: { x: number; y: number }[] = [
    { x: centerX, y: centerY },
  ];
  for (let ring = 1; ring <= 6; ring++) {
    const stepX = CARD_W + PAD;
    const stepY = CARD_H + PAD;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        candidates.push({
          x: centerX + dx * stepX,
          y: centerY + dy * stepY,
        });
      }
    }
  }
  for (const c of candidates) {
    if (!overlaps(c)) return { x: Math.round(c.x), y: Math.round(c.y) };
  }
  return { x: Math.round(centerX + 40), y: Math.round(centerY + 40) };
}

/** Compute the world-coord center of the current canvas viewport. */
function viewportCenterWorld(): { x: number; y: number } {
  const { viewport } = useAppStore.getState();
  const el = document.querySelector('[data-canvas="viewport"]');
  const w = el?.getBoundingClientRect().width ?? 900;
  const h = el?.getBoundingClientRect().height ?? 600;
  return {
    x: (viewport.x + w / 2) / viewport.zoom - CARD_W / 2,
    y: (viewport.y + h / 2) / viewport.zoom - CARD_H / 2,
  };
}

/** Create a new node of the given type at the viewport center. */
async function addNodeAtCenter(
  type: string,
  defaultName: string,
): Promise<void> {
  const { workflow, upsertNode, select, inspect, toast, setActivePanel } =
    useAppStore.getState();
  setActivePanel("canvas");
  const spec = nodeSpec(type);
  const name = spec?.label ?? defaultName;
  const center = viewportCenterWorld();
  const existing = (workflow?.nodes ?? []).map((n) => ({ x: n.x, y: n.y }));
  const { x, y } = findFreeSpot(existing, center.x, center.y);
  try {
    const res = await fetch("/api/workflow/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Target the workflow the user is looking at (multi-workflow apps);
      // undefined falls back to the server's first-workflow behavior.
      body: JSON.stringify({ type, name, x, y, workflowId: workflow?.id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const node: NodeDTO = await res.json();
    upsertNode(node);
    select(node.id);
    inspect(node.id);
    toast({
      title: "Node added",
      description: `${name} added to canvas`,
      variant: "success",
    });
  } catch (e) {
    toast({
      title: "Couldn't add node",
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  }
}

/** Trigger the hidden file picker for JSON import. */
function pickJSONFile(onText: (text: string, fileName: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result ?? ""), f.name);
    reader.onerror = () =>
      useAppStore.getState().toast({
        title: "Import failed",
        description: "Could not read file",
        variant: "destructive",
      });
    reader.readAsText(f);
  };
  input.click();
}

const NAV_TARGETS: { panel: "canvas" | "dashboard" | "agents" | "tasks" | "meetings" | "research" | "alphafold"; label: string }[] = [
  { panel: "canvas", label: "Go to Canvas" },
  { panel: "dashboard", label: "Go to Dashboard" },
  { panel: "agents", label: "Go to Agents" },
  { panel: "tasks", label: "Go to Tasks" },
  { panel: "meetings", label: "Go to Meetings" },
  { panel: "research", label: "Go to Research" },
  { panel: "alphafold", label: "Go to AlphaFold" },
];

const ADD_NODE_TYPES: { type: string; label: string; icon: React.ReactNode }[] = [
  { type: "agent", label: "Add Agent", icon: <Bot className="size-4 mr-2" /> },
  { type: "task", label: "Add Task", icon: <SquarePen className="size-4 mr-2" /> },
  { type: "meeting", label: "Add Team Meeting", icon: <Users className="size-4 mr-2" /> },
  { type: "research", label: "Add Research", icon: <BookOpen className="size-4 mr-2" /> },
  { type: "alphafold", label: "Add AlphaFold", icon: <Boxes className="size-4 mr-2" /> },
  { type: "biotool", label: "Add Bio Tool", icon: <Database className="size-4 mr-2" /> },
  { type: "input", label: "Add Input", icon: <ArrowRightToLine className="size-4 mr-2" /> },
  { type: "output", label: "Add Output", icon: <Flag className="size-4 mr-2" /> },
];

/**
 * Global Cmd+K / Ctrl+K command palette.
 *
 * Groups:
 *   - Navigation: jump between the 7 panels.
 *   - Actions: run workflow, reset view, clear selection, export/import JSON.
 *   - Add Node: create any of the 8 node types at the viewport center.
 *   - Agents: chat with any of the agents fetched from /api/agents.
 *
 * The palette owns its own Cmd+K listener and `open` state. The shadcn
 * CommandDialog (Radix Dialog + cmdk) provides Esc-to-close + focus trap.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [agents, setAgents] = React.useState<AgentDTO[]>([]);
  const [agentsLoading, setAgentsLoading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);

  const toast = useAppStore((s) => s.toast);

  // --- Global Cmd+K / Ctrl+K toggle ----------------------------------------
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k") return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Don't trigger when Shift+Cmd+K or Alt+Cmd+K — keep it simple.
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Fetch agents once on mount (for the "Agents" group) ------------------
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setAgentsLoading(true);
      try {
        // Try the cached store first.
        const cached = useAppStore.getState().agents;
        if (cached.length > 0 && !cancelled) setAgents(cached);

        const res = await fetch("/api/agents");
        if (!res.ok) return;
        const list: AgentDTO[] = await res.json();
        if (!cancelled) {
          setAgents(list);
          useAppStore.getState().setAgents(list);
        }
      } catch {
        /* swallow — palette just shows an empty Agents group */
      } finally {
        if (!cancelled) setAgentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Action handlers ------------------------------------------------------
  const runWorkflow = React.useCallback(async () => {
    const { workflow, toast: t } = useAppStore.getState();
    if (!workflow) {
      t({
        title: "No workflow",
        description: "Load a workflow before running.",
        variant: "destructive",
      });
      return;
    }
    t({ title: "Workflow started", description: `Running "${workflow.name}"…` });
    try {
      const res = await fetch("/api/workflow/run", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      t({
        title: "Workflow complete",
        description: `Started ${data?.started ?? 0} • Completed ${
          data?.completed ?? 0
        }`,
        variant: "success",
      });
      // Refresh the workflow so node statuses update.
      const wfRes = await fetch("/api/workflow");
      if (wfRes.ok) {
        const wf = await wfRes.json();
        useAppStore.getState().setWorkflow(wf);
      }
    } catch (e) {
      t({
        title: "Run failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, []);

  const resetView = React.useCallback(() => {
    useAppStore.getState().setViewport({ x: 120, y: 80, zoom: 1 });
    useAppStore.getState().toast({
      title: "View reset",
      description: "Viewport returned to default position",
    });
  }, []);

  const clearSelection = React.useCallback(() => {
    useAppStore.getState().select(null);
    useAppStore.getState().inspect(null);
  }, []);

  const exportJSON = React.useCallback(() => {
    const { workflow, toast: t } = useAppStore.getState();
    if (!workflow) {
      t({
        title: "Nothing to export",
        description: "No workflow is loaded.",
        variant: "destructive",
      });
      return;
    }
    downloadWorkflowJSON(workflow);
    t({
      title: "Workflow exported",
      description: `${workflow.nodes.length} nodes · ${workflow.edges.length} edges`,
      variant: "success",
    });
  }, []);

  const importJSON = React.useCallback(async () => {
    if (importing) return;
    pickJSONFile(async (text, fileName) => {
      const { toast: t } = useAppStore.getState();
      let parsed;
      try {
        parsed = parseWorkflowJSON(text);
      } catch (e) {
        t({
          title: "Import failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
        return;
      }
      setImporting(true);
      t({
        title: "Importing workflow…",
        description: `Creating ${parsed.nodes.length} nodes + ${parsed.edges.length} edges`,
      });
      try {
        const wf = await importWorkflow(parsed);
        useAppStore.getState().setWorkflow(wf);
        useAppStore.getState().select(null);
        useAppStore.getState().inspect(null);
        useAppStore.getState().setActivePanel("canvas");
        t({
          title: "Workflow imported",
          description: `${fileName}: ${wf.nodes.length} nodes · ${wf.edges.length} edges`,
          variant: "success",
        });
      } catch (e) {
        t({
          title: "Import failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      } finally {
        setImporting(false);
      }
    });
  }, [importing]);

  const openChat = React.useCallback((agent: AgentDTO) => {
    useChatStore.getState().openChat(agent.id);
    useAppStore.getState().setActivePanel("agents");
  }, []);

  // Wrap each action so the palette closes first.
  const run = React.useCallback(
    (fn: () => void | Promise<void>) => () => {
      setOpen(false);
      // Defer to next tick so the dialog can close before the action runs.
      setTimeout(fn, 0);
    },
    [],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search for a command to run…"
      className="sm:max-w-xl"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Navigation --------------------------------------------------- */}
        <CommandGroup
          heading={
            <span className="flex items-center gap-1.5">
              <Navigation className="size-3" /> Navigation
            </span>
          }
        >
          {NAV_TARGETS.map((t) => (
            <CommandItem
              key={t.panel}
              value={t.label}
              onSelect={run(() => useAppStore.getState().setActivePanel(t.panel))}
            >
              <Navigation className="size-4 mr-2" />
              {t.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Actions ------------------------------------------------------- */}
        <CommandGroup
          heading={
            <span className="flex items-center gap-1.5">
              <Zap className="size-3" /> Actions
            </span>
          }
        >
          <CommandItem value="Run Workflow" onSelect={run(runWorkflow)}>
            <Play className="size-4 mr-2" />
            Run Workflow
          </CommandItem>
          <CommandItem value="Reset View" onSelect={run(resetView)}>
            <RotateCcw className="size-4 mr-2" />
            Reset View
          </CommandItem>
          <CommandItem value="Clear Selection" onSelect={run(clearSelection)}>
            <Square className="size-4 mr-2" />
            Clear Selection
          </CommandItem>
          <CommandItem value="Export Workflow JSON" onSelect={run(exportJSON)}>
            <Download className="size-4 mr-2" />
            Export Workflow (JSON)
          </CommandItem>
          <CommandItem
            value="Import Workflow JSON"
            onSelect={run(importJSON)}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <Upload className="size-4 mr-2" />
            )}
            {importing ? "Importing…" : "Import Workflow (JSON)"}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Add Node ----------------------------------------------------- */}
        <CommandGroup
          heading={
            <span className="flex items-center gap-1.5">
              <Plus className="size-3" /> Add Node
            </span>
          }
        >
          {ADD_NODE_TYPES.map((n) => (
            <CommandItem
              key={n.type}
              value={n.label}
              onSelect={run(() => addNodeAtCenter(n.type, n.label))}
            >
              {n.icon}
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Agents ------------------------------------------------------- */}
        {(agents.length > 0 || agentsLoading) && (
          <>
            <CommandSeparator />
            <CommandGroup
              heading={
                <span className="flex items-center gap-1.5">
                  <Bot className="size-3" /> Agents
                  {agentsLoading && (
                    <Loader2 className="size-3 animate-spin" />
                  )}
                </span>
              }
            >
              {agents.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`Chat with ${a.title}`}
                  onSelect={run(() => openChat(a))}
                >
                  <Bot className="size-4 mr-2" />
                  Chat with {a.title}
                </CommandItem>
              ))}
              {agentsLoading && agents.length === 0 && (
                <CommandItem disabled>Loading agents…</CommandItem>
              )}
            </CommandGroup>
          </>
        )}
      </CommandList>

      {/* Footer hint ---------------------------------------------------- */}
      <div className="border-t px-3 py-2 text-center text-[11px] text-muted-foreground">
        <span className="font-mono">↑↓</span> to navigate
        <span className="mx-2 opacity-40">·</span>
        <span className="font-mono">↵</span> to select
        <span className="mx-2 opacity-40">·</span>
        <span className="font-mono">esc</span> to close
      </div>
    </CommandDialog>
  );
}
