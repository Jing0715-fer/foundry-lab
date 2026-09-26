// Run a comp tool (simulated). Creates a ToolJob row in completed state.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executeCompTool } from "@/lib/run-utils";
import { COMP_TOOLS } from "@/lib/tools";
import type { ToolJobDTO } from "@/lib/types";

const VALID_TOOL_KEYS: Set<string> = new Set(COMP_TOOLS.map((t) => t.key));

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toToolJobDTO(j: {
  id: string; tool: string; presetName: string | null; params: string;
  status: string; pid: number | null; stdout: string; stderr: string;
  outputFiles: string | null; exitCode: number | null; command: string | null;
  triggeredBy: string; agentId: string | null; environmentId: string | null;
  startedAt: Date | null; finishedAt: Date | null; createdAt: Date;
}): ToolJobDTO {
  let params: Record<string, unknown> = {};
  try { params = j.params ? JSON.parse(j.params) : {}; } catch { /* ignore */ }
  let outputFiles: string[] = [];
  try { outputFiles = j.outputFiles ? JSON.parse(j.outputFiles) : []; } catch { /* ignore */ }
  return {
    id: j.id, tool: j.tool, presetName: j.presetName, params,
    status: j.status as ToolJobDTO["status"], pid: j.pid,
    stdout: j.stdout, stderr: j.stderr, outputFiles,
    exitCode: j.exitCode, command: j.command, triggeredBy: j.triggeredBy,
    agentId: j.agentId, environmentId: j.environmentId,
    startedAt: toIso(j.startedAt), finishedAt: toIso(j.finishedAt),
    createdAt: toIso(j.createdAt)!,
  };
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!tool || !VALID_TOOL_KEYS.has(tool)) {
    return NextResponse.json(
      {
        error: `Invalid tool. Must be one of: ${[...VALID_TOOL_KEYS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  const triggeredBy =
    typeof body.triggeredBy === "string" && body.triggeredBy ? body.triggeredBy : "user";
  const agentId =
    typeof body.agentId === "string" && body.agentId ? body.agentId : null;

  // Execute (simulated).
  const { summary, stdout, files, command } = executeCompTool(tool, params);

  // Combine summary into stdout so the UI shows the result summary.
  const fullStdout = files.length
    ? `${stdout}\n\n${summary}`
    : `${stdout}\n\n${summary}`;

  try {
    const now = new Date();
    const job = await db.toolJob.create({
      data: {
        tool,
        params: JSON.stringify(params),
        status: "completed",
        stdout: fullStdout,
        stderr: "",
        outputFiles: JSON.stringify(files),
        exitCode: 0,
        command,
        triggeredBy,
        agentId,
        startedAt: now,
        finishedAt: now,
      },
    });
    return NextResponse.json(toToolJobDTO(job), { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to persist tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
