// P2a — server-side invocation-event emitter. Q2: the emit lane now carries
// the shared bearer token (the service rejects unauthenticated /emit with
// 401 — browsers can no longer forge invocation events through the gateway).
//
// Every SkillInvocation WRITE (the create in recordSkillInvocation + every
// conditional terminal transition in the K5 queue executor) also notifies
// the skill-events mini-service (socket.io on :3031), which routes the row
// to the subscribed rooms — the O2 4s poll becomes a PUSH channel.
//
// Contract (deliberately conservative):
//   - Fire-and-forget: the await NEVER blocks the invocation itself. A
//     dead events service costs at most a poll fallback tick, never a
//     wrong verdict or a slow pipeline.
//   - 1.5s timeout: a slow service must not pile up pending fetches.
//   - Silent failure: one console.warn per burst window, nothing more —
//     the audit row in SQLite remains the source of truth, the push is
//     just a live view onto it.
//   - No module-level state beyond the warn throttle + token cache — safe
//     to import from any route bundle (Turbopack multi-instance is harmless
//     here: duplicate emits are idempotent for consumers, which treat
//     events as "this row now looks like THIS" upserts).
//
// Token handling (Q2): the skill-events service generates a random token
// at first boot and persists it to mini-services/skill-events/.token
// (gitignored). We read the SAME file (TTL-cached — both processes run on
// this machine). A 401 drops the cache so the next emit re-reads it —
// service restarts that regenerate/rotate the token self-heal within one
// emit + one throttled warning.

import { promises as fs } from "fs";
import { resolve } from "path";
import type { SkillInvocation } from "@prisma/client";

/** Fixed service port (sandbox rule — no env, no discovery). */
const EVENTS_URL = "http://127.0.0.1:3031/emit";
const EMIT_TIMEOUT_MS = 1_500;
/** Warn at most once per 5 minutes while the service is unreachable. */
const WARN_INTERVAL_MS = 5 * 60_000;
let lastWarnAt = 0;

/** The shared emit token, co-located with the service (see header). */
const TOKEN_PATH = resolve(process.cwd(), "mini-services/skill-events/.token");
const TOKEN_TTL_MS = 30_000;
let tokenCache: { token: string | null; at: number } | null = null;

async function currentToken(): Promise<string | null> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache.token;
  }
  try {
    const t = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    tokenCache = { token: t || null, at: Date.now() };
  } catch {
    // Service not started yet (it writes the file at boot) — retry on a
    // later emit; the 401 path below also forces a re-read.
    tokenCache = { token: null, at: Date.now() };
  }
  return tokenCache.token;
}

/** The wire shape the events service broadcasts as event "invocation".
 *  Mirrors the SkillInvocationDTO the /api/skills/invocations lane
 *  serves — consumers upsert by id either way. */
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

export function invocationEventFromRow(
  row: SkillInvocation,
): SkillInvocationEvent {
  let params: Record<string, unknown> = {};
  try {
    params = row.params ? JSON.parse(row.params) : {};
  } catch {
    params = {};
  }
  return {
    id: row.id,
    skillId: row.skillId,
    source: row.source,
    agentId: row.agentId,
    agentTitle: row.agentTitle,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    status: row.status,
    params,
    resultSummary: row.resultSummary,
    error: row.error,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Best-effort broadcast of one invocation row write. NEVER throws. */
export function emitInvocationEvent(row: SkillInvocation): void {
  const payload = JSON.stringify({
    channel: "invocation",
    row: invocationEventFromRow(row),
  });
  void postEmit(payload);
}

async function postEmit(payload: string): Promise<void> {
  const token = await currentToken();
  try {
    const res = await fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    });
    if (res.status === 401) {
      // Stale/rotated token (or the service regenerated it at boot before
      // our cache filled) — drop the cache so the NEXT emit re-reads the
      // file. One throttled warn; the row in SQLite is unaffected.
      tokenCache = null;
      warnThrottled(
        "skill-events rejected the emit (401 — token mismatch; the token " +
          "cache was dropped and the next emit re-reads it)",
      );
    }
  } catch {
    // Service down / slow — the poll fallback covers the clients.
    warnThrottled(
      "skill-events service unreachable on :3031 — live refresh falls back " +
        "to polling (audit rows are unaffected)",
    );
  }
}

function warnThrottled(message: string): void {
  if (Date.now() - lastWarnAt > WARN_INTERVAL_MS) {
    lastWarnAt = Date.now();
    console.warn(`[skills] ${message}`);
  }
}
