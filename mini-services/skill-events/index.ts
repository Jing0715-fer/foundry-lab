// mini-services/skill-events — P2a push channel for skill invocations,
// Q2-hardened with ROOMS + EMIT AUTH, R1-hardened with CONNECTION IDENTITY.
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
//   ROOMS:   clients SUBSCRIBE — socket.emit("subscribe", { rooms: [...] })
//            with rooms drawn from a closed grammar:
//              "all"                     — the full firehose
//              "agent:<agentId>"         — invocations attributed to one agent
//              "workflow:<workflowId>"   — invocations inside one workflow
//            A subscribe REPLACES the socket's previous room set (all-or-
//            nothing: any invalid room rejects the whole payload, state
//            unchanged — testable). /emit routes each row to the rooms its
//            agentId / workflowId imply + the "all" room.
//
// ── R1 identity model (the Q2 boundary, closed) ──────────────────────────────
// Q2 rooms were a VOLUNTARY subscription: any client could claim any
// agentId and eavesdrop on any room, and the /emit token only stopped
// event FORGERY, not eavesdropping. R1 closes that:
//
//   GRANTS:  every connection must present a SESSION GRANT in the socket.io
//            handshake — auth: { token: "v1.<expMs>.<payloadB64url>.<hmac>" }.
//            The grant is minted SERVER-SIDE by the Next app
//            (GET /api/skills/events-session → mintSkillEventsSession) and
//            carries the entitlement: the MAXIMUM room set this connection
//            may ever subscribe to. The signature is HMAC-SHA256 over the
//            payload with a shared signing key; browsers never see the key.
//
//   ENFORCEMENT (server-side, not advisory):
//            - the connect middleware verifies signature + expiry and
//              REJECTS the connection without a valid grant;
//            - the connection's default room set = the grant's own rooms
//              (no more blanket "all" on connect);
//            - every "subscribe" is CLAMPED to the entitlement: a requested
//              room outside the grant is FILTERED OUT (eavesdropping is
//              refused by the server, not by client goodwill). A grant
//              holding "all" implies every room (the full-user entitlement
//              — narrowing from the firehose is always allowed). The ack
//              discloses the filtering honestly:
//                { ok: true, rooms: [...granted], requested: N, filtered: [...] }.
//
//   SECRETS: two secrets, each env-first with a generated-file fallback
//            (rotation WITHOUT restart — mismatch triggers a one-shot
//            re-read of the file):
//              emit token     SKILL_EVENTS_EMIT_TOKEN   → ./.token
//              signing key    SKILL_EVENTS_SIGNING_KEY  → ./.signing-key
//            The Next app reads the same values (env-first, same files) —
//            the mint route signs with the key, the emit lane presents the
//            token. Rotation: rewrite the files (or restart with new envs);
//            the service re-reads on the next mismatched verification, the
//            app re-reads on the next mint / after a 401. Grants minted
//            with the old key fail the middleware → the browser hook
//            re-mints (fresh read) → reconnects. No process restarts.
//
// ── endpoints ───────────────────────────────────────────────────────────────
//   POST /emit       { channel: "invocation", row: { id, status, agentId?,
//                     workflowId?, … } } + Bearer token → 202 (routed rooms)
//                     401 without/with a wrong token · 400 invalid envelope
//   GET  /health     → 200 { ok, service, port, clients, rooms, auth, grants }
//
// Transport path: the Caddy gateway forwards any request carrying the
// XTransformPort=3031 QUERY to this port — path-agnostic. Browser clients
// connect with io("/?XTransformPort=3031", { auth: { token } }): the URL
// path is the socket.io NAMESPACE ("/" — the default), the query rides
// along on every engine.io request, and the engine transport path stays
// the client DEFAULT (/socket.io). The server therefore keeps the DEFAULT
// engine path too — deliberately NOT "/" (that would make engine.io claim
// EVERY request on the port and the /health + /emit HTTP lanes below
// would be unreachable, answering engine errors instead — verified
// empirically, P-lane #51).
//
// Port is FIXED at 3031 (sandbox rule: no PORT env for mini services).

import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Server, type Socket } from "socket.io";

const PORT = 3031;
const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, ".token");
const SIGNING_KEY_FILE = join(HERE, ".signing-key");

// ── secrets (env-first, file fallback, mismatch-triggered re-read) ───────────

interface Secrets {
  emitToken: string;
  signingKey: string;
}
let secrets: Secrets | null = null;
let secretsAt = 0;
/** How stale the cached secrets may be. Bounded rotation propagation:
 *  an operator rewriting the files is picked up within ≤5s WITHOUT a
 *  restart, in BOTH directions — mismatch-triggered refresh (below) only
 *  detects a rotation when a NEW-key credential arrives; a revoked
 *  OLD-key grant would otherwise keep verifying against the stale cache.
 *  Five seconds of tiny reads is the honest price of "rotation sticks". */
