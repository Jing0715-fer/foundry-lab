// K5 — slow-skill async enqueue (chat / meeting / research / task lanes).
//
// Before K5, the streaming chat lane refused slow comp skills outright
// (skipSkill → "run it on the canvas instead"), and the non-stream
// runAgentTurn lanes BLOCKED for minutes executing the engine inline.
// runSkillQueued replaces both with one honest policy:
//
//   resolve → validate → gate → rate-limit →
//     ToolJob row ("queued", triggeredBy agent:<title>) +
//     SkillInvocation row ("queued")                      ← visible immediately
//     → fire-and-forget real engine run (runKey = jobId)  ← stoppable for real
//     → conditional terminal writes                        ← late/stop-safe
//
// The pipeline result carries status "queued" with the jobId, so the chat
// card + model feedback say "started in the background", never fake results.
// When the engine lands, the SAME SkillInvocation row transitions to
// ok | error | cancelled (updateMany where status "queued" — a row that was
// stopped or superseded in the meantime matches zero rows and keeps its
// verdict; this is the #45/#47 conditional-write discipline applied to the
// audit trail).
//
// Stop integration: the ToolJob stop route (POST /api/tools/jobs/:id/stop)
// registers requestStop(jobId) + killActiveProcess(jobId) — runKey=jobId
// means the pre-spawn guard and the process registry both work for these
// rows exactly like canvas nodes.
//
// Crash safety: every background path has a final net that fails both rows
// (never wedge "queued"/"running"); a server restart mid-run is reconciled
// at boot by instrumentation.ts (orphan sweep).

import { promises as fs } from "fs";
import { join, resolve } from "path";
import { db } from "@/lib/db";
import { getCompTool } from "@/lib/tools";
import { executeCompToolReal } from "@/lib/real-executor";
// N1: the custom (webhook) branch of the queue executor needs the abort
// registry + the stop flag for real mid-flight stops.
import {
  registerWebhookAbort,
  unregisterWebhookAbort,
} from "@/lib/real-executor";
import { isStopRequested } from "@/lib/stop-registry";
import { getSkill } from "./registry";
import { validateParams } from "./runner";
import { checkSkillRateLimit } from "./rate-limit";
import { recordSkillInvocation } from "./runner";
import type {
  SkillContext,
  SkillDefinition,
  SkillRunResult,
} from "./types";

const OUTPUTS_ROOT = resolve(process.cwd(), "outputs");

/**
 * Queue a SLOW skill (comp engines) for background execution.
 *
 * Fast skills and unknown ids are delegated to runSkill unchanged (they
 * either execute inline in <10s or produce an honest "invalid" envelope) —
 * so lane call sites can route EVERY skill call through this one function
 * when their policy is "queue slow, run fast".
 */
