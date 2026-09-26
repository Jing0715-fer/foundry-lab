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
import { ToolsPanel } from "@/components/panels/tools-panel";
import { DashboardPanel } from "@/components/panels/dashboard-panel";
import { EnvironmentPanel } from "@/components/panels/environment-panel";
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
import {
  useKeyboardShortcuts,
  type ShortcutConfig,
} from "@/lib/keyboard-shortcuts";
import type { WorkflowDTO } from "@/lib/types";

/**
 * Delete every node in the current multi-selection. Bound to both Delete and
 * Backspace (so it works on Mac keyboards where Backspace is the primary
 * "delete" key). Reads from the store at call time so it always operates on
 * the latest selection state.
 */
async function deleteSelectedNodes(): Promise<void> {
  const st = useAppStore.getState();
  const { selectedIds, removeNode, select, toast } = st;
  if (selectedIds.length === 0) return;
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
  okIds.forEach((id) => removeNode(id));
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
  const toast = useAppStore((s) => s.toast);

  const chatAgentId = useChatStore((s) => s.chatAgentId);
  const closeChat = useChatStore((s) => s.closeChat);

  // PI Copilot Sheet — local state (not in the activePanel union) so it can
  // float over the canvas while the user keeps working. Toggled from the
  // Sidebar's "PI Copilot" button.
  const [piCopilotOpen, setPiCopilotOpen] = React.useState(false);

  // Environment Sheet — same pattern as PI Copilot. The store's activePanel
  // union doesn't include "environment", so the panel floats over the canvas
  // as a Sheet. Toggled from the Sidebar's "Environment" button.
  const [environmentOpen, setEnvironmentOpen] = React.useState(false);

  // Cluster Sheet — same pattern as Environment. Hosts the Cluster Execution
  // panel (SSH/HPC connections, probe, tool launcher, cluster jobs). Toggled
  // from the Sidebar's "Cluster" button. Wider than Environment (sm:max-w-2xl)
  // because the cluster panel shows probe grids + live job logs.
  const [clusterOpen, setClusterOpen] = React.useState(false);

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

        // 3. Fetch workflow.
        try {
          const wRes = await fetch("/api/workflow");
          if (wRes.ok) {
            const w: WorkflowDTO = await wRes.json();
            if (!cancelled) setWorkflow(w);
          }
        } catch {
          /* swallow */
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setAgents, setAgentsLoading, setWorkflow, setLoading]);

  // Polling: refresh workflow when any node is running or pending.
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
        const res = await fetch("/api/workflow");
        if (!res.ok) return;
        const incoming: WorkflowDTO = await res.json();
        // Merge so server-side status updates land without losing local edits.
        useAppStore.getState().mergeNodes(incoming.nodes);
      } catch {
        /* swallow polling errors */
      }
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // Surface boot failures as a toast (best-effort, not blocking).
  React.useEffect(() => {
    const st = useAppStore.getState();
    if (st.error) {
      toast({
        title: "Load error",
        description: st.error,
        variant: "destructive",
      });
    }
  }, [toast]);

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
        description: "Cancel connection / close inspector",
        handler: () => {
          // Skip if a dialog / sheet / menu is open — those handle Esc themselves.
          if (
            document.querySelector(
              '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
            )
          ) {
            return;
          }
          const st = useAppStore.getState();
          if (st.pendingFrom) {
            st.cancelConnect();
            return;
          }
          if (st.inspectId) {
            st.inspect(null);
            return;
          }
          if (st.selectedId) {
            st.select(null);
          }
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
          onToggleEnvironment={() => setEnvironmentOpen((o) => !o)}
          clusterOpen={clusterOpen}
          onToggleCluster={() => setClusterOpen((o) => !o)}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          {activePanel === "canvas" && (
            <div className="flex min-h-0 flex-1">
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
          {activePanel === "tools" && <div className="min-h-0 flex-1 overflow-y-auto"><ToolsPanel /></div>}
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
      {/* Environment Sheet — left side, w-full sm:max-w-lg. Renders the
          Environment Management panel (tool scan + install UI). The sheet
          opens from the left so it doesn't overlap the right-side PI Copilot
          sheet (both can be open at once). SheetTitle/Description are
          sr-only because EnvironmentPanel renders its own visible header. */}
      <Sheet open={environmentOpen} onOpenChange={setEnvironmentOpen}>
        <SheetContent
          side="left"
          className="w-full gap-0 p-0 sm:max-w-lg"
        >
          <SheetTitle className="sr-only">Environment</SheetTitle>
          <SheetDescription className="sr-only">
            Scan the host for installed tools and copy install commands for
            missing ones.
          </SheetDescription>
          <EnvironmentPanel />
        </SheetContent>
      </Sheet>
      {/* Cluster Sheet — left side like Environment, but wider (probe grids +
      live remote log tails need the room). Hosts the Cluster Execution panel:
      SSH connections, environment probe, the on-cluster tool launcher, and the
      cluster job list with live polling. */}
      <Sheet open={clusterOpen} onOpenChange={setClusterOpen}>
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
