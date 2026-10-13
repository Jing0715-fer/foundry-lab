// mini-services/skill-events — P2a push channel for skill invocations,
// Q2-hardened with ROOMS + EMIT AUTH.
//
// The main app's skill layer (runSkill / the K5 queue executor) writes
// SkillInvocation rows in SQLite. O2's live refresh POLLs those rows (4s
// point queries from open chat drawers). This service upgrades the model
// to PUSH: the app's server POSTs each invocation write to /emit here,
// and subscribed browsers receive it over socket.io in real time —
// no polling while connected (the drawer keeps a slow poll ONLY as an
// offline fallback).
//
// ── Q2 room model ────────────────────────────────────────────────────────────
// P2a broadcast to EVERY connected client was fine for the single-user
// sandbox, but it is a structural leak: any browser (any tab, any page on
// the gateway) received the full invocation firehose, and anyone could
// POST /emit and forge events. Q2 closes both:
//
//   ROOMS:   clients SUBSCRIBE — socket.emit("subscribe", { rooms: [...] })
//            with rooms drawn from a closed grammar:
//              "all"                     — the full firehose (default on
//                                         connect; the Skills Activity tab)
//              "agent:<agentId>"         — invocations attributed to one agent
//              "workflow:<workflowId>"   — invocations inside one workflow
//            A subscribe REPLACES the socket's previous room set (all-or-
//            nothing: any invalid room rejects the whole payload, state
//            unchanged — testable). /emit routes each row to the rooms its
//            agentId / workflowId imply + the "all" room. A socket that
//            never subscribes stays on "all" (P2a back-compat).
//
//   AUTH:    POST /emit requires the shared token (Authorization: Bearer …
//            or ?token=…). The token is generated ONCE at first boot and
//            persisted to ./.token (gitignored) — the Next app reads the
//            same file from events.ts. Browsers cannot read it (it never
//            crosses the wire to them), so the emit lane is now strictly
//            server-to-server. 401 otherwise.
//
// ── endpoints ───────────────────────────────────────────────────────────────
//   POST /emit       { channel: "invocation", row: { id, status, agentId?,
//                     workflowId?, … } } + Bearer token → 202 (routed rooms)
//                     401 without/with a wrong token · 400 invalid envelope
//   GET  /health     → 200 { ok, service, port, clients, rooms, auth }
//                     (rooms = per-room subscriber counts, managed rooms only)
//
// Transport path: the Caddy gateway forwards any request carrying the
// XTransformPort=3031 QUERY to this port — path-agnostic. Browser clients
// connect with io("/?XTransformPort=3031"): the URL path is the socket.io
// NAMESPACE ("/" — the default), the query rides along on every engine.io
// request, and the engine transport path stays the client DEFAULT
// (/socket.io). The server therefore keeps the DEFAULT engine path too —
// deliberately NOT "/" (that would make engine.io claim EVERY request on
// the port and the /health + /emit HTTP lanes below would be unreachable,
// answering engine errors instead — verified empirically, P-lane #51).
//
// Port is FIXED at 3031 (sandbox rule: no PORT env for mini services).

import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Server, type Socket } from "socket.io";

const PORT = 3031;
const TOKEN_FILE = join(dirname(fileURLToPath(import.meta.url)), ".token");

// ── the shared emit token (generated at first boot, gitignored) ─────────────
function ensureToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  console.log("[skill-events] generated a new emit token (.token)");
  return token;
}
const EMIT_TOKEN = ensureToken();

// ── Q2 room grammar ─────────────────────────────────────────────────────────
const ROOM_RE = /^(all|agent:[A-Za-z0-9_-]{1,64}|workflow:[A-Za-z0-9_-]{1,64})$/;
const MAX_ROOMS_PER_SOCKET = 32;
/** Managed room set per socket id (the server joins the socket's own id as
 *  a room too — that one is NOT tracked here, only our grammar rooms are). */
const subscriptions = new Map<string, Set<string>>();

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const presented = bearer || queryToken;
  return presented.length > 0 && presented === EMIT_TOKEN;
}

