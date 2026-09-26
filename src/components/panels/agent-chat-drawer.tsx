"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, Send, Trash2, Wrench, FlaskConical } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/lib/store";
import type { AgentDTO, ChatMessageDTO, ToolCall } from "@/lib/types";

export function AgentChatDrawer({
  agentId,
  open,
  onClose,
}: {
  agentId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = React.useState<ChatMessageDTO[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [agent, setAgent] = React.useState<AgentDTO | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const agents = useAppStore((s) => s.agents);
  const toast = useAppStore((s) => s.toast);

  // Load chat history when opening with a new agentId.
  React.useEffect(() => {
    if (!open || !agentId) return;
    const a = agents.find((x) => x.id === agentId) ?? null;
    setAgent(a);
    setLoading(true);
    setMessages([]);
    (async () => {
      try {
        const res = await fetch(`/api/agents/${agentId}/chat`);
        if (res.ok) {
          const data = await res.json();
          setMessages(Array.isArray(data) ? data : []);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [open, agentId, agents]);

  // Auto-scroll to bottom on new messages.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !agentId || loading) return;
    const optimisticUser: ChatMessageDTO = {
      id: `tmp-${Date.now()}`,
      agentId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const assistant: ChatMessageDTO = await res.json();
      setMessages((prev) => [...prev, assistant]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Chat error", description: msg, variant: "destructive" });
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          agentId,
          role: "assistant",
          content: `> Error: ${msg}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/chat`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessages([]);
      toast({ title: "Chat cleared", variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Failed to clear", description: msg, variant: "destructive" });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {agent && (
                <span
                  className="flex size-7 items-center justify-center rounded-full text-xs font-semibold text-white"
                  style={{ background: agent.color }}
                >
                  {agent.title.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div>
                <SheetTitle className="text-base">{agent?.title ?? "Agent chat"}</SheetTitle>
                <SheetDescription className="text-xs">
                  {agent?.expertise ?? "Chat with this agent"}
                </SheetDescription>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={messages.length === 0}
              title="Clear chat"
            >
              <Trash2 className="size-4" />
              Clear
            </Button>
          </div>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          {loading && messages.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading chat…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-12 text-center text-sm text-muted-foreground">
              No messages yet. Send a prompt below to start the conversation.
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Agent is thinking…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message… (Ctrl/Cmd+Enter to send)"
            className="min-h-[72px] resize-none"
            disabled={loading || !agentId}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {agent?.model ? `model: ${agent.model}` : ""}
            </span>
            <Button size="sm" onClick={handleSend} disabled={!input.trim() || loading || !agentId}>
              <Send className="size-3.5" />
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MessageBubble({ message }: { message: ChatMessageDTO }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex flex-col items-start gap-2"}>
      <div
        className={
          isUser
            ? "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground"
            : "max-w-[90%] rounded-2xl bg-muted px-3.5 py-2 text-sm"
        }
      >
        {isUser ? (
          message.content
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="flex w-full flex-col gap-1.5">
          {message.toolCalls.map((tc, i) => (
            <ToolCallCard key={`${tc.tool}-${i}`} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const isComp = call.kind === "comp";
  const Icon = isComp ? Wrench : FlaskConical;
  const resultText = call.result ?? "";
  const truncated = resultText.length > 240 ? resultText.slice(0, 240) + "…" : resultText;
  return (
    <div className="rounded-md border bg-card p-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="uppercase tracking-wide text-muted-foreground">{call.kind}</span>
        <span className="font-mono">{call.tool}</span>
        {call.status && (
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
            {call.status}
          </span>
        )}
      </div>
      {Object.keys(call.params ?? {}).length > 0 && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(call.params)}
        </pre>
      )}
      {truncated && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
          {truncated}
        </pre>
      )}
    </div>
  );
}
