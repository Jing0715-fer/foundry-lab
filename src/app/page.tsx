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
import { AgentChatDrawer } from "@/components/panels/agent-chat-drawer";

import { useAppStore } from "@/lib/store";
import { useChatStore } from "@/lib/chat-store";
import type { WorkflowDTO } from "@/lib/types";

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

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
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
          {activePanel === "dashboard" && <DashboardPanel />}
          {activePanel === "agents" && <AgentsPanel />}
          {activePanel === "tasks" && <TasksPanel />}
          {activePanel === "meetings" && <MeetingsPanel />}
          {activePanel === "research" && <ResearchPanel />}
          {activePanel === "tools" && <ToolsPanel />}
        </main>
      </div>
      <Footer />
      <ToastRenderer />
      <AgentChatDrawer
        agentId={chatAgentId}
        open={!!chatAgentId}
        onClose={closeChat}
      />
    </div>
  );
}
