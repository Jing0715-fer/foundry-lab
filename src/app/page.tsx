"use client";

import * as React from "react";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { Footer } from "@/components/layout/footer";
import { ToastRenderer } from "@/components/toast-renderer";

// Components built by parallel agents (6-a, 6-b, 6-c). They are imported here
// per the shell contract; they will exist once those agents finish.
import { WorkflowCanvas } from "@/components/canvas/workflow-canvas";
import { NodePalette } from "@/components/canvas/palette";
import { NodeInspector } from "@/components/canvas/inspector";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AgentsPanel } from "@/components/panels/agents-panel";
import { TasksPanel } from "@/components/panels/tasks-panel";
import { MeetingsPanel } from "@/components/panels/meetings-panel";
import { ResearchPanel } from "@/components/panels/research-panel";
import AlphaFoldPanel from "@/components/panels/alphafold-panel";
import { ScreeningPanel } from "@/components/panels/screening-panel";
import { ToolsPanel } from "@/components/panels/tools-panel";
import { DashboardPanel } from "@/components/panels/dashboard-panel";
import { ClusterPanel } from "@/components/panels/cluster-panel";
import { PiCopilot } from "@/components/panels/pi-copilot";
import { AgentChatDrawer } from "@/components/panels/agent-chat-drawer";
import { CommandPalette } from "@/components/command-palette";
import { OnboardingTour, useTourStore } from "@/components/onboarding-tour";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

import { useAppStore } from "@/lib/store";
import { useChatStore } from "@/lib/chat-store";
import { useHistoryStore } from "@/lib/history-store";
import { withHistorySuppressed } from "@/lib/history-apply";
import {
  useKeyboardShortcuts,
  type ShortcutConfig,
} from "@/lib/keyboard-shortcuts";
import type { WorkflowDTO } from "@/lib/types";

/** True while a dialog / alertdialog / menu is open — those components own
 *  their own Escape/Delete handling, and a global Delete here would remove
 *  canvas nodes from BEHIND the dialog. */
function anyOverlayDialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
}

/**
 * Delete every node in the current multi-selection. Bound to both Delete and
 * Backspace (so it works on Mac keyboards where Backspace is the primary
 * "delete" key). Reads from the store at call time so it always operates on
 * the latest selection state.
 *
 * A history snapshot is pushed BEFORE the delete loop (a single Ctrl+Z then
 * restores the whole batch); the store removals run capture-suppressed so
 * the canvas subscription doesn't add a second, identical entry. Nodes are
 * only removed locally when their server DELETE actually succeeded — no
 * rollback needed, failed nodes honestly stay on the canvas.
 */
async function deleteSelectedNodes(): Promise<void> {
  const st = useAppStore.getState();
  const { selectedIds, select, toast, workflow } = st;
  if (selectedIds.length === 0) return;
  // Skip when a dialog / sheet / menu is open (the Escape handler's guard,
  // applied to the destructive keys too — Backspace must never delete
  // canvas nodes from behind an open dialog).
  if (anyOverlayDialogOpen()) return;
  // One snapshot for the whole batch (before ANY deletion).
  if (workflow) {
    useHistoryStore.getState().push({
      nodes: workflow.nodes,
      edges: workflow.edges,
      viewport: st.viewport,
    });
  }
  const results = await Promise.allSettled(
    selectedIds.map((id) =>
      fetch(`/api/workflow/nodes/${id}`, { method: "DELETE" }),
    ),
  );
  const okIds: string[] = [];
  let failCount = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ok) {
      okIds.push(selectedIds[i]);
    } else {
      failCount += 1;
    }
  });
  // Suppressed: the inline push above is the single capture for the batch.
  withHistorySuppressed(() => {
    okIds.forEach((id) => useAppStore.getState().removeNode(id));
  });
  select(null);
  if (failCount === 0) {
    toast({
      title: "Deleted",
      description: `${okIds.length} node${okIds.length === 1 ? "" : "s"} removed`,
      variant: "success",
    });
  } else {
    toast({
      title: "Some deletes failed",
      description: `${okIds.length} removed, ${failCount} failed`,
      variant: "destructive",
    });
  }
}

/**
 * Foundry Lab main shell. Single-page composition:
 *   Header
 *   [ Sidebar | main canvas/panel ]
 *   Footer
 *   ToastRenderer (fixed)
 *   AgentChatDrawer (overlay; agentId from useChatStore)
 *
 * On mount: idempotent POST /api/seed → fetch agents → fetch workflow.
 * Polling: every 3s, if any node is running/pending, refetch workflow and
 * merge the incoming nodes into the local store (so status updates flow in
 * without clobbering optimistic local edits).
 */
