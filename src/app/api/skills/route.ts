// GET/POST /api/skills — the skill registry catalog + dynamic registration.
//
// GET  (?agentId=): serves the serializable SkillCatalogEntry[] projection
//   (no handlers cross the wire). M3: custom skills are hydrated from the
//   CustomSkill table FIRST so registered webhooks appear in the catalog
//   (family "custom"). Optional ?agentId= resolves per-skill eligibility
//   against that agent's knowledge flags — the SAME rule runSkill enforces
//   at execution time, so the UI can never display a capability the
//   executor would deny.
//   N2: DISABLED custom rows are listed too (enabled: false) so the
//   management surface can see + re-enable them; their projections carry
//   headers/latency/enabled for the edit dialog. Disabled skills are not
//   in the live registry — they are not invocable, not advertised in
//   prompts, not eligible.
//
// POST (M3/K4, N1/N2, O1): register a custom webhook skill. Body:
//   {
//     label:       string (1..80, required)
//     description: string (1..400, required)
//     endpoint:    http(s) URL (required, ≤2000 chars) — POST target that
//                  receives {skillId, params, source, agent?, at} and whose
//                  2xx body becomes the skill result
//     id?:         "custom.<slug>" — auto-slugged from the label when
//                  omitted; collisions (built-ins, customs, alias space)
//                  are 409
//     params?:     SkillParamDef[] (≤6, keys ^[a-zA-Z_][a-zA-Z0-9_]{0,39}$)
//     headers?:    Record<string,string> (≤8, plain header passthrough)
//     latency?:    "fast" (default — ≤10s inline, 20s webhook timeout) |
//                  "slow" (N1 — agent/REST lanes enqueue it as a background
//                  ToolJob through the K5 queue)
//     requires?:   string[] (O1 — closed set "bioToolsEnabled" |
//                  "webSearchEnabled"; empty/omitted = every agent may
//                  invoke, the pre-O1 back-compatible default)
//   }
// The row is persisted, registered into the LIVE registry (this process),
// and served by every surface built-ins use: prompt manifest (eligible
// entries only), runSkill validation/gating/audit (requires ENFORCED at
// execution time), rate limits, Activity, Insights.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  catalogEntries,
  syncCustomSkillsNow,
  reloadCustomSkills,
} from "@/lib/skills";
import { parseKnowledge } from "@/lib/run-utils";
import type { SkillParamDef } from "@/lib/skills/types";
import {
  SKILL_ID_RE,
  slugify,
  validateAgents,
  validateDescription,
  validateEndpoint,
  validateHeaders,
  validateLabel,
  validateLatency,
  validateParamDefs,
  validateRequires,
} from "@/lib/skills/custom-validation";

export const dynamic = "force-dynamic";

export interface SkillCatalogResponse {
  skills: SkillCatalogEntryWire[];
  agentId?: string;
}

/** Wire shape: the catalog entry plus the N2 management projection for
 *  custom skills (endpoint always; headers/enabled only for customs). */
