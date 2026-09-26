import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO } from "@/lib/run-utils";
import { generateAgentSystemPrompt } from "@/lib/agents";
import { chatStream, type ChatMessage } from "@/lib/llm";

export const runtime = "nodejs";

/**
 * POST /api/agents/:id/chat/stream
 *
 * Server-Sent Events endpoint that streams the agent's response
 * token-by-token. Emits the following events:
 *
 *   event: start  data: { agentId }
 *   event: delta  data: { delta }            (one chunk of text)
 *   event: done   data: { content, messageId }
 *   event: error  data: { error }            (terminal — connection closes)
 *
 * The underlying `chatStream` helper is a "fake stream" (single shot
 * completion + chunked emit), but the SSE framing here is correct so the
 * client treats it like a real token stream. When the SDK supports true
 * streaming we can swap the implementation of `chatStream` without touching
 * this endpoint.
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
  const system = generateAgentSystemPrompt(agentDTO);

  // Fetch last 50 messages (ascending) for context. We slice off the final
  // user message because we already append it explicitly below — but the
  // saved user row above means it IS in the history query result.
  const history = await db.chatMessage.findMany({
    where: { agentId: id },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
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
          { temperature: 0.7 },
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

      // Save the final assistant message.
      let savedId: string | undefined;
      try {
        const saved = await db.chatMessage.create({
          data: { agentId: id, role: "assistant", content: fullText },
        });
        savedId = saved.id;
      } catch (err) {
        send("error", { error: `Failed to save assistant message: ${(err as Error).message}` });
        controller.close();
        return;
      }

      send("done", { content: fullText, messageId: savedId });
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
