// P2a — server-side invocation-event emitter.
//
// Every SkillInvocation WRITE (the create in recordSkillInvocation + every
// conditional terminal transition in the K5 queue executor) also notifies
// the skill-events mini-service (socket.io on :3031), which broadcasts to
// every connected browser — the O2 4s poll becomes a PUSH channel.
//
// Contract (deliberately conservative):
//   - Fire-and-forget: the await NEVER blocks the invocation itself. A
//     dead events service costs at most a poll fallback tick, never a
//     wrong verdict or a slow pipeline.
//   - 1.5s timeout: a slow service must not pile up pending fetches.
//   - Silent failure: one console.warn per burst window, nothing more —
//     the audit row in SQLite remains the source of truth, the push is
//     just a live view onto it.
//   - No module-level state beyond the warn throttle — safe to import
//     from any route bundle (Turbopack multi-instance is harmless here:
//     duplicate emits are idempotent for consumers, which treat events
//     as "this row now looks like THIS" upserts).

import type { SkillInvocation } from "@prisma/client";

/** Fixed service port (sandbox rule — no env, no discovery). */
const EVENTS_URL = "http://127.0.0.1:3031/emit";
const EMIT_TIMEOUT_MS = 1_500;
/** Warn at most once per 5 minutes while the service is unreachable. */
const WARN_INTERVAL_MS = 5 * 60_000;
let lastWarnAt = 0;

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
  fetch(EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
  }).catch(() => {
    // Service down / slow — the poll fallback covers the clients; warn
    // at most once per window so a dead service can't spam the log.
    if (Date.now() - lastWarnAt > WARN_INTERVAL_MS) {
      lastWarnAt = Date.now();
      console.warn(
        "[skills] skill-events service unreachable on :3031 — live refresh falls back to polling (audit rows are unaffected)",
      );
    }
  });
}
