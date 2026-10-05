// Screening API — list + create.
// POST with source {kind:"demo",demo:"scaffold"|"models"} runs the REAL
// built-in algorithm engines (diffusion / fold) — can take a couple of minutes.

import { NextResponse } from "next/server";
import {
  createScreening,
  listScreenings,
  screeningErrorStatus,
  ScreeningError,
} from "@/lib/screening";

export async function GET() {
  try {
    const screenings = await listScreenings();
    return NextResponse.json({ screenings });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list screenings", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const source = body.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return NextResponse.json(
      { error: "source is required: {kind:'node'|'job'|'demo'|'sweep', …}" },
      { status: 400 },
    );
  }
  const kind = (source as Record<string, unknown>).kind;

  try {
    if (kind === "node" || kind === "sweep") {
      // "sweep" = one-click campaign from a parameter sweep: any variant node
      // id — the server resolves the whole sweepGroup from it.
      const nodeId = (source as Record<string, unknown>).nodeId;
      if (typeof nodeId !== "string" || !nodeId.trim()) {
        throw new ScreeningError(
          `source.nodeId is required for ${kind} sources`,
          400,
        );
      }
    } else if (kind === "job") {
      const jobId = (source as Record<string, unknown>).jobId;
      if (typeof jobId !== "string" || !jobId.trim()) {
        throw new ScreeningError("source.jobId is required for job sources", 400);
      }
    } else if (kind === "demo") {
      const demo = (source as Record<string, unknown>).demo;
      if (demo !== "scaffold" && demo !== "models") {
        throw new ScreeningError('source.demo must be "scaffold" or "models"', 400);
      }
    } else {
      throw new ScreeningError(
        'source.kind must be "node", "job", "demo" or "sweep"',
        400,
      );
    }

    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    const description =
      typeof body.description === "string" ? body.description : undefined;

    const screening = await createScreening({
      source: source as Parameters<typeof createScreening>[0]["source"],
      name,
      description,
    });
    return NextResponse.json({ screening }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to create screening" },
      { status: screeningErrorStatus(err) },
    );
  }
}