const SECRETS_TTL_MS = 5_000;

function readEnvOrFile(envName: string, file: string, generate: () => string): string {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const value = generate();
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  console.log(`[skill-events] generated ${file} (set ${envName} to override)`);
  return value;
}

function loadSecrets(): Secrets {
  return {
    emitToken: readEnvOrFile("SKILL_EVENTS_EMIT_TOKEN", TOKEN_FILE, () =>
      randomBytes(24).toString("hex")),
    signingKey: readEnvOrFile("SKILL_EVENTS_SIGNING_KEY", SIGNING_KEY_FILE, () =>
      randomBytes(32).toString("hex")),
  };
}

function getSecrets(): Secrets {
  if (!secrets || Date.now() - secretsAt > SECRETS_TTL_MS) {
    secrets = loadSecrets();
    secretsAt = Date.now();
  }
  return secrets;
}

/** Force a re-read NOW (mismatch path + TTL expiry both land here). */
function refreshSecrets(): Secrets {
  secrets = loadSecrets();
  secretsAt = Date.now();
  return secrets;
}

// ── R1 grant verification (HMAC-signed, expiring) ───────────────────────────
//
// Grant format:  v1.<expiryMs>.<payloadB64url>.<hmacB64url>
//   payload = JSON { rooms: string[] }   — the entitlement (max room set)
//   hmac    = HMAC-SHA256(signingKey, "v1.<expiryMs>.<payloadB64url>")
// Browsers cannot mint grants (they never see the signing key) and cannot
// widen one (the payload is inside the signed bytes).

const GRANT_TTL_SLOP_MS = 5_000; // clock-skew tolerance on expiry

interface VerifiedGrant {
  rooms: Set<string>;
}

function verifyGrant(token: unknown, key: string): { grant?: VerifiedGrant; error?: string } {
  if (typeof token !== "string" || !token) {
    return { error: "connection requires a session grant (auth.token — GET /api/skills/events-session mints one)" };
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return { error: "malformed session grant" };
  }
  const [, expRaw, payloadB64, sigB64] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { error: "malformed session grant expiry" };
  }
  if (Date.now() > exp + GRANT_TTL_SLOP_MS) {
    return { error: "session grant expired — mint a fresh one" };
  }
  const expected = createHmac("sha256", key)
    .update(`v1.${expRaw}.${payloadB64}`)
    .digest("base64url");
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { error: "session grant signature mismatch" };
  }
  let rooms: string[] = [];
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload && typeof payload === "object" && Array.isArray(payload.rooms)) {
      rooms = payload.rooms.filter(
        (r: unknown) => typeof r === "string" && ROOM_RE.test(r),
      );
    }
  } catch {
    return { error: "session grant payload unreadable" };
  }
  return { grant: { rooms: new Set(rooms) } };
}

/** Verify with rotation self-heal: a mismatch re-reads the secrets once. */
function verifyGrantWithRefresh(token: unknown): { grant?: VerifiedGrant; error?: string } {
  let result = verifyGrant(token, getSecrets().signingKey);
  if (result.error && !result.grant) {
    result = verifyGrant(token, refreshSecrets().signingKey);
  }
  return result;
}

// ── Q2 room grammar ─────────────────────────────────────────────────────────
const ROOM_RE = /^(all|agent:[A-Za-z0-9_-]{1,64}|workflow:[A-Za-z0-9_-]{1,64})$/;
const MAX_ROOMS_PER_SOCKET = 32;
/** Managed room set per socket id (the server joins the socket's own id as
 *  a room too — that one is NOT tracked here, only our grammar rooms are). */
const subscriptions = new Map<string, Set<string>>();
/** R1: the verified grant per socket id (the entitlement the connection's
 *  subscribes are clamped against). */
const grants = new Map<string, VerifiedGrant>();

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const presented = bearer || queryToken;
  if (!presented) return false;
  if (presented === getSecrets().emitToken) return true;
  // Rotation self-heal: the cached token may be stale (operator rewrote
  // .token / new env on boot) — re-read once before refusing.
  return presented === refreshSecrets().emitToken;
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
    // Honest grant census: how many live connections carry which
    // entitlement (room-set sizes, not the ids — no identity leak).
    const grantSizes = [...grants.values()].map((g) => g.rooms.size);
    const entitledAll = [...grants.values()].filter((g) => g.rooms.has("all")).length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "skill-events",
        port: PORT,
        clients: io.engine.clientsCount,
        rooms,
        auth: "connection grants (HMAC, R1) + bearer emit token (POST /emit)",
        grants: {
          connections: grants.size,
          entitledAll,
          roomSetSizes: grantSizes,
        },
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
io.use((socket, next) => {
  // R1: every connection presents a session grant. Unauthenticated (or
  // stale/garbage) handshakes are REFUSED — the Q2 "any browser can
  // connect and volunteer any rooms" hole is closed at the door.
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  const { grant, error } = verifyGrantWithRefresh(token);
  if (!grant) {
    next(new Error(error ?? "invalid session grant"));
    return;
  }
  // Stash the entitlement on the socket for the subscribe clamp.
  (socket as Socket & { grant?: VerifiedGrant }).grant = grant;
  next();
});

