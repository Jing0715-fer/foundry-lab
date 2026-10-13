// GET /api/skills/export — the O3 export lane, P1-extended to BUNDLES,
// Q3-extended to TEMPLATE PACKS (bundle version 2 + metadata).
//
// Three selectors (mutually exclusive — combining them is a 400):
//   ?skillId=custom.<slug>   → ONE portable skill document (O3 shape)
//   ?ids=custom.a,custom.b   → a BUNDLE document of the listed customs
//   ?all=1 | ?all=true       → a BUNDLE of every custom skill (enabled +
//                              disabled — definitions are portable even
//                              while inert)
//
// Single document (unchanged O3 contract):
//   { kind: "foundry-lab-skill", version: 1, exportedAt, skill: {…} }
//
// Bundle document — TWO versions:
//   version 1 (P1, the plain backup):
//     { kind: "foundry-lab-skill-bundle", version: 1, exportedAt, skills: […] }
//   version 2 (Q3, the shareable "skill pack" — emitted when ?name= and/or
//   ?description= accompany a bundle selector):
//     {
//       kind: "foundry-lab-skill-bundle",
//       version: 2,
//       exportedAt: "<ISO>",
//       metadata: { name, description, tags: ["…"] },  // narrative for
//                                                       // the marketplace
//                                                       // card / import
//                                                       // report
//       skills: [ … the same per-skill shape … ]
//     }
//   Metadata validation: name 1-80 chars (default "Foundry Lab skill pack"),
//   description ≤ 500, tags ≤ 8 strings of ≤ 24 chars each — 400 on breach.
//   Import understands BOTH versions (v1 documents keep flowing).
//
// Contract details:
//   - Only custom.* skills are exportable (built-ins are part of the
//     application — 400 naming the offending id, same boundary PATCH/
//     DELETE enforce). Unknown ids → 404 listing them.
//   - ?all with zero customs → 400 (nothing to bundle — honest, not an
//     empty success that looks like a download bug).
//   - Disabled skills ARE exportable (imports always land ENABLED).
//   - Content-Disposition invites a download but the body is plain JSON.
//   - Documents intentionally omit `enabled` (import policy: fresh
//     registrations come up enabled) and internal columns (id, timestamps).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const SKILL_DOC_KIND = "foundry-lab-skill";
const BUNDLE_DOC_KIND = "foundry-lab-skill-bundle";
const SKILL_DOC_VERSION = 1;
const BUNDLE_V1 = 1;
const BUNDLE_V2 = 2;

