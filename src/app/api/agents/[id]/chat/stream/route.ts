import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO, buildAgentSystemPrompt, skillCallToToolCall } from "@/lib/run-utils";
import { chatStream, type ChatMessage } from "@/lib/llm";
// Barrel import — self-registers the skill catalog (side effect).
import { getSkill, extractSkillCalls, runSkill, skipSkill, skillFeedback } from "@/lib/skills";
import type { ToolCall } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/agents/:id/chat/stream
 *
 * Server-Sent Events endpoint that streams the agent's response
 * token-by-token. Emits the following events:
 *
 *   event: start  data: { agentId }
 *   event: delta  data: { delta }            (one chunk of text)
 *   event: done   data: { content, messageId, toolCalls? }
 *   event: error  data: { error }            (terminal — connection closes)
 *
 * chatStream performs REAL SDK streaming (SSE deltas decoded as they
 * arrive); the deterministic chunked-emit path is only a fallback when the
 * upstream refuses streaming. LLM sampling options come from the agent's
 * saved runtime config (fine-tune dialog).
 *
 * History window: the LATEST 50 messages (desc + take, then reversed) —
 * mirroring the non-stream POST /chat route. (The old asc+take query loaded
 * the OLDEST 50, so once a chat exceeded 50 turns the agent answered with
 * ancient context.)
 *
 * Skill-calling round (pragmatic streaming version, J lane): after the first
 * streamed reply completes, parse it with extractSkillCalls (```skill + legacy
 * ```tool / ```bio fences). Per call:
 *   - FAST skills (bio / web) execute via runSkill — full validate → gate →
 *     execute → audit, exactly like the non-stream lane;
 *   - SLOW skills (comp engines, minutes) are declined by lane policy and
 *     recorded as "skipped" SkillInvocations — visible, not invisible;
 *   - unknown ids / invalid params return honest "invalid" envelopes;
 *   - ONE follow-up streamed completion runs with the skill feedback appended
 *     to the conversation, streaming its deltas into this same SSE response
 *     (what the user sees = exactly what gets persisted);
 *   - the invocation results are persisted on the assistant message as
 *     ToolCalls so the chat UI renders them like the non-stream lane's.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { message?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // empty body — handled below by the String("") fallback.
  }
  const message =
    typeof body.message === "string" ? body.message : String(body.message ?? "");

  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent) {
    return new Response("Agent not found", { status: 404 });
  }

  // Persist the user message first so history queries below include it.
  await db.chatMessage.create({
    data: { agentId: id, role: "user", content: message },
  });

  const agentDTO = toAgentDTO(agent);
  // System prompt = persona + live skill manifest + fine-tune suffix — the
  // exact same builder the non-stream lane uses (single source of truth).
  const system = buildAgentSystemPrompt(agentDTO);
  // Runtime sampling defaults (fine-tune dialog); fall back to sane values.
  const rt = agentDTO.runtime;
  const llmOpts = {
    temperature: rt?.temperature ?? 0.7,
    ...(rt?.maxTokens != null ? { maxTokens: rt.maxTokens } : {}),
    ...(rt?.topP != null ? { topP: rt.topP } : {}),
  };

  // LATEST 50 messages for context (desc + take → reverse, like the
  // non-stream route). The saved user row above means our message IS the
  // last element — slice it off and append it explicitly below (kept
  // identical to the old shape so the follow-up loop below can reuse the
  // array).
  const recent = await db.chatMessage.findMany({
    where: { agentId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const history = [...recent].reverse();
  const priorHistory = history.slice(0, -1);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...priorHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: message },
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      };

      send("start", { agentId: id });

      let fullText = "";
      try {
        fullText = await chatStream(
          messages,
          (delta) => {
            fullText += delta;
            send("delta", { delta });
          },
          llmOpts,
        );
        // Prefer the canonical return value if the SDK returned something
        // (defensive — the onDelta accumulation should match, but a future
        // real-streaming implementation might differ on the final chunk).
        if (fullText) {
          // already accumulated via callback; keep as-is.
        }
      } catch (err) {
        send("error", { error: (err as Error).message });
        // Persist any partial text we accumulated so the user's turn isn't lost.
        if (fullText.trim()) {
          try {
            await db.chatMessage.create({
              data: { agentId: id, role: "assistant", content: fullText },
            });
          } catch {
            // ignore — best-effort partial-save.
          }
        }
        controller.close();
        return;
      }

      // ── Skill-calling round (pragmatic streaming version) ────────────────
      // Parse the streamed reply with the unified fence parser; execute the
      // FAST skills and run ONE follow-up streamed completion folding the
      // feedback in. Everything streamed into this SSE response is what gets
      // persisted (content === what the user saw).
      const toolCalls: ToolCall[] = [];
      let content = fullText;
      try {
        const calls = extractSkillCalls(fullText);
        if (calls.length > 0) {
          const followUps: string[] = [];
          for (const call of calls) {
            const def = getSkill(call.skillId);
            // Fast skills (bio/web) run inline through the full pipeline;
            // slow skills (comp engines) are declined by lane policy and
            // AUDITED as "skipped"; unknown ids flow through runSkill and
            // get honest "invalid" envelopes (hallucinations become visible).
            const res =
              !def || def.latency === "fast"
                ? await runSkill(call.skillId, call.params, {
                    source: "chat-stream",
                    agent: agentDTO,
                  })
                : await skipSkill(
                    call.skillId,
                    "Slow engine skills are not executed in the streaming chat " +
                      "lane — tell the user to run them via the workflow canvas " +
                      "or the Tools panel.",
                    { source: "chat-stream", agent: agentDTO },
                  );
            toolCalls.push(skillCallToToolCall(call, res));
            followUps.push(skillFeedback(res));
          }

          // ONE follow-up streamed completion with the tool results appended.
          const followUpMessages: ChatMessage[] = [
            ...messages,
            { role: "assistant", content: fullText },
            {
              role: "user",
              content: `${followUps.join("\n\n")}\n\nRevise your answer using these results.`,
            },
          ];
          const followUpText = await chatStream(
            followUpMessages,
            (delta) => {
              send("delta", { delta });
            },
            llmOpts,
          );
          content = followUpText
            ? `${fullText}\n\n${followUpText}`
            : fullText;
        }
      } catch (err) {
        // Tool round failed — the first reply is still complete and useful;
        // persist it without toolCalls and note the error on the stream.
        send("error", { error: `Tool round failed: ${(err as Error).message}` });
      }

      // Save the final assistant message (with the parsed/executed tool calls).
      let savedId: string | undefined;
      try {
        const saved = await db.chatMessage.create({
          data: {
            agentId: id,
            role: "assistant",
            content,
            ...(toolCalls.length > 0
              ? { toolCalls: JSON.stringify(toolCalls) }
              : {}),
          },
        });
        savedId = saved.id;
      } catch (err) {
        send("error", { error: `Failed to save assistant message: ${(err as Error).message}` });
        controller.close();
        return;
      }

      send("done", {
        content,
        messageId: savedId,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
