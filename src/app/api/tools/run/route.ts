// Run a comp tool — REAL if installed, SIMULATED otherwise.
//
// Flow:
//   1. Validate the tool key + params.
//   2. Create a ToolJob row in `running` state (so the UI can poll it).
//   3. Compute a per-job workDir at `<cwd>/outputs/<tool>/<jobId>/`.
//   4. Call `executeCompToolReal(tool, params, workDir)`:
//        - If the tool is installed on the host → spawn the real binary/script/
//          python-function and capture stdout/stderr/exitCode/outputFiles.
//        - If NOT installed (or the real run failed) → simulate and write
//          real-looking PDB/FASTA files to the workDir, with a clear
//          `[SIMULATED — ...]` banner prefix in stdout.
//   5. Update the row to `completed` (or `failed` on a real run that exited
//      non-zero) with the captured outputs.
//
// The `simulated` + `realToolUsed` booleans are stored both in the stdout
// banner (human-readable) and in a `_meta` key on the params JSON (programmatic
// retrieval). The outputFiles list contains absolute paths under
// `outputs/<tool>/<jobId>/`.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COMP_TOOLS, getCompTool } from "@/lib/tools";
import { executeCompToolReal } from "@/lib/real-executor";
import { promises as fs } from "fs";
import { join, resolve } from "path";
import type { ToolJobDTO } from "@/lib/types";

const VALID_TOOL_KEYS: Set<string> = new Set(COMP_TOOLS.map((t) => t.key));

// Root output dir, resolved relative to the project root. The dev server's CWD
// is the project root, so this resolves to <project>/outputs/<tool>/<jobId>/.
const OUTPUTS_ROOT = resolve(process.cwd(), "outputs");

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

  const userParams =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  const triggeredBy =
    typeof body.triggeredBy === "string" && body.triggeredBy ? body.triggeredBy : "user";
  const agentId =
    typeof body.agentId === "string" && body.agentId ? body.agentId : null;

  // Phase 1 — create the row in `running` state so we have a stable jobId to
  // use for the workDir. If execution fails catastrophically, we still have a
  // row to update.
  const startedAt = new Date();
  let job;
  try {
    job = await db.toolJob.create({
      data: {
        tool,
        params: JSON.stringify({ ...userParams, _meta: { simulated: null, realToolUsed: null } }),
        status: "running",
        stdout: "",
        stderr: "",
        outputFiles: JSON.stringify([]),
        triggeredBy,
        agentId,
        startedAt,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create tool job", detail: (err as Error).message },
      { status: 500 },
    );
  }

  // Phase 2 — run the real executor in the per-job workDir.
  const workDir = join(OUTPUTS_ROOT, tool, job.id);
  await fs.mkdir(workDir, { recursive: true }).catch(() => {});

  let result;
  try {
    result = await executeCompToolReal(tool, userParams, workDir);
  } catch (e) {
    // Catastrophic failure — executor itself threw. Mark the job failed.
    const errMsg = (e as Error).message ?? String(e);
    await db.toolJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        stderr: errMsg,
        exitCode: 1,
        finishedAt: new Date(),
      },
    });
    return NextResponse.json(
      { error: "Tool execution failed", detail: errMsg, jobId: job.id },
      { status: 500 },
    );
  }

  // Compute a brief human-readable result summary from the tool's def.
  const def = getCompTool(tool);
  const summary = def ? def.resultSummary(userParams, result.stdout) : "";

  const fullStdout = result.stdout
    ? `${result.stdout}\n\n${summary}`.trimEnd()
    : summary;

  // Persist the params JSON with a _meta block so downstream consumers (UI,
  // workflow engine, analytics) can tell real vs. simulated runs apart without
  // parsing the stdout banner.
  const paramsWithMeta = {
    ...userParams,
    _meta: {
      simulated: result.simulated,
      realToolUsed: result.realToolUsed,
      workDir,
    },
  };

  const finalStatus =
    result.exitCode === 0 ? "completed" : "failed";
  const finishedAt = new Date();

  try {
    const updated = await db.toolJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        stdout: fullStdout,
        stderr: result.stderr,
        outputFiles: JSON.stringify(result.outputFiles),
        exitCode: result.exitCode,
        command: result.command,
        params: JSON.stringify(paramsWithMeta),
        finishedAt,
      },
    });
    return NextResponse.json(toToolJobDTO(updated), { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to persist tool job result", detail: (err as Error).message, jobId: job.id },
      { status: 500 },
    );
  }
}
