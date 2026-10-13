// GET /api/skills/events-session — R1: mint the push-channel session grant.
//
// The browser hook (use-skill-events) calls this BEFORE connecting to the
// skill-events socket.io service and presents the returned token in the
// handshake (auth.token). The service verifies the HMAC signature and
// clamps every room subscription to the entitlement carried inside.
//
// Identity decision (server-side, single source): this is a SINGLE-USER
// studio — the audit log the Activity tab renders is globally readable
// for the operator, so the honest entitlement today is the firehose
// (["all"]). The MECHANISM is the deliverable: when real auth lands
// (NextAuth, multi-workspace), the entitlement is computed HERE from the
// authenticated identity and every other piece (signature, expiry, the
// service-side clamp) already enforces it. The browser never gets to
// choose its own rooms — it can only narrow within this grant.
//
//   200 { token, rooms: ["all"], expiresAt }
//   503 { error }  — the signing key is unavailable (skill-events not
//                    booted yet / env misconfigured). The browser hook
//                    falls back to O2 polling; live refresh degrades
//                    honestly instead of connecting unsigned.

import { NextResponse } from "next/server";
import { mintSkillEventsSession } from "@/lib/skills/session-tokens";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = mintSkillEventsSession(["all"]);
    return NextResponse.json(session);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