export interface SkillCatalogEntryWire {
  id: string;
  family: "comp" | "bio" | "web" | "canvas" | "custom";
  label: string;
  description: string;
  aliases: string[];
  params: SkillParamDef[];
  /** Knowledge requirement ids ("bioToolsEnabled" | "webSearchEnabled"). */
  requires: string[];
  latency: "fast" | "slow";
  rateLimit?: { max: number; windowMs: number };
  example?: Record<string, unknown>;
  endpoint?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  eligible?: boolean;
  /** P3a: agent-id whitelist (present on customs with a non-empty list). */
  agents?: string[];
}

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;

  // M3: FORCE a registry re-sync from the table (route bundles may hold
  // stale registries — Turbopack per-route module graphs; the sync also
  // returns the rows for the endpoint projection, so one read serves both).
  // N2: rows now include DISABLED ones (the catalog lists them flagged).
  const customRows = await syncCustomSkillsNow();

  let knowledge: { webSearchEnabled: boolean; bioToolsEnabled: boolean } | null = null;
  if (agentId) {
    const row = await db.agent.findUnique({ where: { id: agentId } });
    if (!row) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    knowledge = parseKnowledge(row.knowledge);
  }

  // Custom rows carry their webhook endpoint on the wire (the built-in
  // projection never does) — merge the management projection in so the
  // Registry cards can show + edit it. O1: requires rides along (the
  // registry projection already carries it for ENABLED rows — this merge
  // is for the edit-dialog prefill of DISABLED ones, where the registry
  // never sees the row).
  const rowById = new Map(
    customRows.map((c) => {
      let headers: Record<string, string> | undefined;
      try {
        const parsed = c.headers ? JSON.parse(c.headers) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          headers = parsed as Record<string, string>;
        }
      } catch {
        /* corrupt headers JSON — the card shows none */
      }
      let requires: string[] | undefined;
      try {
        const parsedReqs: unknown = JSON.parse(c.requires || "[]");
        if (Array.isArray(parsedReqs)) {
          requires = parsedReqs.filter(
            (r) => r === "bioToolsEnabled" || r === "webSearchEnabled",
          );
        }
      } catch {
        /* corrupt requires JSON — the card shows none */
      }
      // P3a: whitelist projection (defensive parse — same floor as the
      // registry loader: corrupt column → no whitelist on the wire).
      const agents = parseAgentsWire(c.agents);
      return [
        c.skillId,
        {
          endpoint: c.endpoint,
          enabled: c.enabled,
          latency: c.latency === "slow" ? ("slow" as const) : ("fast" as const),
          ...(requires && requires.length > 0 ? { requires } : {}),
          ...(agents.length > 0 ? { agents } : {}),
          ...(headers ? { headers } : {}),
        },
      ] as const;
    }),
  );

  const skills: SkillCatalogEntryWire[] = catalogEntries().map((s) => ({
    ...s,
    ...(rowById.has(s.id) ? rowById.get(s.id)! : {}),
    // P3a: eligible = requires ∧ whitelist (the SAME conjunction the
    // executor enforces — the UI can never call a skill eligible the
    // pipeline would refuse).
    ...(knowledge
      ? {
          eligible:
            s.requires.every((r) => knowledge![r] === true) &&
            (!s.agents || s.agents.length === 0 || s.agents.includes(agentId!)),
        }
      : {}),
  }));

  // N2: disabled customs are NOT in the live registry — project them from
  // the table rows so the catalog still lists them (flagged, re-enablable).
  // O1: requires comes from the row (the registry projection below only
  // covers enabled rows).
  const registered = new Set(skills.map((s) => s.id));
  for (const row of customRows) {
    if (row.enabled || registered.has(row.skillId)) continue;
    let params: SkillParamDef[] = [];
    try {
      const parsed = JSON.parse(row.params);
      if (Array.isArray(parsed)) params = parsed as SkillParamDef[];
    } catch {
      /* unparsable params — project none (the card still lists the skill) */
    }
    let requires: string[] = [];
    try {
      const parsedReqs: unknown = JSON.parse(row.requires || "[]");
      if (Array.isArray(parsedReqs)) {
        requires = parsedReqs.filter(
          (r) => r === "bioToolsEnabled" || r === "webSearchEnabled",
        );
      }
    } catch {
      /* corrupt requires JSON — project none */
    }
    const meta = rowById.get(row.skillId)!;
    skills.push({
      id: row.skillId,
      family: "custom",
      label: row.label,
      description: row.description,
      aliases: [],
      params,
      requires,
      latency: meta.latency,
      endpoint: meta.endpoint,
      enabled: false,
      // P3a: whitelist rides on the disabled projection too (the edit
      // dialog prefills from it — exactly why requires is here as well).
      ...(meta.agents && meta.agents.length > 0 ? { agents: meta.agents } : {}),
      ...(meta.headers ? { headers: meta.headers } : {}),
      ...(knowledge ? { eligible: false } : {}),
    });
  }

  return NextResponse.json({
    skills,
    ...(agentId ? { agentId } : {}),
  } as SkillCatalogResponse);
}

/** P3a: defensive whitelist parse for the wire projection. */
function parseAgentsWire(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of parsed) {
        if (typeof a !== "string") continue;
        const id = a.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    }
  } catch {
    /* corrupt column — project none */
  }
  return [];
}

// ── POST: registration ───────────────────────────────────────────────────────

interface RegistrationBody {
  label: string;
  description: string;
  endpoint: string;
  id?: string;
  params?: unknown;
  headers?: unknown;
  latency?: unknown;
  /** O1: closed-set requirement ids ([] when omitted). */
  requires?: unknown;
  /** P3a: agent-id whitelist ([] when omitted — requires alone decides). */
  agents?: unknown;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const labelRes = validateLabel(body.label);
  if (labelRes.error) {
    return NextResponse.json({ error: labelRes.error }, { status: 400 });
  }
  const label = labelRes.label!;
  const descriptionRes = validateDescription(
    body.description ?? label, // same default the dialog applies
  );
  if (descriptionRes.error) {
    return NextResponse.json({ error: descriptionRes.error }, { status: 400 });
  }
  const description = descriptionRes.description!;
  const endpointRes = validateEndpoint(body.endpoint);
  if (endpointRes.error) {
    return NextResponse.json({ error: endpointRes.error }, { status: 400 });
  }
  const endpoint = endpointRes.endpoint!;

