// POST /api/skills/import — O3 import lane.
//
// Body: an EXPORT document (GET /api/skills/export output shape):
//   { kind: "foundry-lab-skill", version: 1, skill: { skillId, label,
//     description, endpoint, params, headers, latency, requires } }
// plus an OPTIONAL top-level id override:
//   { id: "custom.renamed" }   — the rename-on-collision re-submit
//
// Contract:
//   - kind must be "foundry-lab-skill" and version 1 (unknown envelope →
//     400; this is the portability boundary — arbitrary JSON never
//     registers as a skill).
//   - Every skill field runs through the SAME validators POST /api/skills
//     uses (label/description/endpoint/params/headers/latency/requires) —
//     an imported skill is indistinguishable from a freshly registered one.
//   - skillId must already be the canonical `custom.<slug>` form; the
//     custom. prefix is never inferred (imports carry explicit identity).
//   - Collisions (live registry OR table OR built-in alias space) → 409
//     with a deterministic `suggestion`: the first free
//     `custom.<base>-2|-3|…` id. The client offers "Import as
//     <suggestion>" and re-submits with { id: suggestion }.
//   - Imports land ENABLED (the document deliberately carries no enabled
//     state — an export of a disabled skill imports live).
//   - Success → 201 { skill } (the same entry projection POST returns).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncCustomSkillsNow, reloadCustomSkills } from "@/lib/skills";
import {
  SKILL_ID_RE,
  validateDescription,
  validateEndpoint,
  validateHeaders,
  validateLabel,
  validateLatency,
  validateParamDefs,
  validateRequires,
} from "@/lib/skills/custom-validation";

export const dynamic = "force-dynamic";

const SKILL_DOC_KIND = "foundry-lab-skill";
const SKILL_DOC_VERSION = 1;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.kind !== SKILL_DOC_KIND) {
    return NextResponse.json(
      {
        error:
          `Not a skill document — kind must be "${SKILL_DOC_KIND}" ` +
          "(the envelope exported by GET /api/skills/export).",
      },
      { status: 400 },
    );
  }
  if (body.version !== SKILL_DOC_VERSION) {
    return NextResponse.json(
      {
        error:
          `Unsupported skill document version ${JSON.stringify(body.version)} — ` +
          `this import lane understands version ${SKILL_DOC_VERSION}.`,
      },
      { status: 400 },
    );
  }
  const skillBody = body.skill;
  if (!skillBody || typeof skillBody !== "object" || Array.isArray(skillBody)) {
    return NextResponse.json(
      { error: "skill must be an object (the exported skill declaration)" },
      { status: 400 },
    );
  }
  const doc = skillBody as Record<string, unknown>;

  // ── Same validation pipeline POST /api/skills runs ────────────────────────
  const labelRes = validateLabel(doc.label);
  if (labelRes.error) return NextResponse.json({ error: labelRes.error }, { status: 400 });
  const label = labelRes.label!;

  const descriptionRes = validateDescription(doc.description);
  if (descriptionRes.error) {
    return NextResponse.json({ error: descriptionRes.error }, { status: 400 });
  }
  const description = descriptionRes.description!;

  const endpointRes = validateEndpoint(doc.endpoint);
  if (endpointRes.error) {
    return NextResponse.json({ error: endpointRes.error }, { status: 400 });
  }
  const endpoint = endpointRes.endpoint!;

  const paramRes = validateParamDefs(doc.params);
  if (paramRes.error) return NextResponse.json({ error: paramRes.error }, { status: 400 });

  const headerRes = validateHeaders(doc.headers);
  if (headerRes.error) return NextResponse.json({ error: headerRes.error }, { status: 400 });

  const latencyRes = validateLatency(doc.latency);
  if (latencyRes.error) {
    return NextResponse.json({ error: latencyRes.error }, { status: 400 });
  }
  const latency = latencyRes.latency ?? "fast";

  // O1: imports carry the authorization declaration through the same
  // closed-set validator.
  const requiresRes = validateRequires(doc.requires);
  if (requiresRes.error) {
    return NextResponse.json({ error: requiresRes.error }, { status: 400 });
  }
  const requires = requiresRes.requires ?? [];

  // ── Identity: explicit (document or rename override) — never inferred ────
  const idSource =
    body.id !== undefined && body.id !== null ? body.id : doc.skillId;
  if (typeof idSource !== "string" || !SKILL_ID_RE.test(idSource)) {
    return NextResponse.json(
      {
        error:
          `skill id must match ${SKILL_ID_RE} (the custom. prefix is ` +
          "required; lowercase letters, digits, - and _)",
      },
      { status: 400 },
    );
  }
  const skillId = idSource;

  // ── Collisions → 409 with a deterministic rename suggestion ──────────────
  await syncCustomSkillsNow();
  const { getSkill } = await import("@/lib/skills");
  if (getSkill(skillId)) {
    const suggestion = await suggestFreeId(skillId);
    return NextResponse.json(
      {
        error: `skill id "${skillId}" is already registered`,
        ...(suggestion ? { suggestion } : {}),
      },
      { status: 409 },
    );
  }
  const existing = await db.customSkill.findUnique({ where: { skillId } });
  if (existing) {
    const suggestion = await suggestFreeId(skillId);
    return NextResponse.json(
      {
        error: `skill id "${skillId}" already exists in the registry`,
        ...(suggestion ? { suggestion } : {}),
      },
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
      },
    });
  } catch (e) {
    // Unique-constraint race (e.g. a registration landed between the check
    // and the create) → honest 409 + suggestion, same as the explicit path.
    const suggestion = await suggestFreeId(skillId);
    return NextResponse.json(
      {
        error: `import failed: ${(e as Error).message}`,
        ...(suggestion ? { suggestion } : {}),
      },
      { status: 409 },
    );
  }

  // Live in THIS process immediately (registry re-reads the table).
  await reloadCustomSkills();

  return NextResponse.json(
    {
      skill: {
        id: row.skillId,
        label: row.label,
        description: row.description,
        endpoint: row.endpoint,
        headers: headerRes.headers ?? null,
        params: paramRes.params ?? [],
        latency,
        requires,
        enabled: row.enabled,
      },
    },
    { status: 201 },
  );
}

/** First free `custom.<base>-2|-3|…` id (base already slug-safe after the
 *  SKILL_ID_RE check). Checks the registry AND the table — the same two
 *  sources the collision checks consult. Returns null when no suffix in
 *  2..99 frees up (practically unreachable; the honest floor). */
async function suggestFreeId(takenId: string): Promise<string | null> {
  const base = takenId.slice("custom.".length).slice(0, 34);
  await syncCustomSkillsNow();
  const { getSkill } = await import("@/lib/skills");
  for (let n = 2; n < 100; n++) {
    const candidate = `custom.${base}-${n}`;
    if (getSkill(candidate)) continue;
    const row = await db.customSkill.findUnique({ where: { skillId: candidate } });
    if (row) continue;
    return candidate;
  }
  return null;
}
