// PATCH/DELETE /api/skills/:skillId — manage a CUSTOM skill (M3 delete,
// N2 patch, O1 requires).
//
// PATCH body (all fields OPTIONAL — a partial update; at least one is
// required, an empty body is a 400):
//   {
//     label?:       string (1..80)
//     description?: string (1..400)
//     endpoint?:    http(s) URL (≤2000 chars)
//     params?:      SkillParamDef[] (≤6 — REPLACES the whole set)
//     headers?:     Record<string,string> (≤8 — REPLACES the whole set;
//                   null/{} clears them)
//     latency?:     "fast" | "slow"
//     requires?:    string[] (O1 — closed set "bioToolsEnabled" |
//                   "webSearchEnabled"; REPLACES the whole set; null/[]
//                   clears — every agent may invoke again)
//     enabled?:     boolean (soft switch — disabled rows leave the live
//                   registry: not invocable, not in prompts, but still
//                   listed in the catalog flagged for re-enabling)
//   }
//
// The row update + reloadCustomSkills() make the change live in THIS
// process immediately; other bundles converge on their next sync (≤1s TTL
// — #53). Editing does NOT touch audit history: past SkillInvocation rows
// keep their skillId; a latency/endpoint change only affects FUTURE runs.
//
// DELETE (M3): only the custom.* namespace is deletable: built-ins are
// part of the application (400), and an unknown id is a 404. Deleting
// removes the CustomSkill row AND unregisters it from the live process
// registry. Audit history is untouched (labels resolve to null for deleted
// skills — same honest degradation deleted agents already show).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reloadCustomSkills } from "@/lib/skills";
import {
  validateDescription,
  validateEndpoint,
  validateHeaders,
  validateLabel,
  validateLatency,
  validateParamDefs,
  validateRequires,
} from "@/lib/skills/custom-validation";

export const dynamic = "force-dynamic";

// ── PATCH: partial update (N2) ──────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;

  if (!skillId.startsWith("custom.")) {
    return NextResponse.json(
      {
        error:
          `"${skillId}" is not a custom skill — only custom.* skills ` +
          "registered through POST /api/skills can be edited; built-in " +
          "skills are part of the application.",
      },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const existing = await db.customSkill.findUnique({ where: { skillId } });
  if (!existing) {
    return NextResponse.json(
      { error: `No custom skill registered as "${skillId}"` },
      { status: 404 },
    );
  }

  // Field-by-field validation — each PRESENT field must be valid; absent
  // fields keep their current values. Mutually exclusive booleans need a
  // strict type check (HTTP booleans arrive as "true"/1 from sloppy
  // clients — reject with a clear message, same HTTP-boundary rule the
  // screening PATCH route follows).
  const data: Record<string, unknown> = {};
  const touched: string[] = [];

  if (body.label !== undefined) {
    const r = validateLabel(body.label);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.label = r.label;
    touched.push("label");
  }
  if (body.description !== undefined) {
    const r = validateDescription(body.description);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.description = r.description;
    touched.push("description");
  }
  if (body.endpoint !== undefined) {
    const r = validateEndpoint(body.endpoint);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.endpoint = r.endpoint;
    touched.push("endpoint");
  }
  if (body.params !== undefined) {
    const r = validateParamDefs(body.params);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.params = JSON.stringify(r.params ?? []);
    touched.push("params");
  }
  if (body.headers !== undefined) {
    // null (or an empty object) explicitly CLEARS the headers; an object
    // with entries replaces the whole set. Arrays/other shapes are 400s.
    if (body.headers === null) {
      data.headers = null;
      touched.push("headers");
    } else {
      const r = validateHeaders(body.headers);
      if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
      const entries = r.headers ?? {};
      data.headers =
        Object.keys(entries).length > 0 ? JSON.stringify(entries) : null;
      touched.push("headers");
    }
  }
  if (body.latency !== undefined) {
    const r = validateLatency(body.latency);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.latency = r.latency;
    touched.push("latency");
  }
  // O1: authorization declaration — an array REPLACES the whole set;
  // null (or []) clears it (back to "every agent may invoke"). Same
  // null-means-clear contract headers follow.
  if (body.requires !== undefined) {
    if (body.requires === null) {
      data.requires = JSON.stringify([]);
      touched.push("requires");
    } else {
      const r = validateRequires(body.requires);
      if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
      data.requires = JSON.stringify(r.requires ?? []);
      touched.push("requires");
    }
  }
  if (body.enabled !== undefined) {
    if (
      body.enabled !== true &&
      body.enabled !== false &&
      body.enabled !== "true" &&
      body.enabled !== "false"
    ) {
      return NextResponse.json(
        { error: `enabled must be a boolean (got ${JSON.stringify(body.enabled)})` },
        { status: 400 },
      );
    }
    // "true"/"false" string forms are accepted but normalized — the strict
    // 1/0/"1" variants are NOT (they are almost always client bugs).
    data.enabled = body.enabled === true || body.enabled === "true";
    touched.push("enabled");
  }

  if (touched.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing to update — provide at least one of label, description, " +
          "endpoint, params, headers, latency, requires, enabled.",
      },
      { status: 400 },
    );
  }

  try {
    const row = await db.customSkill.update({
      where: { skillId },
      data,
    });
    // Live in this process immediately (registry re-reads the table).
    await reloadCustomSkills();
    return NextResponse.json({
      skill: {
        id: row.skillId,
        label: row.label,
        description: row.description,
        endpoint: row.endpoint,
        headers: row.headers ? JSON.parse(row.headers) : null,
        params: JSON.parse(row.params),
        latency: row.latency === "slow" ? "slow" : "fast",
        // O1: closed-set parse of the persisted column (defensive against
        // legacy/corrupt values — the wire never carries unknown ids).
        requires: safeParseRequires(row.requires),
        enabled: row.enabled,
      },
      updated: touched,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Update failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}

function safeParseRequires(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r) => r === "bioToolsEnabled" || r === "webSearchEnabled",
      );
    }
  } catch {
    /* corrupt column — report requirement-free */
  }
  return [];
}

// ── DELETE: unregister (M3) ─────────────────────────────────────────────────

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;

  if (!skillId.startsWith("custom.")) {
    return NextResponse.json(
      {
        error:
          `"${skillId}" is not a custom skill — only custom.* skills ` +
          "registered through POST /api/skills can be deleted; built-in " +
          "skills are part of the application.",
      },
      { status: 400 },
    );
  }

  const existing = await db.customSkill.findUnique({ where: { skillId } });
  if (!existing) {
    return NextResponse.json(
      { error: `No custom skill registered as "${skillId}"` },
      { status: 404 },
    );
  }

  try {
    await db.customSkill.delete({ where: { skillId } });
  } catch (e) {
    return NextResponse.json(
      { error: `Delete failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Unregister from the live registry (this process).
  await reloadCustomSkills();

  return NextResponse.json({ deleted: skillId });
}
