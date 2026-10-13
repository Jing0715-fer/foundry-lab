// mini-services/skill-events — P2a push channel for skill invocations.
//
// The main app's skill layer (runSkill / the K5 queue executor) writes
// SkillInvocation rows in SQLite. O2's live refresh POLLs those rows (4s
// point queries from open chat drawers). This service upgrades the model
// to PUSH: the app's server POSTs each invocation write to /emit here,
// and every connected browser receives it over socket.io in real time —
// no polling while connected (the drawer keeps a slow poll ONLY as an
// offline fallback).
//
//   POST /emit     ← server-to-server only (the Next.js app). Body:
//                    { channel: "invocation", row: { id, skillId, status,
//                    source, agentId?, agentTitle?, createdAt, … } }
//                    → io.emit("invocation", row) → 202
//                    Invalid envelope → 400 (the app treats emit as
//                    best-effort and never blocks on it anyway).
//   GET /health    → 200 { ok, service, port, clients } (daemon liveness)
//
// Transport path: the Caddy gateway forwards any request carrying the
// XTransformPort=3031 QUERY to this port — path-agnostic. Browser clients
// connect with io("/?XTransformPort=3031"): the URL path is the socket.io
// NAMESPACE ("/" — the default), the query rides along on every engine.io
// request, and the engine transport path stays the client DEFAULT
// (/socket.io). The server therefore keeps the DEFAULT engine path too —
// deliberately NOT "/" (that would make engine.io claim EVERY request on
// the port and the /health + /emit HTTP lanes below would be unreachable,
// answering engine errors instead — verified empirically).
//
// Port is FIXED at 3031 (sandbox rule: no PORT env for mini services).

import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import { Server } from "socket.io";

const PORT = 3031;

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "skill-events",
        port: PORT,
        clients: io.engine.clientsCount,
      }),
    );
    return;
  }

  // ── the emit lane (server-to-server from the Next.js app) ──────────────
  // Delivery is best-effort BY DESIGN: the app never blocks an
  // invocation on the broadcast, and a dropped event only costs the
  // client a poll fallback tick — never a wrong verdict.
  if (req.method === "POST" && path === "/emit") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) req.destroy(); // 1MB guard
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as {
          channel?: unknown;
          row?: unknown;
        };
        const row =
          parsed.channel === "invocation" &&
          parsed.row &&
          typeof parsed.row === "object"
            ? (parsed.row as Record<string, unknown>)
            : null;
        if (!row || typeof row.id !== "string" || typeof row.status !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                'body must be { channel: "invocation", row: { id, status, … } }',
            }),
          );
          return;
        }
        io.emit("invocation", row);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ emitted: true, rowId: row.id }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const io = new Server(httpServer, {
  // DEFAULT engine path ("/socket.io") — see the header comment: a "/"
  // engine path would claim /health and /emit too. The browser-facing
  // contract is unaffected: io("/?XTransformPort=3031") sets the namespace
  // + query, and the transport path is the client default anyway.
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

// ── client connections (browser) ────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(
    `[skill-events] client connected (${socket.id}) — ${io.engine.clientsCount} online`,
  );
  socket.on("disconnect", (reason) => {
    console.log(`[skill-events] client left (${socket.id}, ${reason})`);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `[skill-events] listening on :${PORT} (socket.io path "/", POST /emit, GET /health)`,
  );
});
