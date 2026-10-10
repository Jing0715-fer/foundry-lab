// LLM wrapper around z-ai-web-dev-sdk (server-only).
import ZAI from "z-ai-web-dev-sdk";

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getClient() {
  if (_zai) return _zai;
  _zai = await ZAI.create();
  return _zai;
}

/** Shared ZAI client for server-side SDK consumers (web-search skill, …). */
export function getZaiClient() {
  return getClient();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  thinking?: "enabled" | "disabled";
}

/**
 * Single-shot chat completion. Returns the assistant text.
 * Falls back to a deterministic stub if the SDK / network is unavailable so
 * the UI never hard-fails in the sandbox.
 */
export async function chat(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  try {
    const zai = await getClient();
    const payload: Record<string, unknown> = {
      messages,
      temperature: opts.temperature ?? 0.7,
      thinking: { type: opts.thinking === "enabled" ? "enabled" : "disabled" },
    };
    if (opts.maxTokens != null) payload.max_tokens = opts.maxTokens;
    if (opts.topP != null) payload.top_p = opts.topP;
    type Completion = { choices: { message: { content?: string } }[] };
    const create = zai.chat.completions.create as unknown as (p: Record<string, unknown>) => Promise<Completion>;
    const completion = await create(payload);
    const content = completion.choices[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch (err) {
    console.error("[llm] chat failed, using stub:", (err as Error).message);
    return stubReply(messages, opts);
  }
}

/**
 * REAL streaming chat — asks the SDK for an SSE stream (`stream: true`) and
 * forwards every decoded delta to onDelta as it arrives. If the upstream
 * refuses streaming (non-stream content-type, error, or empty stream), falls
 * back to a single-shot completion + chunked emit so the client always sees
 * progressive text.
 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  // Try the real stream first.
  try {
    const zai = await getClient();
    const payload: Record<string, unknown> = {
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      thinking: { type: opts.thinking === "enabled" ? "enabled" : "disabled" },
    };
    if (opts.maxTokens != null) payload.max_tokens = opts.maxTokens;
    if (opts.topP != null) payload.top_p = opts.topP;
    const create = zai.chat.completions.create as unknown as (p: Record<string, unknown>) => Promise<unknown>;
    const result = await create(payload);

    // The SDK returns the raw Response.body (a Web ReadableStream) when the
    // server streams; anything else means non-streaming JSON.
    const body = result as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
    if (body && typeof body.getReader === "function") {
      const full = await consumeSseStream(body as ReadableStream<Uint8Array>, onDelta);
      if (full) return full;
      // Empty stream (no deltas decoded) — fall through to the fallback path
      // rather than returning an empty assistant turn.
    }
  } catch (err) {
    console.warn(
      "[llm] real stream unavailable, falling back to chunked emit:",
      (err as Error).message,
    );
  }

  // Fallback: single-shot + chunked emit (still real model output).
  const full = await chat(messages, opts);
  const chunks = full.match(/[\s\S]{1,18}/g) ?? [full];
  for (const c of chunks) {
    onDelta(c);
    await new Promise((r) => setTimeout(r, 12));
  }
  return full;
}

/**
 * Decode an OpenAI-style SSE stream: `data: {"choices":[{"delta":{"content":…}}]}`
 * events terminated by `data: [DONE]`. Returns the concatenated text.
 */
async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line. Process every complete
      // event in the buffer; keep the trailing partial for the next chunk.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const evt = JSON.parse(data) as {
              choices?: { delta?: { content?: string }; message?: { content?: string } }[];
            };
            const delta =
              evt.choices?.[0]?.delta?.content ?? evt.choices?.[0]?.message?.content;
            if (typeof delta === "string" && delta.length > 0) {
              full += delta;
              onDelta(delta);
            }
          } catch {
            // keep-alive / non-JSON event — ignore.
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return full;
}

/** Deterministic offline stub used when the real LLM is unreachable. */
function stubReply(messages: ChatMessage[], opts: LLMOptions): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const sys = messages.find((m) => m.role === "system");
  const persona = sys ? sys.content.split("\n")[0].replace(/^You are /i, "") : "Assistant";
  const q = (last?.content ?? "").slice(0, 160);
  return [
    `[offline ${persona.trim()} • temp=${opts.temperature ?? 0.7}]`,
    "",
    `I received your message: "${q}".`,
    "",
    "The live LLM endpoint is currently unreachable in this sandbox, so this is a deterministic placeholder. In production this would be a real model response carrying tool-call fences and a full scientific argument.",
  ].join("\n");
}
