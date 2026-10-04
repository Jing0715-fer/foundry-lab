import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO, runResearch } from "@/lib/run-utils";
import { toResearchDTO } from "../../route";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: RouteCtx) {
  const { id } = await params;
  let report: any;
  try {
    report = await db.researchReport.findUnique({ where: { id } });
    if (!report) {
      return NextResponse.json({ error: "Research report not found" }, { status: 404 });
    }

    // Atomic claim (scheduler.ts updateMany pattern): only a row outside the
    // active pipeline phases (planning/researching/writing) flips to planning
    // — a double-clicked Run gets a 409 instead of two concurrent research
    // pipelines writing over each other.
    const claimed = await db.researchReport.updateMany({
      where: { id, status: { notIn: ["planning", "researching", "writing"] } },
      data: { status: "planning" },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        {
          error:
            "Research pipeline is already running — wait for the current " +
            "run to finish before running it again.",
        },
        { status: 409 },
      );
    }

    // Parse member ids.
    let memberIds: string[] = [];
    try {
      const p = report.memberIds ? JSON.parse(report.memberIds) : [];
      if (Array.isArray(p)) memberIds = p.filter((x) => typeof x === "string");
    } catch {
      memberIds = [];
    }

    const temperature: number =
      typeof report.temperature === "number" ? report.temperature : Number(report.temperature) || 0.6;
    const numRounds: number =
      typeof report.numRounds === "number" ? report.numRounds : Number(report.numRounds) || 2;

    if (!report.leadId) throw new Error("Research report has no leadId");
    const leadRow = await db.agent.findUnique({ where: { id: report.leadId } });
    if (!leadRow) throw new Error(`Lead agent ${report.leadId} not found`);
    const lead = toAgentDTO(leadRow);

    if (memberIds.length < 1) throw new Error("Research report requires at least one member");
    const memberRows = await db.agent.findMany({ where: { id: { in: memberIds } } });
    const members = memberRows.map(toAgentDTO);
    if (members.length !== memberIds.length) {
      throw new Error("One or more member agents not found");
    }

    // runResearch is atomic (planning → researching → writing). Best-effort status update.
    await db.researchReport.update({ where: { id }, data: { status: "writing" } });

    const { messages, report: reportMd } = await runResearch(
      lead,
      members,
      report.topic,
      report.description,
      { numRounds, temperature },
    );

    const updated = await db.researchReport.update({
      where: { id },
      data: {
        status: "completed",
        report: reportMd,
        discussion: JSON.stringify(messages),
      },
    });
    return NextResponse.json(toResearchDTO(updated));
  } catch (e) {
    const err = (e as Error).message;
    try {
      await db.researchReport.update({
        where: { id },
        data: { status: "failed" },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(
      { error: "Failed to run research", detail: err },
      { status: 500 },
    );
  }
}
