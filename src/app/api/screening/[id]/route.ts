// Single-screening API — fetch + patch + delete.

import { NextResponse } from "next/server";
import {
  deleteScreening,
  getScreeningDetail,
  patchScreening,
  screeningErrorStatus,
} from "@/lib/screening";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const detail = await getScreeningDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "Screening not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch screening", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

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

  const patch: {
    name?: string;
    description?: string | null;
    weights?: Record<string, number>;
    rmsdExcludeRef?: boolean;
  } = {};
  if (body.name !== undefined) patch.name = body.name as string;
  if (body.description !== undefined) patch.description = body.description as string | null;
  if (body.weights !== undefined) patch.weights = body.weights as Record<string, number>;
  // I-1c (#39): RMSD domain-exclusion option — strictly typed at the HTTP
  // boundary (patchScreening re-validates for direct lib callers). A truthy
  // "true" string from a sloppy client gets an honest 400, not a silent
  // exclusion flip.
  if (body.rmsdExcludeRef !== undefined) {
    if (typeof body.rmsdExcludeRef !== "boolean") {
      return NextResponse.json(
        { error: "rmsdExcludeRef must be a boolean (true or false)" },
        { status: 400 },
      );
    }
    patch.rmsdExcludeRef = body.rmsdExcludeRef;
  }

  try {
    const screening = await patchScreening(id, patch);
    if (!screening) {
      return NextResponse.json({ error: "Screening not found" }, { status: 404 });
    }
    return NextResponse.json({ screening });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to patch screening" },
      { status: screeningErrorStatus(err) },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteScreening(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to delete screening" },
      { status: screeningErrorStatus(err) },
    );
  }
}
