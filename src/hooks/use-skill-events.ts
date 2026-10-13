"use client";

// P2a — the browser-side subscription to the skill-events push channel.
//
// ONE socket.io connection per BROWSER (module-level singleton, lazily
// connected when the first subscriber mounts, disconnected when the last
// unmounts). The connection URL follows the platform rule exactly:
// io("/?XTransformPort=3031") — relative path, port in the query, the
// Caddy gateway forwards to the skill-events mini-service.
//
// `useSkillEvents(onInvocation)` returns the live connection state:
//   - connected=true  → events are PUSHED (consumers idle their polls)
//   - connected=false → fall back to O2's polling (the row in SQLite is
//                       the source of truth either way — the push channel
//                       is a live view, never a verdict)
//
// Consumers treat every event as an UPSERT by invocation id: a row they
// already show flips in place; an unknown row is new (prepend if the
// filters admit it). Duplicate events are harmless by construction.

import * as React from "react";
import { io, type Socket } from "socket.io-client";

/** Mirrors the server's SkillInvocationEvent (see src/lib/skills/events.ts). */
export interface SkillInvocationEvent {
  id: string;
  skillId: string;
  source: string;
  agentId: string | null;
  agentTitle: string | null;
  workflowId: string | null;
  nodeId: string | null;
  status: string;
  params: Record<string, unknown>;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

type EventListener = (event: SkillInvocationEvent) => void;
type StatusListener = (connected: boolean) => void;

// ── module-level singleton (one connection per browser tab) ─────────────────
let socket: Socket | null = null;
let refCount = 0;
const eventListeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();
let connected = false;

function ensureSocket(): void {
  if (socket) return;
  socket = io("/?XTransformPort=3031", {
    transports: ["websocket", "polling"],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });
  socket.on("connect", () => {
    connected = true;
    statusListeners.forEach((l) => l(true));
  });
  socket.on("disconnect", () => {
    connected = false;
    statusListeners.forEach((l) => l(false));
  });
  socket.on("invocation", (row: unknown) => {
    if (!row || typeof row !== "object") return;
    const event = row as SkillInvocationEvent;
    if (typeof event.id !== "string" || typeof event.status !== "string") {
      return;
    }
    eventListeners.forEach((l) => l(event));
  });
}

function releaseSocket(): void {
  if (!socket) return;
  socket.disconnect();
  socket = null;
  connected = false;
}

/**
 * Subscribe to live skill-invocation events. Returns whether the push
 * channel is currently connected (false → keep polling as the fallback).
 * `onInvocation` is called for every event; `onStatusChange` (optional)
 * fires on connect/disconnect — consumers use it to re-probe immediately
 * after a reconnect (events during the gap were missed).
 */
export function useSkillEvents(
  onInvocation: EventListener,
  onStatusChange?: StatusListener,
): boolean {
  const handler = React.useRef(onInvocation);
  const statusHandler = React.useRef(onStatusChange);

  const [isConnected, setIsConnected] = React.useState(connected);

  // Keep the handler refs fresh OUTSIDE render (refs must not be written
  // during render — react-hooks/refs). An effect runs after every render,
  // which is exactly the freshness the singleton listeners need.
  React.useEffect(() => {
    handler.current = onInvocation;
    statusHandler.current = onStatusChange;
  });

  React.useEffect(() => {
    ensureSocket();
    refCount += 1;

    const eventListener: EventListener = (e) => handler.current(e);
    const statusListener: StatusListener = (c) => {
      setIsConnected(c);
      statusHandler.current?.(c);
    };
    eventListeners.add(eventListener);
    statusListeners.add(statusListener);
    // Sync with the CURRENT state (the socket may already be connected —
    // subscribing to a live socket must not leave stale "offline" state).
    setIsConnected(connected);

    return () => {
      eventListeners.delete(eventListener);
      statusListeners.delete(statusListener);
      refCount -= 1;
      if (refCount <= 0) {
        releaseSocket();
      }
    };
  }, []);

  return isConnected;
}
