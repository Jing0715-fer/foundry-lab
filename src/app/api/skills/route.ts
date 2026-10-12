// GET/POST /api/skills — the skill registry catalog + dynamic registration.
//
// GET  (?agentId=): serves the serializable SkillCatalogEntry[] projection
//   (no handlers cross the wire). M3: custom skills are hydrated from the
//   CustomSkill table FIRST so registered webhooks appear in the catalog
//   (family "custom"). Optional ?agentId= resolves per-skill eligibility
//   against that agent's knowledge flags — the SAME rule runSkill enforces
//   at execution time, so the UI can never display a capability the
//   executor would deny.
//
// POST (M3/K4): register a custom webhook skill. Body:
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
//   }
// The row is persisted, registered into the LIVE registry (this process),
// and served by every surface built-ins use: prompt manifest, runSkill
// validation/gating/audit, rate limits, Activity, Insights.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  catalogEntries,
  syncCustomSkillsNow,
  reloadCustomSkills,
} from "@/lib/skills";
import { parseKnowledge } from "@/lib/run-utils";
import type { SkillCatalogEntry, SkillParamDef } from "@/lib/skills/types";

export const dynamic = "force-dynamic";

export interface SkillCatalogResponse {
  skills: (SkillCatalogEntry & { eligible?: boolean })[];
  agentId?: string;
}

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;

  // M3: FORCE a registry re-sync from the table (route bundles may hold
  // stale registries — Turbopack per-route module graphs; the sync also
  // returns the rows for the endpoint projection, so one read serves both).
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
  // projection never does) — merge it in so the Registry cards can show it.
  const endpointById = new Map(
    customRows.map((c) => [c.skillId, c.endpoint] as const),
  );

  const skills = catalogEntries().map((s) => ({
    ...s,
    ...(endpointById.has(s.id) ? { endpoint: endpointById.get(s.id)! } : {}),
    ...(knowledge
      ? { eligible: s.requires.every((r) => knowledge![r] === true) }
      : {}),
  }));

  return NextResponse.json({
    skills,
    ...(agentId ? { agentId } : {}),
  } as SkillCatalogResponse);
}

// ── POST: registration ───────────────────────────────────────────────────────

const PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;
const SKILL_ID_RE = /^custom\.[a-z0-9][a-z0-9_-]{0,39}$/;
const PARAM_TYPES = new Set(["string", "number", "boolean", "json"]);
const MAX_PARAMS = 6;

interface RegistrationBody {
  label: string;
  description: string;
  endpoint: string;
  id?: string;
  params?: unknown;
  headers?: unknown;
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "skill";
}

function validateParamDefs(raw: unknown): {
  params?: SkillParamDef[];
  error?: string;
} {
  if (raw === undefined || raw === null) return { params: [] };
  if (!Array.isArray(raw)) {
    return { error: "params must be an array of param definitions" };
  }
  if (raw.length > MAX_PARAMS) {
    return { error: `at most ${MAX_PARAMS} params are allowed` };
  }
  const out: SkillParamDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "each param must be an object" };
    }
    const p = item as Record<string, unknown>;
    const key = typeof p.key === "string" ? p.key : "";
    if (!PARAM_KEY_RE.test(key)) {
      return { error: `param key "${key || "(missing)"}" must match ${PARAM_KEY_RE}` };
    }
    if (seen.has(key)) return { error: `duplicate param key "${key}"` };
    seen.add(key);
    const type = typeof p.type === "string" ? p.type : "";
    if (!PARAM_TYPES.has(type)) {
      return { error: `param "${key}": type must be string|number|boolean|json` };
    }
    const description =
      typeof p.description === "string" ? p.description.trim() : "";
    if (!description || description.length > 200) {
      return { error: `param "${key}": description is required (≤200 chars)` };
    }
    const def: SkillParamDef = {
      key,
      type: type as SkillParamDef["type"],
      description,
    };
    if (p.required === true) def.required = true;
    if (typeof p.default === "string" || typeof p.default === "number" || typeof p.default === "boolean") {
      def.default = p.default;
    }
    if (type === "number") {
      if (p.min !== undefined) {
        if (typeof p.min !== "number") return { error: `param "${key}": min must be a number` };
        def.min = p.min;
      }
      if (p.max !== undefined) {
        if (typeof p.max !== "number") return { error: `param "${key}": max must be a number` };
        def.max = p.max;
      }
    }
    out.push(def);
  }
  return { params: out };
}

function validateHeaders(raw: unknown): {
  headers?: Record<string, string>;
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "headers must be an object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 8) {
    return { error: "at most 8 header entries are allowed" };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k) || k.length > 60) {
      return { error: `invalid header name "${k}"` };
    }
    if (typeof v !== "string" || v.length > 500) {
      return { error: `header "${k}" value must be a string (≤500 chars)` };
    }
    out[k] = v;
  }
  return { headers: out };
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 80) {
    return NextResponse.json(
      { error: "label is required (1–80 characters)" },
      { status: 400 },
    );
  }
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > 400) {
    return NextResponse.json(
      { error: "description is required (1–400 characters)" },
      { status: 400 },
    );
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2000) {
    return NextResponse.json(
      { error: "endpoint is required (http/https URL, ≤2000 characters)" },
      { status: 400 },
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    return NextResponse.json(
      { error: `endpoint "${endpoint}" is not a valid URL` },
      { status: 400 },
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return NextResponse.json(
      { error: "endpoint must use http or https" },
      { status: 400 },
    );
  }

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

  const entry: SkillCatalogEntry = {
    id: row.skillId,
    family: "custom",
    label: row.label,
    description: row.description,
    aliases: [],
    params: paramRes.params ?? [],
    requires: [],
    latency: "fast",
    endpoint: row.endpoint,
  };
  return NextResponse.json({ skill: entry }, { status: 201 });
}
