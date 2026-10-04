import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO } from "@/lib/run-utils";
import { generateAgentSystemPrompt } from "@/lib/agents";
import { chatStream, type ChatMessage } from "@/lib/llm";
import { extractToolCalls } from "@/lib/tools";
import { runBio } from "@/lib/bio-tools";
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
 * Tool-calling loop (pragmatic streaming version): after the first streamed
 * reply completes, parse it with the SAME extractToolCalls helper the
 * non-stream lane uses. When tool fences are present:
 *   - BIO tool calls execute immediately (fast HTTP queries) and their
 *     results are recorded as ToolCalls;
 *   - COMP tool fences are NOT executed inline (they can run for minutes —
 *     the model is told to point the user at the canvas/Tools panel);
 *   - ONE follow-up streamed completion runs with the tool results appended
 *     to the conversation, streaming its deltas into this same SSE response
 *     (what the user sees = exactly what gets persisted);
 *   - the parsed+executed toolCalls are persisted on the assistant message
 *     so the chat UI renders them like the non-stream lane's.
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
  // System prompt = agent persona + the fine-tune dialog's saved suffix.
  const baseSystem = generateAgentSystemPrompt(agentDTO);
  const suffix = agentDTO.runtime?.systemPromptSuffix?.trim();
  const system = suffix
    ? `${baseSystem}\n\n--- Additional operator instructions ---\n${suffix}`
    : baseSystem;
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

      // ── Tool-calling round (pragmatic streaming version) ────────────────
      // Parse the streamed reply with the same fence parser the non-stream
      // lane uses; execute the FAST bio tools and run ONE follow-up streamed
      // completion folding the results in. Everything streamed into this SSE
      // response is what gets persisted (content === what the user saw).
      const toolCalls: ToolCall[] = [];
      let content = fullText;
      try {
        const { comp, bio } = extractToolCalls(fullText);
        if (bio.length > 0 || comp.length > 0) {
          const followUps: string[] = [];
          for (const b of bio) {
            try {
              const res = await runBio(
                b.type as "blast" | "pdb" | "pubmed" | "uniprot",
                b as Record<string, unknown>,
              );
              const summary = res.hits
                .map((h) => `- ${h.id}: ${h.title}`)
                .join("\n");
              toolCalls.push({
                kind: "bio",
                tool: b.type,
                params: b as Record<string, unknown>,
                result: summary,
                status: "completed",
              });
              followUps.push(
                `[Bio tool ${b.type} returned ${res.count} hits]\n${summary}\n\nIncorporate these into your answer.`,
              );
            } catch (e) {
              toolCalls.push({
                kind: "bio",
                tool: b.type,
                params: b as Record<string, unknown>,
                result: `Error: ${(e as Error).message}`,
                status: "failed",
              });
              followUps.push(
                `[Bio tool ${b.type} failed: ${(e as Error).message}]`,
              );
            }
          }
          if (comp.length > 0) {
            // Comp tools (real engines) can run for minutes — they are NOT
            // executed inline in the streaming lane. Tell the model honestly
            // so its revised answer points the user at the right surface.
            followUps.push(
              `[Note: ${comp.length} computational tool request(s) cannot be executed in the streaming chat lane — ` +
                "tell the user to run them via the workflow canvas or the Tools panel.]",
            );
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
