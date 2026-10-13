// POST /api/skills/pack/uninstall — R3: pack-level uninstall.
//
// Body: { packName: string } — the exact identity the import lane
// backfilled onto every row it created from a bundle-v2 pack (template
// packs, downloaded bundle files carrying pack metadata).
//
// Contract:
//   - Deletes EVERY CustomSkill row WHERE packName = X (enabled or
//     disabled — a pack is uninstalled as a unit, not skill-by-skill).
//   - Audit history (SkillInvocation rows) is untouched, same as the
//     per-skill DELETE: labels resolve to null for deleted skills.
//   - 200 { packName, deleted: [skillIds], count } — the honest report of
//     what went away (0-row packs are a 404, not a silent no-op).
//   - 400: missing/empty/oversized packName (>80, the metadata.name cap).
//   - The registry reload is unconditional (belt-and-braces: even a 404
//     path could race a concurrent import).
//
// This is the inverse of the pack import: importing creates rows tagged
// with the pack's identity; uninstalling removes rows BY that identity.
// Skills that were imported individually (or registered manually) never
// carry a packName and are immune — the delete predicate is exact.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reloadCustomSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

const PACK_NAME_MAX = 80; // mirror of the import lane's metadata.name cap

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const packName =
    typeof body.packName === "string" ? body.packName.trim() : "";
  if (!packName) {
    return NextResponse.json(
      { error: "packName is required (the name the pack was imported under)" },
      { status: 400 },
    );
  }
  if (packName.length > PACK_NAME_MAX) {
    return NextResponse.json(
      { error: `packName exceeds ${PACK_NAME_MAX} chars` },
      { status: 400 },
    );
  }

  // Snapshot the rows BEFORE deleting — the response reports exactly what
  // went away (the deleteMany count alone would lose the ids).
  const rows = await db.customSkill.findMany({
    where: { packName },
    select: { skillId: true, enabled: true },
  });
  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: `No imported pack named "${packName}" — pack names come from ` +
          "bundle-v2 metadata (template packs / pack-metadata bundle files).",
      },
      { status: 404 },
    );
  }

  try {
    await db.customSkill.deleteMany({ where: { packName } });
  } catch (e) {
    return NextResponse.json(
      { error: `Pack uninstall failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Live in this process immediately (registry re-reads the table).
  await reloadCustomSkills();

  const deleted = rows.map((r) => r.skillId);
  return NextResponse.json({
    packName,
    deleted,
    count: deleted.length,
    disabledDeleted: rows.filter((r) => !r.enabled).length,
    note:
      "Pack skills were unregistered as a unit. Audit history for their " +
      "past invocations is preserved in the Activity tab.",
  });
}