io.on("connection", (socket: Socket) => {
  const grant = (socket as Socket & { grant?: VerifiedGrant }).grant!;
  grants.set(socket.id, grant);
  // R1: the connection's DEFAULT room set is its entitlement itself —
  // the server enforces the mapping from the first byte, no volunteer
  // "all" join (Q2 back-compat only for grants that ARE the firehose).
  for (const room of grant.rooms) socket.join(room);
  subscriptions.set(socket.id, new Set(grant.rooms));
  console.log(
    `[skill-events] client connected (${socket.id}) — ` +
      `${io.engine.clientsCount} online, entitled to ` +
      `${[...grant.rooms].join(", ") || "(nothing)"}`,
  );

  // Q2: subscription management — all-or-nothing grammar validation,
  // replace semantics, ack so the client (and QA) can assert the landed
  // set. R1: the requested set is CLAMPED to the grant — rooms outside
  // the entitlement are filtered out and the ack discloses them.
  // An EMPTY rooms array is the explicit "clear" (leave everything) — a
  // closed chat drawer subscribes to nothing instead of the firehose.
  socket.on("subscribe", (payload: unknown, ack?: (reply: unknown) => void) => {
    const reply = applySubscription(socket, payload);
    if (typeof ack === "function") ack(reply);
    if (!reply.ok || (reply.filtered && reply.filtered.length > 0)) {
      console.warn(
        `[skill-events] subscribe from ${socket.id}: ` +
          (reply.ok
            ? `clamped (filtered: ${reply.filtered?.join(", ")})`
            : `rejected: ${reply.error}`),
      );
    }
  });

  socket.on("disconnect", (reason) => {
    subscriptions.delete(socket.id);
    grants.delete(socket.id);
    console.log(`[skill-events] client left (${socket.id}, ${reason})`);
  });
});

interface SubscribeReply {
  ok: boolean;
  rooms?: string[];
  requested?: number;
  filtered?: string[];
  error?: string;
}

/** Grant implication: a grant holding "all" (the firehose) permits every
 *  grammar room — narrowing from the firehose is always in-entitlement.
 *  A narrower grant permits exactly its own rooms. */
function roomAllowed(room: string, grant: VerifiedGrant): boolean {
  return grant.rooms.has("all") || grant.rooms.has(room);
}

function applySubscription(socket: Socket, payload: unknown): SubscribeReply {
  const grant = grants.get(socket.id) ?? (socket as Socket & { grant?: VerifiedGrant }).grant;
  if (!grant) {
    return { ok: false, error: "connection has no verified grant" };
  }
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
    return { ok: true, rooms: [], requested: 0, filtered: [] };
  }
  if (raw.length > MAX_ROOMS_PER_SOCKET) {
    return { ok: false, error: `at most ${MAX_ROOMS_PER_SOCKET} rooms per subscription` };
  }
  // Grammar validation stays all-or-nothing: one invalid room rejects the
  // whole payload, state unchanged (Q2 discipline, unchanged).
  const requested: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !ROOM_RE.test(r)) {
      return {
        ok: false,
        error:
          `invalid room ${JSON.stringify(r)} — use "all", "agent:<id>", ` +
          `or "workflow:<id>" (id charset: letters, digits, -, _)`,
      };
    }
    if (!requested.includes(r)) requested.push(r);
  }
  // R1 clamp: keep only in-entitlement rooms; the rest are FILTERED and
  // disclosed. Everything filtered → the connection lands on zero rooms
  // (asking for rooms you are not entitled to buys nothing, honestly).
  const rooms = requested.filter((r) => roomAllowed(r, grant));
  const filtered = requested.filter((r) => !rooms.includes(r));
  const previous = subscriptions.get(socket.id) ?? new Set<string>();
  for (const r of previous) {
    if (!rooms.includes(r)) socket.leave(r);
  }
  for (const r of rooms) socket.join(r);
  subscriptions.set(socket.id, new Set(rooms));
  return { ok: true, rooms, requested: raw.length, filtered };
}

httpServer.listen(PORT, () => {
  console.log(
    `[skill-events] listening on :${PORT} (identity grants + roomed push, POST /emit, GET /health)`,
  );
});
