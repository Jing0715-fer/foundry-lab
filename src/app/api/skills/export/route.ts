// GET /api/skills/export?skillId=custom.<slug> — O3 export lane.
//
// Returns a portable JSON document describing ONE custom skill — the
// CustomSkill row projected into its declaration form (the same field set
// POST /api/skills accepts) plus a document envelope:
//
//   {
//     "kind": "foundry-lab-skill",
//     "version": 1,
//     "exportedAt": "<ISO>",
//     "skill": {
//       "skillId": "custom.foo",
//       "label": "...",
//       "description": "...",
//       "endpoint": "https://…",
//       "params": [ { key, type, required?, default?, min?, max?, description } ],
//       "headers": { … } | null,
//       "latency": "fast" | "slow",
//       "requires": [ "bioToolsEnabled" | "webSearchEnabled" ]   // O1
//     }
//   }
//
// Contract details:
//   - Only custom.* skills are exportable (built-ins are part of the
//     application — 400, same boundary PATCH/DELETE enforce).
//   - Unknown skillId → 404.
//   - Disabled skills ARE exportable (the definition is portable even while
//     inert; imports always land ENABLED).
//   - Content-Disposition invites a download but the body is plain JSON —
//     programmatic consumers (tests, CI) can just parse it.
//   - The document intentionally omits `enabled` (import policy: fresh
//     registrations come up enabled) and every internal column (id,
//     timestamps).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const SKILL_DOC_KIND = "foundry-lab-skill";
const SKILL_DOC_VERSION = 1;

export async function GET(request: NextRequest) {
  const skillId = request.nextUrl.searchParams.get("skillId")?.trim() ?? "";

  if (!skillId) {
    return NextResponse.json(
      { error: "skillId is required (e.g. ?skillId=custom.my-skill)" },
      { status: 400 },
    );
  }
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
  let requires: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.requires || "[]");
    if (Array.isArray(parsed)) {
      requires = parsed.filter(
        (r) => r === "bioToolsEnabled" || r === "webSearchEnabled",
      );
    }
  } catch {
    requires = [];
  }

  const doc = {
    kind: SKILL_DOC_KIND,
    version: SKILL_DOC_VERSION,
    exportedAt: new Date().toISOString(),
    skill: {
      skillId: row.skillId,
      label: row.label,
      description: row.description,
      endpoint: row.endpoint,
      params,
      headers,
      latency: row.latency === "slow" ? "slow" : "fast",
      requires,
    },
  };

  return new NextResponse(JSON.stringify(doc, null, 2) + "\n", {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameFor(row.skillId)}"`,
    },
  });
}

/** `custom.foo-bar` → `custom-foo-bar.skill.json` (header-safe, no dots). */
function filenameFor(skillId: string): string {
  const slug = skillId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60);
  return `${slug}.skill.json`;
}