  // Canonical id: explicit (must already be the custom.* form) or slugged
  // from the label. The prefix is FORCED — custom skills never squat on
  // built-in namespaces.
  let skillId: string;
  if (body.id !== undefined && body.id !== null) {
    if (typeof body.id !== "string" || !SKILL_ID_RE.test(body.id)) {
      return NextResponse.json(
        {
          error:
            `id must match ${SKILL_ID_RE} (the custom. prefix is required; ` +
            "lowercase letters, digits, - and _)",
        },
        { status: 400 },
      );
    }
    skillId = body.id;
  } else {
    skillId = `custom.${slugify(label)}`;
  }

  const paramRes = validateParamDefs(body.params);
  if (paramRes.error) {
    return NextResponse.json({ error: paramRes.error }, { status: 400 });
  }
  const headerRes = validateHeaders(body.headers);
  if (headerRes.error) {
    return NextResponse.json({ error: headerRes.error }, { status: 400 });
  }
  // N1: execution policy — "fast" (inline, 20s webhook cap) or "slow"
  // (background queue lane). Default "fast" keeps M3 behavior unchanged.
  const latencyRes = validateLatency(body.latency);
  if (latencyRes.error) {
    return NextResponse.json({ error: latencyRes.error }, { status: 400 });
  }
  const latency = latencyRes.latency ?? "fast";
  // O1: authorization declaration — closed set, [] when omitted (the
  // pre-O1 default keeps every existing registration back-compatible).
  const requiresRes = validateRequires(body.requires);
  if (requiresRes.error) {
    return NextResponse.json({ error: requiresRes.error }, { status: 400 });
  }
  const requires = requiresRes.requires ?? [];
  // P3a: the agent whitelist — validated but NOT checked against the
  // Agent table (portability: an exported whitelist may name agents this
  // instance doesn't have; such ids simply never clear the gate).
  const agentsRes = validateAgents(body.agents);
  if (agentsRes.error) {
    return NextResponse.json({ error: agentsRes.error }, { status: 400 });
  }
  const agents = agentsRes.agents ?? [];

  // Collisions: the live registry (force-synced — route bundles can hold
  // stale copies, #Turbopack) AND the table (another process/bundle may
  // have registered one this instance hasn't seen).
  await syncCustomSkillsNow();
  const { getSkill } = await import("@/lib/skills");
  if (getSkill(skillId)) {
    return NextResponse.json(
      { error: `skill id "${skillId}" is already registered` },
      { status: 409 },
    );
  }
  const existing = await db.customSkill.findUnique({ where: { skillId } });
  if (existing) {
    return NextResponse.json(
      { error: `skill id "${skillId}" already exists in the registry` },
      { status: 409 },
    );
  }

  let row;
  try {
    row = await db.customSkill.create({
      data: {
        skillId,
        label,
        description,
        params: JSON.stringify(paramRes.params ?? []),
        endpoint,
        ...(headerRes.headers ? { headers: JSON.stringify(headerRes.headers) } : {}),
        enabled: true,
        latency,
        requires: JSON.stringify(requires),
        agents: JSON.stringify(agents),
      },
    });
  } catch (e) {
    // Unique constraint race (two registrations in one window) → honest 409.
    return NextResponse.json(
      { error: `registration failed: ${(e as Error).message}` },
      { status: 409 },
    );
  }

  // Live in THIS process immediately; other processes hydrate on their
  // next ensure (registry is per-process by design — #43).
  await reloadCustomSkills();

  const entry = {
    id: row.skillId,
    family: "custom" as const,
    label: row.label,
    description: row.description,
    aliases: [],
    params: paramRes.params ?? [],
    requires,
    latency: row.latency === "slow" ? ("slow" as const) : ("fast" as const),
    endpoint: row.endpoint,
    enabled: row.enabled,
    ...(agents.length > 0 ? { agents } : {}),
  };
  return NextResponse.json({ skill: entry }, { status: 201 });
}
