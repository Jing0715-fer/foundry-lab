// GET /api/workflow/nodes/[id]/stream — Server-Sent Events endpoint that
// streams a node's run progress live. Polls the DB every 500ms and emits a
// "status" event per poll; emits a terminal "done" event (and closes the
// stream) when the node reaches "completed" or "failed". A heartbeat comment
// is sent every 15s to keep proxies from closing the idle connection.
//
// Event shape:
//   event: status  data: { status, progress, logs, result }
//   event: done    data: { status }              (terminal — stream closes)
//   event: error   data: { error }               (terminal — stream closes)
//
// Use the browser-native EventSource API on the client (GET-based, simpler
// than fetch + ReadableStream for unidirectional server→client streaming).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller may have been closed by the client mid-write.
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      // Send initial state immediately so the client doesn't have to wait
      // 500ms for the first poll to learn the current status.
      const initial = await db.node.findUnique({ where: { id } });
      if (!initial) {
        send("error", { error: "Node not found" });
        close();
        return;
      }
      send("status", {
        status: initial.status,
        progress: initial.progress,
        logs: initial.logs ?? "",
        result: initial.result ?? "",
      });

      // Short-circuit if the node is already terminal on connection.
      if (initial.status === "completed" || initial.status === "failed") {
        send("done", { status: initial.status });
        close();
        return;
      }

      // Poll every 500ms until the node reaches a terminal state.
      const poll = async () => {
        if (closed) return;
        try {
          const current = await db.node.findUnique({ where: { id } });
          if (!current) {
            send("error", { error: "Node not found" });
            close();
            return;
          }
          send("status", {
            status: current.status,
            progress: current.progress,
            logs: current.logs ?? "",
            result: current.result ?? "",
          });
          if (current.status === "completed" || current.status === "failed") {
            send("done", { status: current.status });
            close();
            return;
          }
          setTimeout(poll, 500);
        } catch {
          send("error", { error: "Poll failed" });
          close();
        }
      };

      setTimeout(poll, 500);

      // Keep the connection alive with a heartbeat every 15s. SSE comment
      // lines (starting with `:`) are ignored by the EventSource client but
      // are seen as traffic by intermediate proxies, preventing idle drops.
      heartbeat = setInterval(() => {
        if (closed) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          closed = true;
        }
      }, 15000);
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
