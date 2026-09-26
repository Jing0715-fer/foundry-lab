// Run a comp tool — REAL execution, never simulated.
//
// Flow:
//   1. Validate the tool key + params.
//   2. Create a ToolJob row in `running` state (so the UI can poll it).
//   3. Compute a per-job workDir at `<cwd>/outputs/<tool>/<jobId>/`.
//   4. Call `executeCompToolReal(tool, params, workDir)`:
//        - If the NATIVE upstream tool is installed → spawn it and capture
//          stdout/stderr/exitCode/outputFiles.
//        - Otherwise → run the BUILT-IN real Python algorithm engine (same
//          result surface: real PDB/FASTA/metrics artifacts on disk).
//   5. Update the row to `completed` (or `failed` on a non-zero exit).
//
// The `executor` ("native" | "builtin-engine") + `realToolUsed` flags are
// stored in a `_meta` key on the params JSON for programmatic retrieval.
// The outputFiles list contains absolute paths under `outputs/<tool>/<jobId>/`.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COMP_TOOLS, getCompTool } from "@/lib/tools";
import { executeCompToolReal } from "@/lib/real-executor";
import { extractClusterTarget } from "@/lib/run-utils";
import { listConnections, getConnection } from "@/lib/cluster/connections";
import {
  startClusterToolRun,
  clusterInfoForJob,
  pendingClusterInfo,
} from "@/lib/cluster/cluster-run";
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

  // ── CLUSTER lane ────────────────────────────────────────────────────────
  // body.cluster = { connectionId, mode, partition?, gpus?, … } → dispatch
  // to an SSH-reachable HPC cluster. Fire-and-forget: the row is created in
  // `running` state, startClusterToolRun stages + submits in the background,
  // and the async reconcile sweep (triggered by the jobs poll endpoints)
  // drives it to completed/failed. We answer 202 immediately.
  const clusterTarget = extractClusterTarget(body.cluster);
  if (body.cluster != null && !clusterTarget) {
    return NextResponse.json(
      { error: "Invalid cluster target — connectionId is required" },
      { status: 400 },
    );
  }
  if (clusterTarget) {
    const conn = getConnection(clusterTarget.connectionId);
    if (!conn) {
      const available =
        listConnections().map((c) => `${c.name} (${c.id})`).join(", ") ||
        "none configured yet";
      return NextResponse.json(
        {
          error:
            `Cluster connection not found: ${clusterTarget.connectionId}. ` +
            `Available connections: ${available}`,
        },
        { status: 400 },
      );
    }

    let clusterJob;
    try {
      clusterJob = await db.toolJob.create({
        data: {
          tool,
          params: JSON.stringify({
            ...userParams,
            _meta: {
              executor: "cluster",
              realToolUsed: true,
              cluster: true,
              connectionId: clusterTarget.connectionId,
              mode: clusterTarget.mode,
            },
          }),
          status: "running",
          stdout: "",
          stderr: "",
          outputFiles: JSON.stringify([]),
          triggeredBy,
          agentId,
          startedAt: new Date(),
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "Failed to create tool job", detail: (err as Error).message },
        { status: 500 },
      );
    }

    const clusterWorkDir = join(OUTPUTS_ROOT, tool, clusterJob.id);
    await fs.mkdir(clusterWorkDir, { recursive: true }).catch(() => {});

    // Fire-and-forget dispatch — startClusterToolRun itself never throws and
    // marks the row failed on any staging/submit error; this catch is a
    // last-resort belt for truly unexpected crashes.
    void startClusterToolRun({
      jobId: clusterJob.id,
      toolKey: tool,
      params: userParams,
      workDir: clusterWorkDir,
      target: clusterTarget,
    }).catch(async (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      await db.toolJob
        .update({
          where: { id: clusterJob.id },
          data: {
            status: "failed",
            stderr: `Cluster dispatch crashed: ${msg}`,
            exitCode: 1,
            finishedAt: new Date(),
          },
        })
        .catch(() => {});
    });

    return NextResponse.json(
      {
        ...toToolJobDTO(clusterJob),
        cluster: clusterInfoForJob(clusterJob.id) ?? pendingClusterInfo(conn, clusterTarget),
      },
      { status: 202 },
    );
  }

  // Phase 1 — create the row in `running` state so we have a stable jobId to
  // use for the workDir. If execution fails catastrophically, we still have a
  // row to update.
  const startedAt = new Date();
  let job;
  try {
    job = await db.toolJob.create({
      data: {
        tool,
        params: JSON.stringify({ ...userParams, _meta: { executor: null, realToolUsed: null } }),
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
  // workflow engine, analytics) can tell which executor ran (native upstream
  // tool vs built-in real algorithm engine).
  const paramsWithMeta = {
    ...userParams,
    _meta: {
      executor: result.executor,
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
