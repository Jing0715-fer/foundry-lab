import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO, runTeamMeeting, runIndividualMeeting } from "@/lib/run-utils";
import { toMeetingDTO } from "../../route";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  let meeting: any;
  try {
    meeting = await db.meeting.findUnique({ where: { id } });
    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // Atomic claim (scheduler.ts updateMany pattern): only a row NOT already
    // running flips to running — a double-clicked Run gets a 409 instead of
    // two concurrent multi-round LLM debates writing over each other.
    const claimed = await db.meeting.updateMany({
      where: { id, status: { not: "running" } },
      data: { status: "running" },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        {
          error:
            "Meeting is already running — wait for the current debate to " +
            "finish before running it again.",
        },
        { status: 409 },
      );
    }

    // Parse member ids.
    let memberIds: string[] = [];
    try {
      const p = meeting.memberIds ? JSON.parse(meeting.memberIds) : [];
      if (Array.isArray(p)) memberIds = p.filter((x) => typeof x === "string");
    } catch {
      memberIds = [];
    }

    const temperature: number =
      typeof meeting.temperature === "number" ? meeting.temperature : Number(meeting.temperature) || 0.7;
    const numRounds: number =
      typeof meeting.numRounds === "number" ? meeting.numRounds : Number(meeting.numRounds) || 3;

    if (meeting.type === "individual") {
      if (memberIds.length < 1) {
        throw new Error("Individual meeting requires at least one member agent");
      }
      const subjectRow = await db.agent.findUnique({ where: { id: memberIds[0] } });
      if (!subjectRow) throw new Error(`Agent ${memberIds[0]} not found`);
      const subject = toAgentDTO(subjectRow);

      const { messages, summary } = await runIndividualMeeting(subject, meeting.agenda, { temperature });

      const updated = await db.meeting.update({
        where: { id },
        data: {
          status: "completed",
          summary,
          messages: JSON.stringify(messages),
        },
      });
      return NextResponse.json(toMeetingDTO(updated));
    }

    // Team meeting.
    if (!meeting.leadId) throw new Error("Team meeting has no leadId");
    const leadRow = await db.agent.findUnique({ where: { id: meeting.leadId } });
    if (!leadRow) throw new Error(`Lead agent ${meeting.leadId} not found`);
    const lead = toAgentDTO(leadRow);

    if (memberIds.length < 1) throw new Error("Team meeting requires at least one member");
    const memberRows = await db.agent.findMany({ where: { id: { in: memberIds } } });
    const members = memberRows.map(toAgentDTO);
    if (members.length !== memberIds.length) {
      throw new Error("One or more member agents not found");
    }

    const { messages, summary } = await runTeamMeeting(lead, members, meeting.agenda, {
      numRounds,
      temperature,
    });

    const updated = await db.meeting.update({
      where: { id },
      data: {
        status: "completed",
        summary,
        messages: JSON.stringify(messages),
      },
    });
    return NextResponse.json(toMeetingDTO(updated));
  } catch (e) {
    const err = (e as Error).message;
    try {
      await db.meeting.update({
        where: { id },
        data: { status: "failed", summary: `Error: ${err}` },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(
      { error: "Failed to run meeting", detail: err },
      { status: 500 },
    );
  }
}
