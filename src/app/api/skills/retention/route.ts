// GET/POST /api/skills/retention — M2 (K6) audit-log retention surface.
//
//   GET  → the default policy + a DRY-RUN decision against the current
//          table (exact numbers of what the defaults would prune).
//   POST → body { maxAgeDays?, rowCap?, dryRun? } — validated, then
//          evaluated (dryRun=true) or executed (dryRun=false). Returns the
//          RetentionDecision envelope either way, so the UI can show the
//          same honest numbers the deletion acted on.
//
// Trust level: operator tooling, same surface class as demo:reset — no
// auth exists in this app yet (H4), so anyone who can reach the app can
// prune audit rows. The panel gate is an explicit confirm dialog; the
// numbers shown are the numbers deleted.

import { NextRequest, NextResponse } from "next/server";
import {
  runRetention,
  RETENTION_DEFAULT_MAX_AGE_DAYS,
  RETENTION_HARD_ROW_CAP,
} from "@/lib/skills/retention";

export const dynamic = "force-dynamic";

type RetentionDecisionWire = Awaited<ReturnType<typeof runRetention>>;

interface RetentionStats {
  policy: { maxAgeDays: number; rowCap: number };
  dryRun: RetentionDecisionWire;
}

export async function GET() {
  try {
    const dryRun = await runRetention({ dryRun: true });
    const body: RetentionStats = {
      policy: {
        maxAgeDays: RETENTION_DEFAULT_MAX_AGE_DAYS,
        rowCap: RETENTION_HARD_ROW_CAP,
      },
      dryRun,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: `Retention evaluation failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const errors: string[] = [];
  let maxAgeDays: number | undefined;
  if (body.maxAgeDays !== undefined) {
    if (
      typeof body.maxAgeDays !== "number" ||
      !Number.isInteger(body.maxAgeDays) ||
      body.maxAgeDays < 1 ||
      body.maxAgeDays > 3650
    ) {
      errors.push("maxAgeDays must be an integer between 1 and 3650");
    } else {
      maxAgeDays = body.maxAgeDays;
    }
  }
  let rowCap: number | undefined;
  if (body.rowCap !== undefined) {
    if (
      typeof body.rowCap !== "number" ||
      !Number.isInteger(body.rowCap) ||
      body.rowCap < 100 ||
      body.rowCap > 100_000
    ) {
      errors.push("rowCap must be an integer between 100 and 100000");
    } else {
      rowCap = body.rowCap;
    }
  }
  let dryRun = false;
  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== "boolean") {
      errors.push("dryRun must be a boolean");
    } else {
      dryRun = body.dryRun;
    }
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  }

  try {
    const decision = await runRetention({ maxAgeDays, rowCap, dryRun });
    return NextResponse.json({ ...decision, dryRun });
  } catch (e) {
    return NextResponse.json(
      { error: `Retention run failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