// Q3 metadata caps (mirrored by the import lane + the pack dialog).
const PACK_NAME_MAX = 80;
const PACK_DESC_MAX = 500;
const PACK_TAGS_MAX = 8;
const PACK_TAG_MAX = 24;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const skillId = sp.get("skillId")?.trim() ?? "";
  const idsParam = sp.get("ids")?.trim() ?? "";
  const allParam = sp.get("all")?.trim().toLowerCase() ?? "";

  // ── Q3: pack metadata (bundle lanes only — a single-skill document is
  //    not a pack). Present together with ?skillId → 400 (the selector
  //    boundary stays explicit).
  const packName = sp.get("name")?.trim() ?? "";
  const packDesc = sp.get("description")?.trim() ?? "";
  const packTagsRaw = sp.get("tags")?.trim() ?? "";
  const wantsMeta = packName !== "" || packDesc !== "" || packTagsRaw !== "";
  if (wantsMeta && skillId) {
    return NextResponse.json(
      {
        error:
          "Pack metadata (name/description/tags) belongs to a BUNDLE export " +
          "(?ids= or ?all=) — a single-skill document carries no metadata.",
      },
      { status: 400 },
    );
  }
  let packTags: string[] = [];
  if (packTagsRaw) {
    packTags = packTagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, PACK_TAGS_MAX);
    const bad = packTags.find((t) => t.length > PACK_TAG_MAX);
    if (bad) {
      return NextResponse.json(
        { error: `tag "${bad.slice(0, 40)}" exceeds ${PACK_TAG_MAX} chars` },
        { status: 400 },
      );
    }
  }
  if (packName.length > PACK_NAME_MAX) {
    return NextResponse.json(
      { error: `pack name exceeds ${PACK_NAME_MAX} chars` },
      { status: 400 },
    );
  }
  if (packDesc.length > PACK_DESC_MAX) {
    return NextResponse.json(
      { error: `pack description exceeds ${PACK_DESC_MAX} chars` },
      { status: 400 },
    );
  }

  const selectors = [
    skillId ? "skillId" : null,
    idsParam ? "ids" : null,
    ["1", "true", "yes"].includes(allParam) ? "all" : null,
  ].filter(Boolean) as string[];
  if (selectors.length > 1) {
    return NextResponse.json(
      {
        error:
          `Pick ONE export selector — got ${selectors.join(" + ")} ` +
          "(skillId for one skill, ids for a listed set, all for everything).",
      },
      { status: 400 },
    );
  }
  if (selectors.length === 0) {
    return NextResponse.json(
      {
        error:
          "Provide an export selector: ?skillId=custom.my-skill, " +
          "?ids=custom.a,custom.b, or ?all=1.",
      },
      { status: 400 },
    );
  }

  // ── Single-skill document (O3 lane, unchanged contract) ──────────────────
  if (selectors[0] === "skillId") {
    if (!skillId.startsWith("custom.")) {
      return NextResponse.json(
        {
          error:
            `"${skillId}" is not a custom skill — only custom.* skills are ` +
            "exportable; built-in skills are part of the application.",
        },
        { status: 400 },
      );
    }
    const row = await db.customSkill.findUnique({ where: { skillId } });
    if (!row) {
      return NextResponse.json(
        { error: `No custom skill registered as "${skillId}"` },
        { status: 404 },
      );
    }
    const doc = {
      kind: SKILL_DOC_KIND,
      version: SKILL_DOC_VERSION,
      exportedAt: new Date().toISOString(),
      skill: projectSkill(row),
    };
    return jsonResponse(doc, filenameFor(row.skillId));
  }

  // ── Bundle document (P1: listed ids or all customs) ──────────────────────
  let rows;
  if (selectors[0] === "ids") {
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'ids must be a comma-separated list of custom.* skill ids' },
        { status: 400 },
      );
    }
    if (ids.length > 100) {
      return NextResponse.json(
        { error: "at most 100 skills per bundle export" },
        { status: 400 },
      );
    }
    const nonCustom = ids.find((id) => !id.startsWith("custom."));
    if (nonCustom) {
      return NextResponse.json(
        {
          error:
            `"${nonCustom}" is not a custom skill — only custom.* skills ` +
            "are exportable; built-in skills are part of the application.",
        },
        { status: 400 },
      );
    }
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        return NextResponse.json(
          { error: `duplicate id "${id}" in the ids list` },
          { status: 400 },
        );
      }
      seen.add(id);
    }
    rows = await db.customSkill.findMany({
      where: { skillId: { in: ids } },
      orderBy: { createdAt: "asc" },
    });
    const found = new Set(rows.map((r) => r.skillId));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `No custom skill registered as ${missing
            .map((id) => `"${id}"`)
            .join(", ")}`,
        },
        { status: 404 },
      );
    }
  } else {
    rows = await db.customSkill.findMany({
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            "No custom skills are registered on this instance — nothing to " +
            "bundle. Register one first (or export a single skill by id).",
        },
        { status: 400 },
      );
    }
  }

  // Q3: metadata present → a version-2 "skill pack" document (the
  // shareable unit the Templates tab renders); absent → the plain v1
  // backup bundle (max compatibility with v1-only importers).
  const doc = wantsMeta
    ? {
        kind: BUNDLE_DOC_KIND,
        version: BUNDLE_V2,
        exportedAt: new Date().toISOString(),
        metadata: {
          name: packName || "Foundry Lab skill pack",
          ...(packDesc ? { description: packDesc } : {}),
          ...(packTags.length > 0 ? { tags: packTags } : {}),
        },
        skills: rows.map(projectSkill),
      }
    : {
        kind: BUNDLE_DOC_KIND,
        version: BUNDLE_V1,
        exportedAt: new Date().toISOString(),
        skills: rows.map(projectSkill),
      };
  const slug = wantsMeta
    ? (packName || "skill-pack")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
    : `skills-${rows.length}-bundle`;
  return jsonResponse(doc, `foundry-lab-${slug || "pack"}.json`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A CustomSkill row → the portable per-skill declaration shape (the same
 *  field set POST /api/skills accepts; P3a adds the agent whitelist). */
function projectSkill(row: {
  skillId: string;
  label: string;
  description: string;
  params: string;
  endpoint: string;
  headers: string | null;
  latency: string;
  requires: string;
  agents: string;
}): {
  skillId: string;
  label: string;
  description: string;
  endpoint: string;
  params: unknown;
  headers: Record<string, string> | null;
  latency: "fast" | "slow";
  requires: string[];
  agents: string[];
} {
  let params: unknown = [];
  try {
    params = JSON.parse(row.params);
  } catch {
    params = []; // defensive — the row was validated at registration
  }
  let headers: Record<string, string> | null = null;
  try {
    const parsed = row.headers ? JSON.parse(row.headers) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      headers = parsed as Record<string, string>;
    }
  } catch {
    headers = null;
  }
  return {
    skillId: row.skillId,
    label: row.label,
    description: row.description,
    endpoint: row.endpoint,
    params,
    headers,
    latency: row.latency === "slow" ? "slow" : "fast",
    requires: parseClosedSet(row.requires, ["bioToolsEnabled", "webSearchEnabled"]),
    agents: parseStringArray(row.agents),
  };
}

function parseClosedSet(raw: string, allowed: string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      const set = new Set(allowed);
      return parsed.filter((r): r is string => typeof r === "string" && set.has(r));
    }
  } catch {
    /* corrupt column — the honest floor */
  }
  return [];
}

function parseStringArray(raw: string): string[] {
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
    /* corrupt column — the honest floor */
  }
  return [];
}

function jsonResponse(doc: unknown, filename: string): NextResponse {
  return new NextResponse(JSON.stringify(doc, null, 2) + "\n", {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** `custom.foo-bar` → `custom-foo-bar.skill.json` (header-safe, no dots). */
function filenameFor(skillId: string): string {
  const slug = skillId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60);
  return `${slug}.skill.json`;
}