/** Route one invocation row to the rooms its attribution implies. */
function emitInvocation(row: Record<string, unknown>): void {
  const rooms = new Set<string>(["all"]);
  if (typeof row.agentId === "string" && row.agentId) {
    rooms.add(`agent:${row.agentId}`);
  }
  if (typeof row.workflowId === "string" && row.workflowId) {
    rooms.add(`workflow:${row.workflowId}`);
  }
  for (const room of rooms) {
    io.to(room).emit("invocation", row);
  }
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    const rooms: Record<string, number> = {};
    for (const [room, ids] of io.sockets.adapter.rooms) {
      if (ROOM_RE.test(room)) rooms[room] = ids.size;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "skill-events",
        port: PORT,
        clients: io.engine.clientsCount,
        rooms,
        auth: "bearer-token (POST /emit)",
      }),
    );
    return;
  }

  // ── the emit lane (server-to-server from the Next.js app) ──────────────
  // Delivery is best-effort BY DESIGN: the app never blocks an
  // invocation on the broadcast, and a dropped event only costs the
  // client a poll fallback tick — never a wrong verdict.
  if (req.method === "POST" && path === "/emit") {
    if (!isAuthorized(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "emit lane is server-to-server — present the shared token " +
            "(Authorization: Bearer <token> or ?token=).",
        }),
      );
      return;
    }
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
        emitInvocation(row);
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
io.on("connection", (socket: Socket) => {
  // Default: the firehose (P2a back-compat). The first "subscribe" from
  // the client REPLACES this set — narrow to what the surface needs.
  socket.join("all");
  subscriptions.set(socket.id, new Set(["all"]));
  console.log(
    `[skill-events] client connected (${socket.id}) — ${io.engine.clientsCount} online`,
  );

  // Q2: subscription management — all-or-nothing validation, replace
  // semantics, ack so the client (and QA) can assert the landed set.
  // An EMPTY rooms array is the explicit "clear" (leave everything) — a
  // closed chat drawer subscribes to nothing instead of the firehose.
  socket.on("subscribe", (payload: unknown, ack?: (reply: unknown) => void) => {
    const reply = applySubscription(socket, payload);
    if (typeof ack === "function") ack(reply);
    if (!reply.ok) {
      console.warn(`[skill-events] rejected subscribe from ${socket.id}: ${reply.error}`);
    }
  });

  socket.on("disconnect", (reason) => {
    subscriptions.delete(socket.id);
    console.log(`[skill-events] client left (${socket.id}, ${reason})`);
  });
});

interface SubscribeReply {
  ok: boolean;
  rooms?: string[];
  error?: string;
}

function applySubscription(socket: Socket, payload: unknown): SubscribeReply {
  const raw =
    payload && typeof payload === "object"
      ? (payload as { rooms?: unknown }).rooms
      : null;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: 'subscribe payload must be { rooms: ["all" | "agent:<id>" | "workflow:<id>", …] }',
    };
  }
  // Empty array = the explicit CLEAR (leave every managed room — the
  // closed-drawer state; distinct from a rejected payload).
  if (raw.length === 0) {
    const previous = subscriptions.get(socket.id) ?? new Set<string>();
    for (const r of previous) socket.leave(r);
    subscriptions.set(socket.id, new Set());
    return { ok: true, rooms: [] };
  }
  if (raw.length > MAX_ROOMS_PER_SOCKET) {
    return { ok: false, error: `at most ${MAX_ROOMS_PER_SOCKET} rooms per subscription` };
  }
  const rooms: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !ROOM_RE.test(r)) {
      return {
        ok: false,
        error:
          `invalid room ${JSON.stringify(r)} — use "all", "agent:<id>", ` +
          `or "workflow:<id>" (id charset: letters, digits, -, _)`,
      };
    }
    if (!rooms.includes(r)) rooms.push(r);
  }
  const previous = subscriptions.get(socket.id) ?? new Set<string>();
  for (const r of previous) {
    if (!rooms.includes(r)) socket.leave(r);
  }
  for (const r of rooms) socket.join(r);
  subscriptions.set(socket.id, new Set(rooms));
  return { ok: true, rooms };
}

httpServer.listen(PORT, () => {
  console.log(
    `[skill-events] listening on :${PORT} (rooms + bearer auth, POST /emit, GET /health)`,
  );
});
