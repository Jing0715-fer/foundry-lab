"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, Send, Trash2, Wrench, Database, Globe, type LucideIcon } from "lucide-react";
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
  const [streamingStarted, setStreamingStarted] = React.useState(false);
  const [agent, setAgent] = React.useState<AgentDTO | null>(null);
  const [atTop, setAtTop] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // Tracks the id of the in-flight assistant placeholder message that we
  // stream deltas into. Cleared once the server returns the real id.
  const streamingPlaceholderIdRef = React.useRef<string | null>(null);
  const agents = useAppStore((s) => s.agents);
  const toast = useAppStore((s) => s.toast);
  const MAX_CHARS = 2000;

  // Load chat history when opening with a new agentId. Deps are ONLY
  // [open, agentId]: including `agents` used to re-run this effect on every
  // background agents-array refresh (analytics poll, list edit), wiping the
  // conversation and refetching it mid-chat. The agents array is read at
  // call time via getState instead.
  React.useEffect(() => {
    if (!open || !agentId) return;
    const a = useAppStore.getState().agents.find((x) => x.id === agentId) ?? null;
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
  }, [open, agentId]);

  // Keep the header's agent label in sync with the (potentially refreshed)
  // agents array WITHOUT touching the conversation — a cheap label-only
  // update, never a refetch.
  React.useEffect(() => {
    if (!agentId) {
      setAgent(null);
      return;
    }
    setAgent(agents.find((x) => x.id === agentId) ?? null);
  }, [agentId, agents]);

  // Auto-scroll to bottom on new messages.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Track whether the message list is scrolled to the top (for the gradient overlay).
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 4);
  }, []);

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
    const placeholderId = `stream-${Date.now()}`;
    streamingPlaceholderIdRef.current = placeholderId;
    setMessages((prev) => [
      ...prev,
      optimisticUser,
      {
        id: placeholderId,
        agentId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    setInput("");
    setLoading(true);
    setStreamingStarted(false);

    let accumulated = "";
    let firstDeltaArrived = false;

    const patchPlaceholder = (patch: Partial<ChatMessageDTO>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholderId ? { ...m, ...patch } : m,
        ),
      );
    };

    try {
      const res = await fetch(`/api/agents/${agentId}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string })?.error ?? `HTTP ${res.status}`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";

      // Parse SSE frames. Events are separated by a blank line ("\n\n").
      // Within a frame, "event: X" sets the event name and "data: Y" carries
      // the JSON payload.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice("event: ".length).trim();
            } else if (line.startsWith("data: ")) {
              const dataStr = line.slice("data: ".length);
              let data: Record<string, unknown> = {};
              try {
                data = JSON.parse(dataStr) as Record<string, unknown>;
              } catch {
                data = { raw: dataStr };
              }

              if (currentEvent === "delta" && typeof data.delta === "string") {
                if (!firstDeltaArrived) {
                  firstDeltaArrived = true;
                  setStreamingStarted(true);
                }
                accumulated += data.delta;
                patchPlaceholder({ content: accumulated });
              } else if (currentEvent === "done") {
                if (typeof data.content === "string") {
                  accumulated = data.content;
                  patchPlaceholder({ content: accumulated });
                }
                // J lane: the stream route executes skills during the turn and
                // returns the invocation cards on done — merge them so the
                // user sees the executed skill without a refetch.
                if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
                  patchPlaceholder({
                    toolCalls: data.toolCalls as ChatMessageDTO["toolCalls"],
                  });
                }
                if (typeof data.messageId === "string") {
                  patchPlaceholder({ id: data.messageId });
                  streamingPlaceholderIdRef.current = null;
                }
              } else if (currentEvent === "error") {
                throw new Error(
                  typeof data.error === "string" ? data.error : "Streaming error",
                );
              }
            }
          }
        }
      }

      // If the stream ended without a "done" event (e.g. connection drop),
      // surface whatever partial text we accumulated so the user's turn isn't lost.
      if (streamingPlaceholderIdRef.current !== null) {
        if (accumulated.trim()) {
          patchPlaceholder({ content: accumulated });
        } else {
          patchPlaceholder({
            content: "> Stream ended unexpectedly. Please try again.",
          });
        }
        streamingPlaceholderIdRef.current = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Chat error", description: msg, variant: "destructive" });
      if (streamingPlaceholderIdRef.current !== null) {
        if (accumulated.trim()) {
          // Keep partial text + append an error footnote.
          patchPlaceholder({
            content: `${accumulated}\n\n> Error: ${msg}`,
          });
        } else {
          patchPlaceholder({ content: `> Error: ${msg}` });
        }
        streamingPlaceholderIdRef.current = null;
      }
    } finally {
      setLoading(false);
      setStreamingStarted(false);
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

        <div className="relative flex-1 overflow-hidden">
          {!atTop && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
              aria-hidden
            />
          )}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto px-4 py-4"
          >
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
                {messages.map((m) => {
                  // While streaming, the assistant placeholder bubble stays empty
                  // until the first token arrives. We hide the empty bubble and
                  // let the TypingIndicator cover the "agent is thinking" state.
                  if (
                    loading &&
                    m.role === "assistant" &&
                    m.content === "" &&
                    m.id === streamingPlaceholderIdRef.current
                  ) {
                    return null;
                  }
                  return <MessageBubble key={m.id} message={m} />;
                })}
                {loading && !streamingStarted && <TypingIndicator />}
              </div>
            )}
          </div>
        </div>

        <div className="border-t p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={onKeyDown}
            placeholder="Type a message… (Ctrl/Cmd+Enter to send)"
            className="min-h-[72px] resize-none"
            disabled={loading || !agentId}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {agent?.model ? `model: ${agent.model}` : ""}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {input.length}/{MAX_CHARS}
              </span>
              <Button size="sm" onClick={handleSend} disabled={!input.trim() || loading || !agentId}>
                <Send className="size-3.5" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TypingIndicator() {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-1 rounded-2xl bg-muted px-3.5 py-2.5">
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
      </div>
      <span className="text-xs text-muted-foreground">Agent is thinking…</span>
    </div>
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
  const isWeb = call.kind === "web";
  const Icon: LucideIcon = isComp ? Wrench : isWeb ? Globe : Database;
  const resultText = call.result ?? "";
  const truncated = resultText.length > 240 ? resultText.slice(0, 240) + "…" : resultText;
  const statusPill =
    call.status === "completed"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : call.status === "failed"
        ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
        : call.status === "running"
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground";
  return (
    <div className="rounded-md border bg-card p-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="uppercase tracking-wide text-muted-foreground">{call.kind}</span>
        <span className="font-mono">{call.skillId ?? call.tool}</span>
        {call.status && (
          <span
            className={`ml-auto inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase ${statusPill}`}
          >
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
