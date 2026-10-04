// Screening candidates bulk-patch — { ids, patch } → { updated, candidates (ALL) }.

import { NextResponse } from "next/server";
import {
  patchCandidates,
  screeningErrorStatus,
} from "@/lib/screening";
import type { ScreeningCandidateStatus } from "@/lib/types";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = body.ids;
  const rawPatch = body.patch;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "ids must be a non-empty array of candidate ids" },
      { status: 400 },
    );
  }
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    return NextResponse.json(
      { error: "patch is required: { starred?, status?, addTags?, removeTags?, notes? }" },
      { status: 400 },
    );
  }
  const p = rawPatch as Record<string, unknown>;
  const patch: {
    starred?: boolean;
    status?: ScreeningCandidateStatus;
    addTags?: string[];
    removeTags?: string[];
    notes?: string | null;
  } = {};
  if (p.starred !== undefined) patch.starred = p.starred as boolean;
  if (p.status !== undefined) patch.status = p.status as ScreeningCandidateStatus;
  if (p.addTags !== undefined) patch.addTags = p.addTags as string[];
  if (p.removeTags !== undefined) patch.removeTags = p.removeTags as string[];
  if (p.notes !== undefined) patch.notes = p.notes as string | null;

  try {
    const result = await patchCandidates(id, ids as string[], patch);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to patch candidates" },
      { status: screeningErrorStatus(err) },
    );
  }
}
