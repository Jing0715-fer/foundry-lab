// M3 (K4) — runtime-registered custom skills (custom.* webhook family).
//
// Custom skills are declared via POST /api/skills and stored in the
// CustomSkill table. This module hydrates them into the SAME in-process
// registry the built-ins live in, with a handler that POSTs the validated
// params to the registered webhook endpoint. Because they register as
// ordinary SkillDefinitions, everything the K lane built inherits with zero
// extra code: validateParams coercion, runSkill gating + error
// normalization + audit rows, per-agent rate limiting (custom family
// default), the Activity log, Insights aggregation, and the prompt
// manifest (agents are taught the new skill automatically).
//
// Sync model (the subtle part): route bundles may each hold their own
// instance of this module (Turbopack compiles per-route graphs — observed:
// a DELETE in one bundle left another bundle's catalog serving the stale
// entry). The DB table is the SHARED truth; every module instance
// converges to it with a small TTL cache:
//
//   ensureCustomSkillsLoaded()  — TTL-cached (≤1s stale) sync; chat/prompt/
//                                 insights/invoke lanes call this at turn
//                                 start. First call in an instance always
//                                 syncs.
//   syncCustomSkillsNow()      — FORCE re-sync (returns the rows); catalog
//                                 GET + registration/delete routes use it
//                                 so reads reflect the table immediately.
//                                 runSkill's resolve-miss fallback forces
//                                 too (a miss is exactly when a stale
//                                 registry shows).
//   reloadCustomSkills()       — force re-sync, void (register/delete
//                                 routes, after they write the table).
//
// The registry swap (unregister-all → register-all) runs synchronously
// between the table read and no awaits — concurrent readers in the same
// process never observe a half-swapped registry.

import { db } from "@/lib/db";
import { registerSkill, unregisterSkill, listSkills } from "./registry";
import type {
  SkillDefinition,
  SkillParamDef,
  SkillRequirement,
  SkillSource,
} from "./types";

const WEBHOOK_TIMEOUT_MS = 20_000;
/** N1: slow (queued) webhooks get a long leash — the K5 queue lane runs
 *  them in the background, so a 20s cap would defeat the whole point of
 *  registering a slow skill. Real stop still works mid-flight (the abort
 *  controller registered under runKey = jobId). */
const WEBHOOK_SLOW_TIMEOUT_MS = 10 * 60_000;
/** How stale a module instance's custom registry may be before re-syncing. */
const SYNC_TTL_MS = 1_000;

export interface CustomSkillRow {
  skillId: string;
  label: string;
  description: string;
  params: string;
  endpoint: string;
  headers: string | null;
  enabled: boolean;
  /** N1: "fast" | "slow" (unknown values coerce to "fast"). */
  latency: string;
  /** O1: JSON string array of SkillRequirement ids (unknown values are
   *  dropped defensively — the gate only understands the closed set). */
  requires: string;
}

// Per-module-instance sync state (see header — the DB is the shared truth;
// globalThis guards are exactly what caused cross-bundle staleness).
let lastSyncAt = 0;
let lastSync: Promise<void> | null = null;

/** TTL-cached hydration (≤1s stale). Chat/prompt/insights lanes. */
export function ensureCustomSkillsLoaded(): Promise<void> {
  if (lastSync && Date.now() - lastSyncAt <= SYNC_TTL_MS) {
    return lastSync;
  }
  return forceSync();
}

/** Force a full re-sync NOW and return the table's rows (catalog GET uses
 *  them for the endpoint projection). */
export function syncCustomSkillsNow(): Promise<CustomSkillRow[]> {
  const run = resync();
  lastSyncAt = Date.now();
  lastSync = run.then(
    () => undefined,
    (e: unknown) => {
      console.warn(
        "[skills] custom-skill sync failed:",
        e instanceof Error ? e.message : e,
      );
    },
  );
  return run;
}

/** Force re-sync, void (register/delete routes after they write the table). */
export async function reloadCustomSkills(): Promise<void> {
  await syncCustomSkillsNow();
}

/** Register a custom skill programmatically (loader path; exported for
 *  tests). N1: rows registered with latency "slow" are routed into the K5
 *  queue lane by every slowSkillPolicy "queue" consumer (chat/meeting/
 *  research/task lanes + REST invoke) — the queue executor calls the SAME
 *  handler, just in the background with a stoppable abort signal. */
