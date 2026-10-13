// POST /api/skills/import — the O3 import lane, P1-extended to BUNDLES.
//
// Body: an EXPORT document — either shape:
//   Single (O3):  { kind: "foundry-lab-skill", version: 1, skill: {…},
//                   id?: "custom.renamed" }        // rename-on-collision
//   Bundle (P1):  { kind: "foundry-lab-skill-bundle", version: 1,
//                   skills: [ {…}, {…} ],
//                   renames?: { "<original>": "custom.new-id" } }
//
// Contract:
//   - kind/version are checked first (400 on mismatch — arbitrary JSON
//     never registers as a skill).
//   - Every skill field runs through the SAME validators POST /api/skills
//     uses (label/description/endpoint/params/headers/latency/requires/
//     agents) — an imported skill is indistinguishable from a freshly
//     registered one.
//   - skillId must already be the canonical `custom.<slug>` form; the
//     custom. prefix is never inferred (imports carry explicit identity).
//     In a bundle, `renames[originalId]` overrides that skill's id — the
//     conflict dialog's "import skipped as suggested" path.
//   - SINGLE import: collision → 409 + deterministic `suggestion` (the
//     first free custom.<base>-2|-3|… id); success → 201 { skill }.
//   - BUNDLE import (P1): PER-SKILL outcomes, NO all-or-nothing rollback —
//     a bundle is a batch of independent registrations, so one collision
//     must not void the others. Response 200 with the honest report:
//       { requested, imported: [...], skipped: [{ skillId, suggestion? }],
//         failed: [{ skillId?, index, error }] }
//     (validation failures report per-skill; collisions report per-skill
//     with a rename suggestion so the client can offer a one-click retry).
//   - Imports land ENABLED (the document deliberately carries no enabled
//     state — an export of a disabled skill imports live).
//   - Duplicate skillIds WITHIN one bundle → failed entries (the second
//     occurrence collides with the first, which imports).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncCustomSkillsNow, reloadCustomSkills } from "@/lib/skills";
import {
  SKILL_ID_RE,
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

const SKILL_DOC_KIND = "foundry-lab-skill";
const BUNDLE_DOC_KIND = "foundry-lab-skill-bundle";
const SKILL_DOC_VERSION = 1;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.kind === BUNDLE_DOC_KIND) {
    return importBundle(body);
  }
  if (body.kind !== SKILL_DOC_KIND) {
    return NextResponse.json(
      {
        error:
          `Not a skill document — kind must be "${SKILL_DOC_KIND}" or ` +
          `"${BUNDLE_DOC_KIND}" (the envelopes GET /api/skills/export emits).`,
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
  return importSingle(body);
}

// ── SINGLE-skill import (O3 lane, unchanged shape + P3a agents) ─────────────

async function importSingle(body: Record<string, unknown>) {
  const skillBody = body.skill;
  if (!skillBody || typeof skillBody !== "object" || Array.isArray(skillBody)) {
    return NextResponse.json(
      { error: "skill must be an object (the exported skill declaration)" },
      { status: 400 },
    );
  }
  const doc = skillBody as Record<string, unknown>;

  const validated = validateSkillDoc(doc);
  if ("error" in validated && validated.error) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

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
      data: createData(skillId, validated),
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
    { skill: projection(skillId, validated, row.enabled) },
    { status: 201 },
  );
}

// ── BUNDLE import (P1: per-skill outcomes, no rollback) ─────────────────────

interface BundleSkip {
  skillId: string;
  suggestion: string | null;
}
interface BundleFail {
  skillId: string | null;
  index: number;
  error: string;
}

async function importBundle(body: Record<string, unknown>) {
  if (body.version !== SKILL_DOC_VERSION) {
    return NextResponse.json(
      {
        error:
          `Unsupported bundle document version ${JSON.stringify(body.version)} — ` +
          `this import lane understands version ${SKILL_DOC_VERSION}.`,
      },
      { status: 400 },
    );
  }
  const skillsBody = body.skills;
  if (!Array.isArray(skillsBody)) {
    return NextResponse.json(
      { error: "skills must be an array of skill declarations" },
      { status: 400 },
    );
  }
  if (skillsBody.length === 0) {
    return NextResponse.json(
      { error: "the bundle carries no skills (empty skills array)" },
      { status: 400 },
    );
  }
  if (skillsBody.length > 100) {
    return NextResponse.json(
      { error: "at most 100 skills per bundle import" },
      { status: 400 },
    );
  }
  const renames =
    body.renames && typeof body.renames === "object" &&
    !Array.isArray(body.renames)
      ? (body.renames as Record<string, unknown>)
      : {};
  const renamesValid =
    Object.entries(renames).every(
      ([k, v]) =>
        typeof k === "string" && k.startsWith("custom.") &&
        typeof v === "string" &&
        SKILL_ID_RE.test(v),
    ) || Object.keys(renames).length === 0;
  if (!renamesValid) {
    return NextResponse.json(
      {
        error:
          "renames must map custom.* ids to other custom.* ids (the " +
          "suggestion values this lane emits)",
      },
      { status: 400 },
    );
  }

  // The registry starts synced so the first collision check sees live truth.
  await syncCustomSkillsNow();
  const { getSkill } = await import("@/lib/skills");

  const imported: ReturnType<typeof projection>[] = [];
  const skipped: BundleSkip[] = [];
  const failed: BundleFail[] = [];
  const seenInBundle = new Set<string>();

  for (let i = 0; i < skillsBody.length; i++) {
    const item = skillsBody[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      failed.push({
        skillId: null,
        index: i,
        error: "each bundle entry must be a skill object",
      });
      continue;
    }
    const doc = item as Record<string, unknown>;

    const validated = validateSkillDoc(doc);
    if ("error" in validated && validated.error) {
      failed.push({
        skillId: typeof doc.skillId === "string" ? doc.skillId : null,
        index: i,
        error: validated.error,
      });
      continue;
    }

    // Identity: explicit skillId, optionally overridden by renames.
    const rename = renames[validated.skillId];
    const skillId =
      typeof rename === "string" && rename !== validated.skillId
        ? rename
        : validated.skillId;
    if (skillId !== validated.skillId && !SKILL_ID_RE.test(skillId)) {
      failed.push({
        skillId: validated.skillId,
        index: i,
        error: `renamed id must match ${SKILL_ID_RE}`,
      });
      continue;
    }
    if (seenInBundle.has(skillId)) {
      failed.push({
        skillId: skillId,
        index: i,
        error: `duplicate skill id "${skillId}" within this bundle`,
      });
      continue;
    }
    seenInBundle.add(skillId);

    // Collision (live registry OR table OR builtin alias space) → skip
    // with a suggestion (never aborts the rest — P1's whole point).
    if (getSkill(skillId) || (await db.customSkill.findUnique({ where: { skillId } }))) {
      const suggestion = await suggestFreeId(skillId);
      skipped.push({ skillId, suggestion });
      continue;
    }

    try {
      const row = await db.customSkill.create({
        data: createData(skillId, validated),
      });
      imported.push(projection(skillId, validated, row.enabled));
    } catch (e) {
      failed.push({
        skillId,
        index: i,
        error: (e as Error).message,
      });
    }
  }

  // One reload after the batch — the registry re-reads every row.
  await reloadCustomSkills();

  return NextResponse.json({
    requested: skillsBody.length,
    imported,
    skipped,
    failed,
  });
}

// ── shared validators / projections ─────────────────────────────────────────

interface ValidatedSkill {
  skillId: string;
  label: string;
  description: string;
  endpoint: string;
  params: unknown;
  headers?: Record<string, string>;
  latency: "fast" | "slow";
  requires: string[];
  agents: string[];
  error?: string;
}

/** Run the FULL POST /api/skills validation pipeline over one skill doc.
 *  Returns either { error } or the validated fields. */
function validateSkillDoc(doc: Record<string, unknown>): ValidatedSkill {
  const labelRes = validateLabel(doc.label);
  if (labelRes.error) return { ...EMPTY, error: labelRes.error };
  const descriptionRes = validateDescription(doc.description);
  if (descriptionRes.error) return { ...EMPTY, error: descriptionRes.error };
  const endpointRes = validateEndpoint(doc.endpoint);
  if (endpointRes.error) return { ...EMPTY, error: endpointRes.error };
  const paramRes = validateParamDefs(doc.params);
  if (paramRes.error) return { ...EMPTY, error: paramRes.error };
  const headerRes = validateHeaders(doc.headers);
  if (headerRes.error) return { ...EMPTY, error: headerRes.error };
  const latencyRes = validateLatency(doc.latency);
  if (latencyRes.error) return { ...EMPTY, error: latencyRes.error };
  const requiresRes = validateRequires(doc.requires);
  if (requiresRes.error) return { ...EMPTY, error: requiresRes.error };
  const agentsRes = validateAgents(doc.agents);
  if (agentsRes.error) return { ...EMPTY, error: agentsRes.error };

  const skillId = doc.skillId;
  if (typeof skillId !== "string" || !SKILL_ID_RE.test(skillId)) {
    return {
      ...EMPTY,
      error:
        `skill id must match ${SKILL_ID_RE} (the custom. prefix is ` +
        "required; lowercase letters, digits, - and _)",
    };
  }

  return {
    skillId,
    label: labelRes.label!,
    description: descriptionRes.description!,
    endpoint: endpointRes.endpoint!,
    params: paramRes.params ?? [],
    ...(headerRes.headers ? { headers: headerRes.headers } : {}),
    latency: latencyRes.latency ?? "fast",
    requires: requiresRes.requires ?? [],
    agents: agentsRes.agents ?? [],
  };
}

const EMPTY: ValidatedSkill = {
  skillId: "",
  label: "",
  description: "",
  endpoint: "",
  params: [],
  latency: "fast",
  requires: [],
  agents: [],
};

function createData(skillId: string, v: ValidatedSkill) {
  return {
    skillId,
    label: v.label,
    description: v.description,
    params: JSON.stringify(v.params ?? []),
    endpoint: v.endpoint,
    ...(v.headers ? { headers: JSON.stringify(v.headers) } : {}),
    enabled: true,
    latency: v.latency,
    requires: JSON.stringify(v.requires),
    agents: JSON.stringify(v.agents),
  };
}

function projection(
  skillId: string,
  v: ValidatedSkill,
  enabled: boolean,
) {
  return {
    id: skillId,
    label: v.label,
    description: v.description,
    endpoint: v.endpoint,
    headers: v.headers ?? null,
    params: v.params ?? [],
    latency: v.latency,
    requires: v.requires,
    agents: v.agents,
    enabled,
  };
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
