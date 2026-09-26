// Single tool job API — fetch.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toToolJobDTO } from "../route";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const job = await db.toolJob.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Tool job not found" }, { status: 404 });
    }
    return NextResponse.json(toToolJobDTO(job));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
