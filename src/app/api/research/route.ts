import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ResearchReportDTO, DiscussionMessage } from "@/lib/types";

/** Map a Prisma ResearchReport row to a ResearchReportDTO (parses JSON, ISO dates). */
export function toResearchDTO(r: any): ResearchReportDTO {
  let memberIds: string[] = [];
  try {
    const p = r.memberIds ? JSON.parse(r.memberIds) : [];
    if (Array.isArray(p)) memberIds = p;
  } catch {
    memberIds = [];
  }
  let discussion: DiscussionMessage[] = [];
  try {
    const p = r.discussion ? JSON.parse(r.discussion) : [];
    if (Array.isArray(p)) discussion = p;
  } catch {
    discussion = [];
  }
  let tags: string[] = [];
  try {
    const p = r.tags ? JSON.parse(r.tags) : [];
    if (Array.isArray(p)) tags = p;
  } catch {
    tags = [];
  }
  return {
    id: r.id,
    topic: r.topic ?? "",
    description: r.description ?? null,
    numRounds: typeof r.numRounds === "number" ? r.numRounds : Number(r.numRounds) || 0,
    temperature: typeof r.temperature === "number" ? r.temperature : Number(r.temperature) || 0,
    leadId: r.leadId ?? null,
    memberIds,
    status: (r.status ?? "draft") as ResearchReportDTO["status"],
    discussion,
    report: r.report ?? null,
    tags,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt).toISOString(),
  };
}

export async function GET() {
  try {
    const rows = await db.researchReport.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json(rows.map(toResearchDTO));
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to list research reports", detail: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const topic: string = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (!topic) {
    return NextResponse.json({ error: "topic is required" }, { status: 400 });
  }

  const description: string | null =
    typeof body?.description === "string" && body.description.trim() ? body.description.trim() : null;
  const numRounds: number =
    typeof body?.numRounds === "number" && body.numRounds > 0 ? Math.floor(body.numRounds) : 2;
  const temperature: number =
    typeof body?.temperature === "number" ? body.temperature : 0.7;
  const leadId: string | null =
    typeof body?.leadId === "string" && body.leadId.trim() ? body.leadId.trim() : null;
  const memberIdsRaw: unknown = body?.memberIds;
  const memberIds: string[] = Array.isArray(memberIdsRaw)
    ? memberIdsRaw.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x))
    : [];
  const tagsRaw: unknown = body?.tags;
  const tags: string[] = Array.isArray(tagsRaw)
    ? tagsRaw.filter((x) => typeof x === "string").map((x) => String(x))
    : [];

  try {
    const created = await db.researchReport.create({
      data: {
        topic,
        description,
        numRounds,
        temperature,
        leadId,
        memberIds: JSON.stringify(memberIds),
        status: "draft",
        tags: JSON.stringify(tags),
      },
    });
    return NextResponse.json(toResearchDTO(created), { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to create research report", detail: (e as Error).message },
      { status: 500 },
    );
  }
}