export async function runSkillQueued(
  skillId: string,
  rawParams: Record<string, unknown>,
  ctx: SkillContext,
): Promise<SkillRunResult> {
  const t0 = Date.now();
  const def = getSkill(skillId);

  // Unknown / fast → the standard synchronous pipeline.
  if (!def || def.latency !== "slow") {
    const { runSkill } = await import("./runner");
    return runSkill(skillId, rawParams, ctx);
  }

  // 2. Validate.
  const { params, errors } = validateParams(def, rawParams);
  if (errors.length > 0) {
    return await queuedEnvelope(
      {
        skillId: def.id,
        status: "invalid",
        summary: "Invalid parameters",
        error: errors.join("; "),
        durationMs: Date.now() - t0,
      },
      ctx,
      params,
    );
  }

  // 3. Gate — same knowledge-rule as runSkill (previously the streaming lane
  // bypassed gating entirely for slow skills: skipSkill never checked
  // requires, so a bio-disabled agent was "refused" for fast calls but its
  // engine queue request would have sailed through).
  if (ctx.agent) {
    const missing = def.requires.filter((r) => ctx.agent?.knowledge[r] !== true);
    if (missing.length > 0) {
      return await queuedEnvelope(
        {
          skillId: def.id,
          status: "denied",
          summary: `Denied — requires ${missing.join(", ")}`,
          error:
            `This agent has ${missing.join(" and ")} disabled in its knowledge ` +
            "configuration, so the skill was refused before queueing. Tell the " +
            "user to enable it in the agent's settings if they want this capability — " +
            "do not pretend the tool ran.",
          durationMs: Date.now() - t0,
        },
        ctx,
        params,
      );
    }

    // 3.5 Rate limit — comp slots are consumed by QUEUEING (the engine cost
    // is real whether or not the caller waits around).
    const rl = checkSkillRateLimit(ctx.agent.id, def);
    if (!rl.allowed) {
      const retryIn = Math.ceil((rl.retryAfterMs ?? 0) / 1000);
      return await queuedEnvelope(
        {
          skillId: def.id,
          status: "limited",
          summary: `Rate limited — max ${rl.max} per ${Math.round(rl.windowMs / 1000)}s per agent`,
          error:
            `Rate limit reached for skill "${def.id}" — at most ${rl.max} ` +
            `invocations per ${Math.round(rl.windowMs / 1000)}s per agent. ` +
            `Try again in ~${retryIn}s. Answer from what you already have.`,
          durationMs: Date.now() - t0,
        },
        ctx,
        params,
      );
    }
  }

  // 5. Enqueue: audit row first (status "queued"), then the ToolJob row
  // referencing it via params._meta (no FK — the same defensive pattern the
  // rest of the schema uses for soft references).
  const invocationId = await recordSkillInvocation({
    skillId: def.id,
    source: ctx.source,
    status: "queued",
    params,
    summary: "Queued as a background tool job (starting)",
    agent: ctx.agent,
    workflowId: ctx.workflowId,
    nodeId: ctx.nodeId,
  });

  const toolKey = def.id.split(".")[1] ?? def.id;
  const triggeredBy = ctx.agent ? `agent:${ctx.agent.title}` : "agent:skill-lane";
  let jobId: string;
  try {
    const job = await db.toolJob.create({
      data: {
        tool: toolKey,
        params: JSON.stringify({
          ...params,
          _meta: { executor: "skill-queue", invocationId: invocationId ?? null },
        }),
        status: "queued",
        stdout: "",
        stderr: "",
        outputFiles: JSON.stringify([]),
        triggeredBy,
        agentId: ctx.agent?.id ?? null,
      },
    });
    jobId = job.id;
  } catch (e) {
    // Row creation failed — fail the invocation row honestly (never leave a
    // "queued" audit row with nothing behind it).
    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: {
            status: "error",
            error: `Failed to create the tool job: ${(e as Error).message}`,
          },
        })
        .catch(() => {});
    }
    return {
      skillId: def.id,
      status: "error",
      summary: `${def.label} could not be queued`,
      error: `Failed to create the tool job: ${(e as Error).message}`,
      durationMs: Date.now() - t0,
      ...(invocationId ? { invocationId } : {}),
    };
  }

  // Link the summary to the concrete job id (the row now exists).
  if (invocationId) {
    await db.skillInvocation
      .updateMany({
        where: { id: invocationId, status: "queued" },
        data: { resultSummary: `Queued as tool job ${jobId} — running in the background` },
      })
      .catch(() => {});
  }

  // 6. Fire-and-forget execution. The void promise has its own crash net —
  // this function must return the "queued" envelope immediately.
  // N1: custom (webhook) defs capture the resolved def object directly —
  // the background executor runs in THIS module instance, so the closure
  // is immune to registry re-syncs while the job is in flight.
  void executeQueuedSkillJob({
    jobId,
    toolKey,
    params,
    invocationId,
    t0,
    source: ctx.source,
    ...(def.family === "custom" ? { customDef: def } : {}),
  }).catch(async (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    await db.toolJob
      .updateMany({
        where: { id: jobId, status: { in: ["queued", "running"] } },
        data: {
          status: "failed",
          stderr: `Queue executor crashed: ${msg}`,
          exitCode: 1,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: { status: "error", error: `Queue executor crashed: ${msg}` },
        })
        .catch(() => {});
    }
  });

  return {
    skillId: def.id,
    status: "queued",
    summary:
      `Queued as tool job ${jobId} — running in the background. Watch the ` +
      "Skills Activity tab (this row flips to ok / error / cancelled when the " +
      "run lands); results land there when done.",
    durationMs: Date.now() - t0,
    data: { jobId },
    ...(invocationId ? { invocationId } : {}),
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/** Audit + return an envelope for pre-queue refusals (invalid/denied/limited). */
async function queuedEnvelope(
  result: SkillRunResult,
  ctx: SkillContext,
  params: Record<string, unknown>,
): Promise<SkillRunResult> {
  const invocationId = await recordSkillInvocation({
    skillId: result.skillId,
    source: ctx.source,
    status: result.status,
    params,
    summary: result.status === "ok" ? result.summary : undefined,
    error: result.status === "ok" ? undefined : (result.error ?? result.summary),
    durationMs: result.durationMs,
    agent: ctx.agent,
    workflowId: ctx.workflowId,
    nodeId: ctx.nodeId,
  });
  return invocationId ? { ...result, invocationId } : result;
}

/** The background executor — one job, fully conditional-write-disciplined.
 *  N1: `customDef` present → this is a SLOW custom webhook skill: the
 *  "engine" is the registered handler (a fetch to the user's endpoint,
 *  slow timeout + stoppable abort). Everything else is the comp lane. */
async function executeQueuedSkillJob(args: {
  jobId: string;
  toolKey: string;
  params: Record<string, unknown>;
  invocationId?: string;
  t0: number;
  /** The enqueue's true source — the webhook payload reports it. */
  source: SkillContext["source"];
  customDef?: SkillDefinition;
}): Promise<void> {
  const { jobId, toolKey, params, invocationId, t0, customDef } = args;

  // Claim: queued → running. Zero rows = stopped while queued (the stop
  // route flips the row to cancelled) → the invocation honestly never ran.
  const claimed = await db.toolJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) {
    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: {
            status: "cancelled",
            error: "Stopped by the user before the engine started.",
          },
        })
        .catch(() => {});
    }
    return;
  }

  // ── N1 custom (webhook) branch ──────────────────────────────────────────
  if (customDef) {
    return await executeQueuedWebhookJob({
      jobId,
      params,
      invocationId,
      t0,
      def: customDef,
      source: args.source,
    });
  }

  // ── comp engine branch (unchanged K5 lane) ─────────────────────────────
  const workDir = join(OUTPUTS_ROOT, toolKey, jobId);
  await fs.mkdir(workDir, { recursive: true }).catch(() => {});

  const result = await executeCompToolReal(toolKey, params, workDir, {
    // runKey = jobId: the ToolJob stop route registers requestStop(jobId) +
    // killActiveProcess(jobId) — the pre-spawn guard and the process
    // registry give these rows the same real-stop story as canvas nodes.
    runKey: jobId,
  });

  const ok = result.exitCode === 0;
  const def = getCompTool(toolKey);
  const summary = def ? def.resultSummary(params, result.stdout) : "";
  const fullStdout = result.stdout
    ? `${result.stdout}\n\n${summary}`.trimEnd()
    : summary;
  const now = new Date();

  // Final ToolJob write — ONLY a row still running takes the outcome (a
  // stopped row keeps its cancelled verdict; the engine's late result is
  // discarded rather than resurrecting the job).
  const fin = await db.toolJob.updateMany({
    where: { id: jobId, status: "running" },
    data: {
      status: ok ? "completed" : "failed",
      stdout: fullStdout,
      stderr: result.stderr,
      outputFiles: JSON.stringify(result.outputFiles),
      exitCode: result.exitCode,
      command: result.command,
      params: JSON.stringify({
        ...params,
        _meta: {
          executor: result.executor,
          realToolUsed: result.realToolUsed,
          workDir,
          ...(invocationId ? { invocationId } : {}),
        },
      }),
      finishedAt: now,
    },
  });
  if (fin.count === 0) {
    // Stopped mid-flight — the SIGTERM'd engine resolved, but the row was
    // cancelled by the user while it ran.
    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: {
            status: "cancelled",
            error: "Stopped by the user while the engine was running.",
            durationMs: Date.now() - t0,
          },
        })
        .catch(() => {});
    }
    return;
  }

  // Terminal audit write — same conditional discipline.
  if (invocationId) {
    await db.skillInvocation
      .updateMany({
        where: { id: invocationId, status: "queued" },
        data: {
          status: ok ? "ok" : "error",
          ...(ok
            ? {
                resultSummary: result.outputFiles.length
                  ? `${summary}\nArtifacts: ${result.outputFiles.join(", ")}`
                  : summary,
              }
            : {
                error: (result.stderr || result.stdout || "engine failed").slice(0, 400),
              }),
          durationMs: Date.now() - t0,
        },
      })
      .catch(() => {});
  }
}

