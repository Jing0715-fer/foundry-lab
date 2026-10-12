// DELETE /api/skills/:skillId — unregister a CUSTOM skill (M3).
//
// Only the custom.* namespace is deletable: built-ins are part of the
// application (400), and an unknown id is a 404. Deleting removes the
// CustomSkill row AND unregisters it from the live process registry;
// other processes drop it on their next hydration cycle (the loader reads
// the table, so the row's absence un-registers it there naturally —
// reloadCustomSkills on THIS process is what keeps the response honest
// immediately).
//
// Audit history is untouched: SkillInvocation rows keep their skillId
// strings; the Activity log and Insights keep rendering them (labels
// resolve to null for deleted skills — same honest degradation deleted
// agents already show via agentTitle).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reloadCustomSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

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