export function registerCustomSkill(row: CustomSkillRow): void {
  let paramDefs: SkillParamDef[] = [];
  try {
    const parsed: unknown = JSON.parse(row.params);
    if (Array.isArray(parsed)) paramDefs = parsed as SkillParamDef[];
  } catch {
    // Handled by the caller (loader logs); register with no params.
  }
  // O1: parse the declared requirements. Defensive against corrupt/legacy
  // rows — anything that is not a known closed-set id is DROPPED (the gate
  // reads exactly these ids, so an unknown id would gate nothing while
  // looking like authorization; pre-O1 rows have no column value → "[]").
  const requires = parseRequires(row.requires);
  const slow = row.latency === "slow";
  registerSkill({
    id: row.skillId,
    family: "custom",
    label: row.label,
    description: row.description,
    aliases: [],
    params: paramDefs,
    requires,
    latency: slow ? "slow" : "fast",
    handler: async (params, ctx) =>
      invokeWebhook(
        row.skillId,
        row.endpoint,
        row.headers,
        params,
        ctx.source,
        ctx.agent?.title ?? null,
        // N1: a queued execution (K5 lane) passes its stoppable abort
        // controller through ctx.extras and gets the slow timeout; the
        // inline path keeps the 20s fast cap.
        {
          timeoutMs: slow ? WEBHOOK_SLOW_TIMEOUT_MS : WEBHOOK_TIMEOUT_MS,
          signal:
            ctx.extras?.webhookAbortSignal instanceof AbortSignal
              ? ctx.extras.webhookAbortSignal
              : undefined,
        },
      ),
    summarize: (data) => {
      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof (data as { summary?: unknown }).summary === "string" &&
        (data as { summary: string }).summary.trim()
      ) {
        return (data as { summary: string }).summary;
      }
      return slow
        ? "Custom webhook skill completed (background run)"
        : "Custom webhook skill completed";
    },
  });
}

// ── internals ────────────────────────────────────────────────────────────────

/** O1: closed-set parse of a requires JSON column ("[]"-shaped). */
const KNOWN_REQUIREMENTS = new Set<string>(["bioToolsEnabled", "webSearchEnabled"]);

function parseRequires(raw: string): SkillRequirement[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r): r is SkillRequirement => typeof r === "string" && KNOWN_REQUIREMENTS.has(r),
      );
    }
  } catch {
    // Corrupt column value — register requirement-free (the honest floor).
  }
  return [];
}

async function resync(): Promise<CustomSkillRow[]> {
  // N2: read ALL rows (enabled + disabled). Only ENABLED rows register —
  // a disabled skill is not invocable by any lane — but the caller gets the
  // full set so the catalog can list disabled entries (they carry their
  // enabled=false flag; re-enabling is the PATCH surface).
  const rows = await db.customSkill.findMany({
    orderBy: { createdAt: "asc" },
  });
  const before = currentCustomIds().sort().join(",");

  // Synchronous swap — no awaits between unregister and register, so no
  // reader in this process can observe the half-swapped state.
  for (const id of currentCustomIds()) {
    unregisterSkill(id);
  }
  let loaded = 0;
  for (const row of rows) {
    if (!row.enabled) continue; // N2: disabled rows stay unregistered
    try {
      JSON.parse(row.params); // validate before registering
    } catch {
      console.warn(
        `[skills] custom skill "${row.skillId}" has unparsable params — skipped`,
      );
      continue;
    }
    registerCustomSkill(row);
    loaded += 1;
  }

  const after = rows
    .filter((r) => r.enabled)
    .map((r) => r.skillId)
    .sort()
    .join(",");
  if (before !== after) {
    console.log(
      `[skills] custom registry synced (${loaded} skill${
        loaded === 1 ? "" : "s"
      }: ${after || "none"})`,
    );
  }
  return rows;
}

function forceSync(): Promise<void> {
  return syncCustomSkillsNow().then(() => undefined);
}

function currentCustomIds(): string[] {
  return listSkills()
    .filter((s) => s.family === "custom")
    .map((s) => s.id);
}

async function invokeWebhook(
  skillId: string,
  endpoint: string,
  headersJson: string | null,
  params: Record<string, unknown>,
  source: SkillSource,
  agentTitle: string | null,
  opts: {
    /** Fast inline calls: 20s. Slow queued calls: 10min (see constants). */
    timeoutMs: number;
    /** N1: the K5 queue lane passes a stoppable controller (runKey=jobId);
     * aborting it fails this fetch immediately → the conditional final
     * write keeps the honest cancelled verdict. */
    signal?: AbortSignal;
  },
): Promise<unknown> {
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  if (headersJson) {
    try {
      const extra = JSON.parse(headersJson);
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        headers = { ...headers, ...(extra as Record<string, string>) };
      }
    } catch {
      // Stored headers are corrupt — proceed with defaults (the row was
      // validated at registration; this is a defensive parse only).
    }
  }

  let res: Response;
  try {
    // Combine the timeout with the external stop signal: whichever fires
    // first aborts the fetch. AbortSignal.any is available in the Node/Bun
    // runtimes this server targets (20+).
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        skillId,
        params,
        source,
        ...(agentTitle ? { agent: agentTitle } : {}),
        at: new Date().toISOString(),
      }),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Webhook unreachable: ${msg}` +
        (e instanceof Error && e.name === "TimeoutError"
          ? ` (timeout after ${opts.timeoutMs / 1000}s)`
          : ""),
    );
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Webhook responded ${res.status} ${res.statusText}` +
        (text ? `: ${text.slice(0, 300)}` : ""),
    );
  }
  if (!text.trim()) {
    return { ok: true, note: "webhook returned an empty body" };
  }
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON 2xx body — pass through as text data (honest, still useful).
    return { ok: true, response: text.slice(0, 2000) };
  }
}
