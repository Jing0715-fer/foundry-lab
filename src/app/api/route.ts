import { NextResponse } from "next/server";

/** GET /api — health check. */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    app: "Foundry Lab",
    time: new Date().toISOString(),
  });
}