// ── N1: queued WEBHOOK executor ──────────────────────────────────────────

/** Background executor for a SLOW custom webhook skill (runKey = jobId).
 *
 *  Same contract as the comp branch: claim happened already; the final
 *  writes are conditional (a row the stop route flipped to cancelled
 *  matches zero rows and keeps its verdict), the invocation row flips
 *  queued → ok | error | cancelled, and a crash anywhere fails both rows
 *  honestly via the caller's catch net.
 *
 *  Real stop: an AbortController is registered for the WHOLE in-flight
 *  window (claim → fetch settle) — killActiveProcess(jobId) aborts the
 *  fetch, the handler throws, and the conditional final write preserves
 *  the cancelled verdict the stop route already wrote. */
async function executeQueuedWebhookJob(args: {
  jobId: string;
  params: Record<string, unknown>;
  invocationId?: string;
  t0: number;
  def: SkillDefinition;
  source: SkillContext["source"];
}): Promise<void> {
  const { jobId, params, invocationId, t0, def } = args;

  // Stoppable-signal plumbing: registered BEFORE the pre-flight check so
  // a stop that lands in the claim→check gap still reaches the controller
  // (killActiveProcess aborts it — a no-op pre-fetch, but it also flipped
  // the row, which the check below then honors).
  const ctl = new AbortController();
  registerWebhookAbort(jobId, ctl);
  try {
    // Pre-flight stop guard (mirrors the engine lane's pre-spawn guard):
    // a stop requested between the claim and the fetch start means the
    // webhook never fires — the row was already flipped by the stop route.
    if (isStopRequested(jobId)) {
      if (invocationId) {
        await db.skillInvocation
          .updateMany({
            where: { id: invocationId, status: "queued" },
            data: {
              status: "cancelled",
              error: "Stopped by the user before the webhook started.",
            },
          })
          .catch(() => {});
      }
      return;
    }

    // The handler is the SAME one the inline lane uses — the slow timeout
    // and the abort signal are threaded through ctx.extras.
    let data: unknown;
    try {
      data = await def.handler(params, {
        // The invocation row already carries the true source from the
        // enqueue; the handler only uses it for the webhook payload's
        // transparency field, so pass it through unchanged.
        source: args.source,
        extras: { webhookAbortSignal: ctl.signal },
      });
    } finally {
      // Whatever happened, this run's controller is done — the slot must
      // be free for a retry's new registration.
      unregisterWebhookAbort(jobId, ctl);
    }

    const summary = def.summarize
      ? safeCustomSummary(def, data)
      : `${def.label} completed`;
    const responseSnippet = (() => {
      try {
        return JSON.stringify(data).slice(0, 2000);
      } catch {
        return "";
      }
    })();

    // Final ToolJob write — only a row still RUNNING takes the outcome.
    const fin = await db.toolJob.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "completed",
        stdout: responseSnippet ? `${summary}\n\nWebhook response: ${responseSnippet}` : summary,
        stderr: "",
        outputFiles: JSON.stringify([]),
        exitCode: 0,
        command: `webhook ${def.id}`,
        params: JSON.stringify({
          ...params,
          _meta: {
            executor: "skill-queue-webhook",
            skillId: def.id,
            ...(invocationId ? { invocationId } : {}),
          },
        }),
        finishedAt: new Date(),
      },
    });
    if (fin.count === 0) {
      // Stopped mid-flight — the aborted fetch threw, the stop route had
      // already flipped the row; keep the honest cancelled verdict.
      if (invocationId) {
        await db.skillInvocation
          .updateMany({
            where: { id: invocationId, status: "queued" },
            data: {
              status: "cancelled",
              error: "Stopped by the user while the webhook was running.",
              durationMs: Date.now() - t0,
            },
          })
          .catch(() => {});
      }
      return;
    }

    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: {
            status: "ok",
            resultSummary: summary,
            durationMs: Date.now() - t0,
          },
        })
        .catch(() => {});
    }
    return;
  } catch (e) {
    // The webhook failed (unreachable / non-2xx / aborted).
    const msg = e instanceof Error ? e.message : String(e);
    // A user stop aborts the fetch — that is a CANCELLED run, not a failed
    // one, even if this write races ahead of the stop route's row flip.
    // Both writes are conditional + idempotent: the first to land sets
    // cancelled, the other matches zero rows — the row can never end up
    // "failed" over a stop the user asked for.
    if (ctl.signal.aborted && isStopRequested(jobId)) {
      await db.toolJob
        .updateMany({
          where: { id: jobId, status: "running" },
          data: {
            status: "cancelled",
            stderr: msg.slice(0, 2000),
            outputFiles: JSON.stringify([]),
            exitCode: 1,
            command: `webhook ${def.id}`,
            params: JSON.stringify({
              ...params,
              _meta: {
                executor: "skill-queue-webhook",
                skillId: def.id,
                ...(invocationId ? { invocationId } : {}),
              },
            }),
            finishedAt: new Date(),
          },
        })
        .catch(() => {});
      if (invocationId) {
        await db.skillInvocation
          .updateMany({
            where: { id: invocationId, status: "queued" },
            data: {
              status: "cancelled",
              error: "Stopped by the user while the webhook was running.",
              durationMs: Date.now() - t0,
            },
          })
          .catch(() => {});
      }
      return;
    }
    const fin = await db.toolJob.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "failed",
        stdout: "",
        stderr: msg.slice(0, 2000),
        outputFiles: JSON.stringify([]),
        exitCode: 1,
        command: `webhook ${def.id}`,
        params: JSON.stringify({
          ...params,
          _meta: {
            executor: "skill-queue-webhook",
            skillId: def.id,
            ...(invocationId ? { invocationId } : {}),
          },
        }),
        finishedAt: new Date(),
      },
    });
    if (fin.count === 0) {
      if (invocationId) {
        await db.skillInvocation
          .updateMany({
            where: { id: invocationId, status: "queued" },
            data: {
              status: "cancelled",
              error: "Stopped by the user while the webhook was running.",
              durationMs: Date.now() - t0,
            },
          })
          .catch(() => {});
      }
      return;
    }
    if (invocationId) {
      await db.skillInvocation
        .updateMany({
          where: { id: invocationId, status: "queued" },
          data: {
            status: "error",
            error: msg.slice(0, 400),
            durationMs: Date.now() - t0,
          },
        })
        .catch(() => {});
    }
  } finally {
    unregisterWebhookAbort(jobId, ctl);
  }
}

function safeCustomSummary(def: SkillDefinition, data: unknown): string {
  try {
    return def.summarize!(data) || `${def.label} completed`;
  } catch {
    return `${def.label} completed`;
  }
}
