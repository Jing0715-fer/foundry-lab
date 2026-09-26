// Tool jobs API — list (limit 50 newest-first).
// ToolJobDTO mapper is defined here and imported by [id] and tools/run routes
// to keep it private to the tools routes (no shared dto.ts to avoid 5-d conflicts).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ToolJobDTO, RunStatus } from "@/lib/types";

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function toToolJobDTO(j: {
  id: string;
  tool: string;
  presetName: string | null;
  params: string;
  status: string;
  pid: number | null;
  stdout: string;
  stderr: string;
  outputFiles: string | null;
  exitCode: number | null;
  command: string | null;
  triggeredBy: string;
  agentId: string | null;
  environmentId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}): ToolJobDTO {
  return {
    id: j.id,
    tool: j.tool,
    presetName: j.presetName,
    params: parseJsonObject(j.params),
    status: j.status as RunStatus,
    pid: j.pid,
    stdout: j.stdout ?? "",
    stderr: j.stderr ?? "",
    outputFiles: parseJsonStringArray(j.outputFiles),
    exitCode: j.exitCode,
    command: j.command,
    triggeredBy: j.triggeredBy,
    agentId: j.agentId,
    environmentId: j.environmentId,
    startedAt: toIso(j.startedAt),
    finishedAt: toIso(j.finishedAt),
    createdAt: toIso(j.createdAt) ?? new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const jobs = await db.toolJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json(jobs.map(toToolJobDTO));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list tool jobs", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
