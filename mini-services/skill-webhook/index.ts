// mini-services/skill-webhook — deterministic webhook target for custom
// skills (M3 QA + e2e).
// The main app's custom-skill handler POSTs {skillId, params, source,
// agent?, at} to whatever endpoint a registration names. Pointing tests at
// a real external echo service would make them hostage to upstream
// availability (#51) — this local service gives the same REAL HTTP path
// (real socket, real JSON, real status codes) deterministically.
//
//   POST /echo           → 200 { ok, received: <body>, at }            (happy path)
//   POST /echo?delay=ms  → same, after a deliberate delay              (latency shaping)
//   POST /fail           → 500 { error: "boom" }                       (error path)
//   POST /slow           → sleeps 25s then echoes                      (timeout path: the
//                                                                          skill handler aborts at 20s)
//   GET  /health         → 200 { ok: true }                            (daemon liveness)
//
// Port is FIXED at 3030 (sandbox rule: no PORT env for mini services).

// Ambient Bun global (same pattern as mini-services/mock-cluster): this
// service always RUNS under Bun, but the repo-wide `tsc --noEmit` gate
// also reads this file; without the declaration the Bun.serve / Bun.sleep
// calls trip TS2867.
declare const Bun: {
  serve: (options: {
    port?: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }) => { stop: (force?: boolean) => void };
  sleep: (ms: number) => Promise<void>;
};

const PORT = 3030;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "skill-webhook", port: PORT });
    }

    if (req.method === "POST") {
      const text = await req.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text.slice(0, 500) };
      }

      if (url.pathname === "/fail") {
        return Response.json(
          { error: "boom — deliberate webhook failure for the error-path test" },
          { status: 500 },
        );
      }

      if (url.pathname === "/slow") {
        // 25s: longer than the skill handler's 20s timeout — the caller
        // must abort while this endpoint keeps holding the socket open
        // (then Bun cleans it up when the socket drops).
        await Bun.sleep(25_000);
        return Response.json({ ok: true, note: "finally responded", received: body });
      }

      if (url.pathname === "/echo") {
        const delay = Math.min(10_000, Math.max(0, Number(url.searchParams.get("delay")) || 0));
        if (delay > 0) await Bun.sleep(delay);
        return Response.json({
          ok: true,
          received: body,
          at: new Date().toISOString(),
        });
      }
    }

    return Response.json(
      { error: `no such route: ${req.method} ${url.pathname}` },
      { status: 404 },
    );
  },
});

console.log(`[skill-webhook] listening on :${PORT} (echo / echo?delay= / fail / slow / health)`);

// SIGTERM = graceful stop (the daemonizer sends it on reaps).
process.on("SIGTERM", () => {
  console.log("[skill-webhook] received SIGTERM — shutting down");
  server.stop(true);
  process.exit(0);
});
