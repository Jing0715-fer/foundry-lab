"use client";

// P2a — the browser-side subscription to the skill-events push channel.
// Q2 — the channel is now ROOM-AWARE: each subscriber declares the rooms
// it needs ("all", "agent:<id>", "workflow:<id>") and the singleton socket
// subscribes to the UNION of every active subscriber's rooms (the service
// routes each invocation row to the rooms its attribution implies).
//
// ONE socket.io connection per BROWSER (module-level singleton, lazily
// connected when the first subscriber mounts, disconnected when the last
// unmounts). The connection URL follows the platform rule exactly:
// io("/?XTransformPort=3031") — relative path, port in the query, the
// Caddy gateway forwards to the skill-events mini-service.
//
// `useSkillEvents(onInvocation, onStatusChange?, rooms?)` returns the live
// connection state:
//   - connected=true  → events are PUSHED (consumers idle their polls)
//   - connected=false → fall back to O2's polling (the row in SQLite is
//                       the source of truth either way — the push channel
//                       is a live view, never a verdict)
//
// rooms defaults to ["all"] (the firehose — the Skills Activity tab's
// view). A chat drawer narrows to ["agent:<agentId>"]: its queued cards
// belong to that agent's invocations, so the drawer does not need other
// agents' rows. The union semantics matter when BOTH surfaces are open —
// the socket then carries ["all", "agent:x"] and each consumer filters
// what it renders (as before), while the server keeps routing rows to
// the rooms that asked for them.
//
// Reconnect: a fresh socket connection loses server-side room membership
// (socket.io re-join only covers rooms joined during THAT connection), so
// every "connect" re-sends the current union subscription. The service
// default-joins "all" on connect — between (re)connect and the subscribe
// landing, extra events may arrive; consumers already filter, so this is
// harmless.
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

/** Rooms a subscriber wants — closed grammar, validated server-side too. */
export type SkillEventRoom = "all" | `agent:${string}` | `workflow:${string}`;

// ── module-level singleton (one connection per browser tab) ─────────────────
let socket: Socket | null = null;
let refCount = 0;
const eventListeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();
let connected = false;

/** Per-subscriber declared rooms, keyed by subscription id. */
const subscriberRooms = new Map<number, Set<string>>();
let nextSubId = 1;
/** Serialized room set last sent to the service (null = not yet synced —
 *  forces the subscribe to be (re-)sent on the next opportunity). */
let lastSentRooms: string | null = null;

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
    // Q2: (re)establish the room subscription — server-side membership
    // died with the previous connection. Reset the dedupe key so the
    // subscribe is actually sent, not swallowed as a no-op.
    lastSentRooms = null;
    syncSubscription();
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
  lastSentRooms = null;
}

/** Send the UNION of all active subscribers' rooms to the service when it
 *  differs from the last sent set — including the EMPTY set (the clear:
 *  leave every managed room; a closed drawer receives nothing). Idempotent;
 *  never throws. */
function syncSubscription(): void {
  if (!socket) return;
  const union = new Set<string>();
  for (const set of subscriberRooms.values()) {
    for (const room of set) union.add(room);
  }
  const key = [...union].sort().join(",");
  if (key === lastSentRooms) return;
  lastSentRooms = key;
  socket.emit(
    "subscribe",
    { rooms: [...union] },
    (reply: unknown) => {
      const r = reply as { ok?: boolean; error?: string } | null;
      if (!r || r.ok !== true) {
        // The service rejected the payload — a programming error in the
        // room grammar. Log once per attempt; consumers keep polling.
        console.warn("[skill-events] subscribe rejected:", r?.error ?? reply);
      }
    },
  );
}

/** `undefined` → the firehose default ("all" — the Activity tab's view).
 *  An EXPLICIT empty array means "no rooms" (the closed-drawer clear —
 *  the socket receives nothing until the surface re-subscribes). */
function normalizeRooms(rooms: SkillEventRoom[] | undefined): Set<string> {
  if (!rooms) return new Set(["all"]);
  const set = new Set<string>();
  for (const room of rooms) {
    if (typeof room === "string" && room) set.add(room);
  }
  return set;
}

/**
 * Subscribe to live skill-invocation events. Returns whether the push
 * channel is currently connected (false → keep polling as the fallback).
 * `onInvocation` is called for every event admitted by the subscribed
 * rooms; `onStatusChange` (optional) fires on connect/disconnect —
 * consumers use it to re-probe immediately after a reconnect (events
 * during the gap were missed).
 *
 * `rooms` (optional, Q2) narrows what this subscriber needs —
 * ["agent:<id>"] for an agent-scoped chat drawer, ["workflow:<id>"] for a
 * canvas run view, ["all"] (the default) for the firehose, or [] for
 * "nothing" (a closed drawer explicitly opts out). The socket carries the
 * union across all mounted subscribers.
 */
export function useSkillEvents(
  onInvocation: EventListener,
  onStatusChange?: StatusListener,
  rooms?: SkillEventRoom[],
): boolean {
  const handler = React.useRef(onInvocation);
  const statusHandler = React.useRef(onStatusChange);

  // Stable dep: the SORTED room set serialized. A new array identity with
  // the same rooms does not re-run the subscription effect (join collapses
  // identity churn into the string the effect actually keys on).
  const roomsParam = rooms?.join(",");
  const roomsKey = React.useMemo(
    () => [...normalizeRooms(rooms)].sort().join(","),
    [roomsParam],
  );

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

    const subId = nextSubId++;
    // "" (the empty union) parses to NO rooms — `"".split(",")` would
    // otherwise yield [""] and try to join a bogus "" room.
    subscriberRooms.set(
      subId,
      new Set(roomsKey === "" ? [] : roomsKey.split(",")),
    );
    syncSubscription();

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
      subscriberRooms.delete(subId);
      refCount -= 1;
      if (refCount <= 0) {
        releaseSocket();
        subscriberRooms.clear();
      } else {
        // The union may have narrowed — bring the service in line.
        syncSubscription();
      }
    };
  }, [roomsKey]);

  return isConnected;
}
