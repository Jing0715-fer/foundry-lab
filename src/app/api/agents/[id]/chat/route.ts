import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO, runAgentTurn } from "@/lib/run-utils";
import type { ChatMessageDTO, ToolCall } from "@/lib/types";

/** GET /api/agents/:id/chat — last 100 messages as ChatMessageDTO[]. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rows = await db.chatMessage.findMany({
    where: { agentId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Reverse to ascending chronological order for the client.
  const asc = [...rows].reverse();

  const dtos: ChatMessageDTO[] = asc.map((m) => ({
    id: m.id,
    agentId: m.agentId,
    role: m.role as "user" | "assistant",
    content: m.content,
    toolCalls: parseToolCalls(m.toolCalls),
    createdAt: m.createdAt.toISOString(),
  }));

  return NextResponse.json(dtos);
}

/** POST /api/agents/:id/chat — send a user message and run the agent. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const agentRow = await db.agent.findUnique({ where: { id } });
    if (!agentRow) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = toAgentDTO(agentRow);

    let body: { message?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const message = body.message;
    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "message (string) is required" },
        { status: 400 },
      );
    }

    // Fetch last 50 chat messages (ascending) for history context.
    const recent = await db.chatMessage.findMany({
      where: { agentId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const history = [...recent]
      .reverse()
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Persist the user message.
    await db.chatMessage.create({
      data: { agentId: id, role: "user", content: message },
    });

    // The history above was fetched BEFORE the save, so the agent would
    // otherwise never see the message it must answer — append it explicitly.
    history.push({ role: "user", content: message });

    // Run the agent turn (tool-calling loop). No explicit temperature —
    // the agent's saved runtime config (fine-tune dialog) is the default.
    const result = await runAgentTurn(agent, history, {
      maxRounds: 3,
    });

    // Persist the assistant message.
    const assistantRow = await db.chatMessage.create({
      data: {
        agentId: id,
        role: "assistant",
        content: result.text,
        toolCalls: JSON.stringify(result.toolCalls),
      },
    });

    const dto: ChatMessageDTO = {
      id: assistantRow.id,
      agentId: assistantRow.agentId,
      role: "assistant",
      content: assistantRow.content,
      toolCalls: result.toolCalls,
      createdAt: assistantRow.createdAt.toISOString(),
    };

    return NextResponse.json(dto);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE /api/agents/:id/chat — clear all chat messages for this agent. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await db.chatMessage.deleteMany({ where: { agentId: id } });
  return NextResponse.json({ ok: true });
}

/** Parse a stored toolCalls JSON string into a typed array. */
function parseToolCalls(raw: string | null | undefined): ToolCall[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ToolCall[]) : undefined;
  } catch {
    return undefined;
  }
}
