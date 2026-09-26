import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { MeetingDTO, DiscussionMessage } from "@/lib/types";

/** Map a Prisma Meeting row to a MeetingDTO (parses JSON fields, ISO dates). */
export function toMeetingDTO(m: any): MeetingDTO {
  let memberIds: string[] = [];
  try {
    const p = m.memberIds ? JSON.parse(m.memberIds) : [];
    if (Array.isArray(p)) memberIds = p;
  } catch {
    memberIds = [];
  }
  let messages: DiscussionMessage[] = [];
  try {
    const p = m.messages ? JSON.parse(m.messages) : [];
    if (Array.isArray(p)) messages = p;
  } catch {
    messages = [];
  }
  let tags: string[] = [];
  try {
    const p = m.tags ? JSON.parse(m.tags) : [];
    if (Array.isArray(p)) tags = p;
  } catch {
    tags = [];
  }
  return {
    id: m.id,
    type: (m.type === "individual" ? "individual" : "team") as "team" | "individual",
    agenda: m.agenda ?? "",
    saveName: m.saveName ?? null,
    numRounds: typeof m.numRounds === "number" ? m.numRounds : Number(m.numRounds) || 0,
    temperature: typeof m.temperature === "number" ? m.temperature : Number(m.temperature) || 0,
    leadId: m.leadId ?? null,
    memberIds,
    status: (m.status ?? "draft") as MeetingDTO["status"],
    summary: m.summary ?? null,
    messages,
    tags,
    pinned: !!m.pinned,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : new Date(m.createdAt).toISOString(),
    updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : new Date(m.updatedAt).toISOString(),
  };
}

export async function GET() {
  try {
    const rows = await db.meeting.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json(rows.map(toMeetingDTO));
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to list meetings", detail: (e as Error).message },
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

  const type: "team" | "individual" = body?.type === "individual" ? "individual" : "team";
  const agenda: string = typeof body?.agenda === "string" ? body.agenda.trim() : "";
  if (!agenda) {
    return NextResponse.json({ error: "agenda is required" }, { status: 400 });
  }

  const saveName: string | null =
    typeof body?.saveName === "string" && body.saveName.trim() ? body.saveName.trim() : null;
  const numRounds: number =
    typeof body?.numRounds === "number" && body.numRounds > 0 ? Math.floor(body.numRounds) : 3;
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

  // Team meetings require leadId + at least 1 member.
  if (type === "team") {
    if (!leadId) {
      return NextResponse.json(
        { error: "leadId is required for team meetings" },
        { status: 400 },
      );
    }
    if (memberIds.length < 1) {
      return NextResponse.json(
        { error: "memberIds must contain at least 1 agent for team meetings" },
        { status: 400 },
      );
    }
  } else {
    // Individual meetings also require at least one agent (the subject).
    if (memberIds.length < 1) {
      return NextResponse.json(
        { error: "memberIds must contain at least 1 agent for individual meetings" },
        { status: 400 },
      );
    }
  }

  try {
    const created = await db.meeting.create({
      data: {
        type,
        agenda,
        saveName,
        numRounds,
        temperature,
        leadId,
        memberIds: JSON.stringify(memberIds),
        status: "draft",
        tags: JSON.stringify(tags),
      },
    });
    return NextResponse.json(toMeetingDTO(created), { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to create meeting", detail: (e as Error).message },
      { status: 500 },
    );
  }
}
