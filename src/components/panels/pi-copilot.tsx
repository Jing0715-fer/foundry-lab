"use client";

import * as React from "react";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  Send,
  Sparkles,
  Loader2,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

interface PiAction {
  type: "create_node" | "create_edge" | "run_node" | "run_workflow";
  nodeName?: string;
  fromNodeName?: string;
  toNodeName?: string;
  nodeType?: string;
  nodeRefTitle?: string;
  params?: Record<string, unknown>;
  fromPort?: string;
  toPort?: string;
}

interface PiMessage {
  role: "user" | "assistant";
  content: string;
  plan?: string[];
  actions?: PiAction[];
  timestamp: number;
}

const SUGGESTIONS = [
  "Design a binder against the SARS-CoV-2 RBD",
  "Predict the structure of a nanobody sequence",
  "Run a team meeting on enzyme design strategy",
];

/**
 * Persistent chat panel for talking to the PI (Principal Investigator).
 * The PI is an orchestrator — when the user describes a task, the PI plans
 * the work, creates nodes on the canvas, connects them, runs the workflow,
 * observes results, and reports back.
 *
 * This component is designed to be hosted inside a Sheet (right side). It
 * fills its parent's height and provides its own header, message list, and
 * input. The parent (page.tsx) controls open/close.
 */
export function PiCopilot() {
  const workflow = useAppStore((s) => s.workflow);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const toast = useAppStore((s) => s.toast);
  const [messages, setMessages] = React.useState<PiMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const send = async () => {
    if (!input.trim() || loading || !workflow) return;
    const userMsg: PiMessage = {
      role: "user",
      content: input,
      timestamp: Date.now(),
    };
    const history = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/pi/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          workflowId: workflow.id,
          history,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string })?.error ?? `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as {
        reply: string;
        plan: string[];
        actions: PiAction[];
      };

      const assistantMsg: PiMessage = {
        role: "assistant",
        content: data.reply || "(no reply)",
        plan: data.plan,
        actions: data.actions,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Refresh the workflow to show new nodes.
      const wfRes = await fetch("/api/workflow");
      if (wfRes.ok) {
        const wf = await wfRes.json();
        setWorkflow(wf);
      }

      // If the PI requested a workflow run, execute it.
      if (data.actions?.some((a) => a.type === "run_workflow")) {
        toast({
          title: "PI is running the workflow...",
          variant: "default",
        });
        const wfId = workflow?.id;
        await fetch("/api/workflow/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflowId: wfId }),
        });
        // Refresh again after run.
        const wfRes2 = wfId
          ? await fetch(`/api/workflows/${wfId}`)
          : await fetch("/api/workflow");
        if (wfRes2.ok) {
          const wf2 = await wfRes2.json();
          setWorkflow(wf2);
        }
        toast({ title: "Workflow complete", variant: "success" });
      }

      if (data.actions && data.actions.length > 0) {
        toast({
          title: `PI created ${data.actions.length} action(s) on canvas`,
          variant: "success",
        });
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `I encountered an error: ${
            (e as Error).message
          }. Please try again.`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-violet-500/10 text-violet-600">
          <Bot className="size-5" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">PI Copilot</h2>
          <p className="text-[11px] text-muted-foreground">
            Your research orchestrator
          </p>
        </div>
        <Sparkles className="ml-auto size-4 text-violet-400" />
      </div>

      {/* Messages */}
      <ScrollArea className="min-h-0 flex-1">
        <div ref={scrollRef} className="space-y-4 p-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-violet-500/10">
                <Bot className="size-6 text-violet-600" />
              </div>
              <div>
                <h3 className="text-sm font-medium">Hi! I&apos;m your PI.</h3>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  Describe a protein design task and I&apos;ll build + run the
                  workflow on the canvas.
                </p>
              </div>
              <div className="flex w-full flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setInput(s)}
                    className="rounded-lg border bg-card px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              PI is thinking...
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t p-3">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask the PI to design, predict, or analyze..."
            className="min-h-[44px] resize-none"
            rows={2}
          />
          <Button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            size="icon"
            className="shrink-0"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: PiMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] space-y-2",
          isUser ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {isUser ? (
            message.content
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>
        {/* Plan */}
        {message.plan && message.plan.length > 0 && (
          <div className="rounded-lg border bg-card p-2.5 text-xs">
            <div className="mb-1 flex items-center gap-1 font-medium text-muted-foreground">
              <ArrowRight className="size-3" /> Plan
            </div>
            <ol className="ml-4 list-decimal space-y-0.5">
              {message.plan.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        {/* Actions */}
        {message.actions && message.actions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.actions.map((a, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600"
              >
                <CheckCircle2 className="size-2.5" />
                {a.type === "create_node"
                  ? `Created ${a.nodeName}`
                  : a.type === "create_edge"
                    ? `Connected ${a.fromNodeName ?? "?"} → ${a.toNodeName ?? "?"}`
                    : a.type === "run_workflow"
                      ? "Ran workflow"
                      : a.type === "run_node"
                        ? `Ran ${a.nodeName}`
                        : a.type}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
