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
import type { SkillDefinition, SkillParamDef, SkillSource } from "./types";

const WEBHOOK_TIMEOUT_MS = 20_000;
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
 *  tests). */
export function registerCustomSkill(row: CustomSkillRow): void {
  let paramDefs: SkillParamDef[] = [];
  try {
    const parsed: unknown = JSON.parse(row.params);
    if (Array.isArray(parsed)) paramDefs = parsed as SkillParamDef[];
  } catch {
    // Handled by the caller (loader logs); register with no params.
  }
  registerSkill({
    id: row.skillId,
    family: "custom",
    label: row.label,
    description: row.description,
    aliases: [],
    params: paramDefs,
    requires: [],
    latency: "fast",
    handler: async (params, ctx) =>
      invokeWebhook(
        row.skillId,
        row.endpoint,
        row.headers,
        params,
        ctx.source,
        ctx.agent?.title ?? null,
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
      return "Custom webhook skill completed";
    },
  });
}

// ── internals ────────────────────────────────────────────────────────────────

async function resync(): Promise<CustomSkillRow[]> {
  const rows = await db.customSkill.findMany({
    where: { enabled: true },
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

  const after = rows.map((r) => r.skillId).sort().join(",");
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
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Webhook unreachable: ${msg}` +
        (e instanceof Error && e.name === "TimeoutError"
          ? ` (timeout after ${WEBHOOK_TIMEOUT_MS / 1000}s)`
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
