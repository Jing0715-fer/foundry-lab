// LLM wrapper around z-ai-web-dev-sdk (server-only).
import ZAI from "z-ai-web-dev-sdk";

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getClient() {
  if (_zai) return _zai;
  _zai = await ZAI.create();
  return _zai;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
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

/** Streaming chat — calls onDelta for each text chunk. Returns full text. */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  // The SDK stream flag is unreliable in sandbox; emulate via single shot + chunked emit.
  const full = await chat(messages, opts);
  const chunks = full.match(/[\s\S]{1,18}/g) ?? [full];
  for (const c of chunks) {
    onDelta(c);
    await new Promise((r) => setTimeout(r, 12));
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