export default function Home() {
  const activePanel = useAppStore((s) => s.activePanel);
  const selectedId = useAppStore((s) => s.selectedId);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const setAgents = useAppStore((s) => s.setAgents);
  const setAgentsLoading = useAppStore((s) => s.setAgentsLoading);
  const setLoading = useAppStore((s) => s.setLoading);
  const setError = useAppStore((s) => s.setError);
  const toast = useAppStore((s) => s.toast);

  const chatAgentId = useChatStore((s) => s.chatAgentId);
  const closeChat = useChatStore((s) => s.closeChat);

  // PI Copilot Sheet — local state (not in the activePanel union) so it can
  // float over the canvas while the user keeps working. Toggled from the
  // Sidebar's "PI Copilot" button.
  const [piCopilotOpen, setPiCopilotOpen] = React.useState(false);

  // Environment Sheet — state lives in the Zustand store (not local) so any
  // component can deep-link into the tool-management layer from a usage
  // surface (e.g. the AlphaFold workbench header's "Environment" button,
  // the Environment panel's "Open workbench" reverse link). Toggled from
  // the Sidebar's "Environment" button as before.
  const environmentOpen = useAppStore((s) => s.environmentSheetOpen);
  const setEnvironmentSheetOpen = useAppStore((s) => s.setEnvironmentSheetOpen);

  // Cluster Sheet — store-backed for the same cross-link reason. Hosts the
  // Cluster Execution panel (SSH/HPC connections, probe, tool launcher,
  // cluster jobs). Toggled from the Sidebar's "Cluster" button. Wider than
  // Environment (sm:max-w-2xl) because the cluster panel shows probe grids +
  // live job logs.
  const clusterOpen = useAppStore((s) => s.clusterSheetOpen);
  const setClusterSheetOpen = useAppStore((s) => s.setClusterSheetOpen);

  // Boot sequence — runs once.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1. Idempotent seed.
        await fetch("/api/seed", { method: "POST" }).catch(() => null);

        // 2. Fetch agents.
        setAgentsLoading(true);
        try {
          const aRes = await fetch("/api/agents");
          if (aRes.ok) {
            const a = await aRes.json();
            if (!cancelled) setAgents(a);
          }
        } catch {
          /* swallow */
        } finally {
          if (!cancelled) setAgentsLoading(false);
        }

        // 3. Fetch workflow. Failures now setError (they used to be
        //    swallowed, which left the canvas spinner running forever) —
        //    the canvas renders an error + Retry card from store.error, and
        //    the toast below fires directly from this catch.
        try {
          const wRes = await fetch("/api/workflow");
          if (wRes.ok) {
            const w: WorkflowDTO = await wRes.json();
            if (!cancelled) setWorkflow(w);
          } else {
            if (!cancelled) {
              setError(`HTTP ${wRes.status} while loading the workflow.`);
              toast({
                title: "Load error",
                description: `Couldn't load the workflow (HTTP ${wRes.status}). Retry from the canvas.`,
                variant: "destructive",
              });
            }
          }
        } catch (e) {
          if (!cancelled) {
            const msg = e instanceof Error ? e.message : "network error";
            setError(`Couldn't reach the server: ${msg}`);
            toast({
              title: "Load error",
              description: "Couldn't load the workflow — the server may be down. Retry from the canvas.",
              variant: "destructive",
            });
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setAgents, setAgentsLoading, setWorkflow, setLoading, setError, toast]);

  // Polling: refresh workflow when any node is running or pending.
  // The poll fetches the CURRENT workflow by id (multi-workflow contract)
  // and merges BOTH nodes and edges so server-side deletions and edge
  // changes flow in (see store.mergeNodes for the dirty-field protection
  // and optimistic-edge handling).
  React.useEffect(() => {
    const interval = setInterval(async () => {
      const st = useAppStore.getState();
      const wf = st.workflow;
      if (!wf) return;
      const busy = wf.nodes.some(
        (n) => n.status === "running" || n.status === "pending",
      );
      if (!busy) return;
      try {
        const res = await fetch(`/api/workflows/${wf.id}`);
        if (!res.ok) return;
        const incoming: WorkflowDTO = await res.json();
        // Merge so server-side status updates land without losing local
        // edits (mergeNodes protects dirty nodes' name/params).
        useAppStore.getState().mergeNodes(incoming.nodes, incoming.edges);
      } catch {
        /* swallow polling errors */
      }
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // --- Onboarding tour auto-start ------------------------------------------
  // On first visit (no localStorage flag), open the tour after an 800ms delay
  // so the page has time to render first. The tour store's `close()` persists
  // the flag for next time.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const seen = localStorage.getItem("foundry-lab:tour-seen");
      if (!seen) {
        timer = setTimeout(() => {
          if (!cancelled) useTourStore.getState().start();
        }, 800);
      }
    } catch {
      // localStorage unavailable (SSR / private mode) — non-fatal.
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // --- Global keyboard shortcuts (Delete + Escape) ------------------------
  // Cmd+K / Ctrl+K is owned by the CommandPalette component itself.
  const shortcuts = React.useMemo<ShortcutConfig[]>(
    () => [
      {
        key: "Delete",
        skipInputs: true,
        description: "Delete selected node(s)",
        handler: deleteSelectedNodes,
      },
      {
        key: "Backspace",
        skipInputs: true,
        description: "Delete selected node(s) (Mac keyboards)",
        handler: deleteSelectedNodes,
      },
      {
        key: "Escape",
        // Escape must keep its native meaning inside text fields (blur /
        // clear the input) instead of cancelling canvas connections or the
        // selection — so it skips inputs AND only preventDefaults when the
        // handler actually acts.
        skipInputs: true,
        preventDefault: false,
        description: "Cancel connection / close inspector",
        handler: (e) => {
          // Skip if a dialog / sheet / menu is open — those handle Esc themselves.
          if (anyOverlayDialogOpen()) {
            return;
          }
          const st = useAppStore.getState();
          let acted = false;
          if (st.pendingFrom) {
            st.cancelConnect();
            acted = true;
          } else if (st.inspectId) {
            st.inspect(null);
            acted = true;
          } else if (st.selectedId) {
            st.select(null);
            acted = true;
          }
          if (acted) e.preventDefault();
        },
      },
    ],
    [],
  );
  useKeyboardShortcuts(shortcuts);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          piCopilotOpen={piCopilotOpen}
          onTogglePiCopilot={() => setPiCopilotOpen((o) => !o)}
          environmentOpen={environmentOpen}
          onToggleEnvironment={() => setEnvironmentSheetOpen(!environmentOpen)}
          clusterOpen={clusterOpen}
          onToggleCluster={() => setClusterSheetOpen(!clusterOpen)}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          {activePanel === "canvas" && (
            <div className="relative flex min-h-0 flex-1">
              <NodePalette />
              <div className="relative flex min-h-0 flex-1 flex-col">
                <WorkflowCanvas />
                <CanvasToolbar />
              </div>
              {selectedId && <NodeInspector />}
            </div>
          )}
          {activePanel === "dashboard" && <div className="min-h-0 flex-1 overflow-y-auto"><DashboardPanel /></div>}
          {activePanel === "agents" && <div className="min-h-0 flex-1 overflow-y-auto"><AgentsPanel /></div>}
          {activePanel === "tasks" && <div className="min-h-0 flex-1 overflow-y-auto"><TasksPanel /></div>}
          {activePanel === "meetings" && <div className="min-h-0 flex-1 overflow-y-auto"><MeetingsPanel /></div>}
          {activePanel === "research" && <div className="min-h-0 flex-1 overflow-y-auto"><ResearchPanel /></div>}
          {activePanel === "alphafold" && <div className="min-h-0 flex-1 overflow-y-auto"><AlphaFoldPanel /></div>}
          {activePanel === "screening" && <div className="min-h-0 flex-1 overflow-y-auto"><ScreeningPanel /></div>}
        </main>
      </div>
      <Footer />
      <ToastRenderer />
      <AgentChatDrawer
        agentId={chatAgentId}
        open={!!chatAgentId}
        onClose={closeChat}
      />
      {/* PI Copilot Sheet — right side, w-full sm:max-w-md. Renders the
          persistent chat panel; the user can chat with the PI while the
          canvas stays visible underneath. SheetTitle/Description are
          visually hidden (sr-only) because PiCopilot renders its own
          header, but are kept for a11y (Radix requires them). */}
      <Sheet open={piCopilotOpen} onOpenChange={setPiCopilotOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
        >
          <SheetTitle className="sr-only">PI Copilot</SheetTitle>
          <SheetDescription className="sr-only">
            Chat with the Principal Investigator orchestrator.
          </SheetDescription>
          <PiCopilot />
        </SheetContent>
      </Sheet>
      {/* Environment Sheet — left side, w-full sm:max-w-2xl. Renders the
          Environment & Toolchain panel (runtime deps + built-in engines +
          external tool status + one-click installs). Wider than the old
          environment viewer because it hosts engine provenance cards and
          streaming install terminals. */}
      <Sheet open={environmentOpen} onOpenChange={setEnvironmentSheetOpen}>
        <SheetContent
          side="left"
          className="w-full gap-0 p-0 sm:max-w-2xl"
        >
          <SheetTitle className="sr-only">Environment</SheetTitle>
          <SheetDescription className="sr-only">
            Scan the host for runtime dependencies and engine status, and
            one-click install missing pieces.
          </SheetDescription>
          <ToolsPanel />
        </SheetContent>
      </Sheet>
      {/* Cluster Sheet — left side like Environment, but wider (probe grids +
      live remote log tails need the room). Hosts the Cluster Execution panel:
      SSH connections, environment probe, the on-cluster tool launcher, and the
      cluster job list with live polling. */}
      <Sheet open={clusterOpen} onOpenChange={setClusterSheetOpen}>
        <SheetContent
          side="left"
          className="w-full gap-0 p-0 sm:max-w-2xl"
        >
          <SheetTitle className="sr-only">Cluster</SheetTitle>
          <SheetDescription className="sr-only">
            Run external tools on SSH-reachable HPC clusters — direct or via
            Slurm — with live logs and automatic output sync-back.
          </SheetDescription>
          <ClusterPanel />
        </SheetContent>
      </Sheet>
      <CommandPalette />
      <OnboardingTour />
    </div>
  );
}
