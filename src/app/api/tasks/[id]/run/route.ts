// Run a task with its connected agents.
//
// Flow:
//  1. Fetch task, parse agentIds JSON.
//  2. Set status "running", startedAt now.
//  3. No agents -> simple result, mark completed.
//  4. Else run each agent turn (temp 0.7, maxRounds 2) and collect responses.
//  5. Multiple agents -> synthesize into one concise answer.
//  6. Persist result + logs, mark completed.
//  7. try/catch -> on error set status "failed", logs = error message.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/llm";
import { runAgentTurn, toAgentDTO } from "@/lib/run-utils";
import { toTaskDTO } from "../../route";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let task;
  try {
    task = await db.task.findUnique({ where: { id } });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch task", detail: (err as Error).message },
      { status: 500 },
    );
  }
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Parse agentIds JSON.
  let agentIds: string[] = [];
  try {
    if (task.agentIds) {
      const parsed = JSON.parse(task.agentIds);
      if (Array.isArray(parsed)) agentIds = parsed.map(String);
    }
  } catch {
    agentIds = [];
  }

  // Mark running.
  try {
    task = await db.task.update({
      where: { id },
      data: { status: "running", startedAt: new Date() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to mark task running", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // No agents assigned → simple result.
  if (agentIds.length === 0) {
    try {
      const updated = await db.task.update({
        where: { id },
        data: {
          status: "completed",
          result: `No agents assigned. Task prompt: ${task.prompt}`,
          logs: "No agents were assigned to this task.",
          completedAt: new Date(),
        },
      });
      return NextResponse.json(toTaskDTO(updated));
    } catch (err) {
      return NextResponse.json(
        { error: "Failed to complete task", detail: (err as Error).message },
        { status: 500 },
      );
    }
  }

  try {
    // Fetch agent rows.
    const agentRows = await db.agent.findMany({ where: { id: { in: agentIds } } });
    const agents = agentRows.map(toAgentDTO);

    const responses: { name: string; text: string }[] = [];
    for (const agent of agents) {
      const { text } = await runAgentTurn(
        agent,
        [{ role: "user", content: task.prompt }],
        { temperature: 0.7, maxRounds: 2 },
      );
      responses.push({ name: agent.title, text });
    }

    let result: string;
    if (responses.length > 1) {
      const joined = responses
        .map((r) => `**${r.name}**:\n${r.text}`)
        .join("\n\n---\n\n");
      result = await chat([
        {
          role: "system",
          content:
            "Synthesize the agents' responses into one concise answer.",
        },
        { role: "user", content: joined },
      ]);
    } else {
      result = responses[0]?.text ?? "";
    }

    const logs = responses
      .map((r) => `**${r.name}**:\n${r.text}`)
      .join("\n\n---\n\n");

    const updated = await db.task.update({
      where: { id },
      data: {
        status: "completed",
        result,
        logs,
        completedAt: new Date(),
      },
    });
    return NextResponse.json(toTaskDTO(updated));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    try {
      const failed = await db.task.update({
        where: { id },
        data: {
          status: "failed",
          logs: `Error: ${msg}`,
          completedAt: new Date(),
        },
      });
      return NextResponse.json(toTaskDTO(failed), { status: 500 });
    } catch {
      return NextResponse.json(
        { error: "Task failed and could not persist error state", detail: msg },
        { status: 500 },
      );
    }
  }
}
