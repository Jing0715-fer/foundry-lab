#!/usr/bin/env bun
// scripts/e2e/cluster-lane.ts — G-lane reproducible cluster-lane e2e channel
// (roadmap #21).
//
// Drives the FULL cluster execution lane against mini-services/mock-cluster
// (a REAL ssh2 SSH server executing REAL built-in numpy engines — no science
// is simulated) and asserts the four cluster-lane promises that previously
// had only QA-review backing:
//
//   P2  dispatch → real remote run → reconcile sweep → output sync-back →
//       node completed with ##OUTPUTS## (direct mode)
//   P3  node Stop mid-run → stopClusterJob single-point write (cancelled row
//       + "[stop] cancelled via node stop" stderr marker) + REMOTE kill +
//       sweep terminal guard (no resurrection)  [needs --ceiling]
//   P4  slurm mode (sbatch → squeue/sacct verdicts → sync-back)
//   P5  poll-ceiling handoff: a "running" node whose logs carry the
//       "[cluster run · job …]" marker settles via the SSE stream reconcile
//   P6  cleanup — the demo DB / connection registry / run records / mock
//       cluster filesystem return to their pre-test baseline
//
// Prerequisites (docs/CONTRIBUTING.md has the full runbook):
//   - dev server on :3000  (bun run dev)
//   - mock-cluster on :3022  (cd mini-services/mock-cluster && bun run dev)
//   - P3/P5b only: dev server restarted with
//       FOUNDRY_CLUSTER_POLL_CEILING_MS=<ms>  (e.g. 8000) in .env,
//       then run this script with  --ceiling <ms>
//
// Usage:
//   bun run e2e:cluster                       # P0-P2, P4, P5a, P6
//   bun run e2e:cluster --ceiling 8000        # + P3 stop path, P5b cancelled mapping
//   bun run e2e:cluster --keep                # skip P6 cleanup (debugging)
//   bun scripts/e2e/cluster-lane.ts --base http://localhost:3000 --ssh-port 3022
//
// Exit code 0 = every assertion passed and the baseline was restored.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as net from "node:net";
import { PrismaClient } from "@prisma/client";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, "../..");
const RUNS_FILE = join(REPO, "data", "cluster-runs.json");
const CONNS_FILE = join(REPO, "data", "cluster-connections.json");
// The mock cluster's $HOME is mini-services/mock-cluster/fs/home/foundry and
// remoteRoot "~/foundry-lab" maps onto $HOME/foundry-lab — so the "remote"
// workdirs are inspectable on THIS disk (that is the whole point of a local
// mock: file-level evidence for remote state).
const MOCK_FOUNDRY_LAB = join(
  REPO, "mini-services", "mock-cluster", "fs", "home", "foundry", "foundry-lab",
);
const OUTPUTS_DIR = join(REPO, "outputs");
const DB_URL = `file:${fileURLToPath(new URL("../../db/custom.db", import.meta.url))}`;

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const BASE = flag("base") ?? "http://localhost:3000";
const SSH_PORT = Number(flag("ssh-port") ?? 3022);
const CEILING_MS = (() => {
  const v = Number(flag("ceiling"));
  return flag("ceiling") !== null && Number.isFinite(v) && v > 0 ? v : null;
})();
const KEEP = argv.includes("--keep");

const WF_NAME = "G-Lane E2E Cluster Lane";
const CONN_DIRECT = "G-Lane E2E Cluster (direct)";
const CONN_SLURM = "G-Lane E2E Cluster (slurm)";

// ── Reporting ────────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, label: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function phase(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n■ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures.push(`${name} crashed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  ✗ ${name} crashed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function jfetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 60_000,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ac.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body && typeof body === "object" ? body : null };
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T | null>,
  tickMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v != null) return v;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(tickMs);
  }
}

// ── Test context (everything P6 must clean up) ───────────────────────────────
const ctx = {
  workflowId: null as string | null,
  connIds: [] as string[],
  jobIds: [] as string[],
  happyJobId: null as string | null, // P2's completed job (feeds P5a)
  stoppedJobId: null as string | null, // P3's cancelled job (feeds P5b)
  baseline: null as null | {
    workflows: number; nodes: number; toolJobs: number; connections: number;
  },
};

// ── Evidence readers ─────────────────────────────────────────────────────────
interface RunRecord {
  jobId: string; toolKey: string; phase: string; mode?: string;
  slurmId?: string | null; slurmState?: string | null;
  remoteWorkdir?: string; pid?: number | null;
  syncedFiles?: string[]; syncedBytes?: number;
}
function readRuns(): Record<string, RunRecord> {
  try {
    const parsed = JSON.parse(readFileSync(RUNS_FILE, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, RunRecord>)
      : {};
  } catch {
    return {};
  }
}
function readConnections(): { id: string; name: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(CONNS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
/** jobId from a node's logs — matches both marker variants (stop + stream). */
function jobIdFromLogs(logs: string | null | undefined): string | null {
  const m = (logs ?? "").match(/\[cluster run · job ([^\]\s]+)/);
  return m ? m[1] : null;
}
/** Is a pid dead on THIS machine (the mock executes locally, so /proc is the
 *  remote host's /proc)? Missing stat file or a Z (zombie) state count as
 *  dead. `expectStart` (QA 34-a suggestion 8): the .cf-pid starttime field —
 *  when provided, a REUSED pid carrying a different starttime also counts as
 *  dead, closing the theoretical 2.5s pid-recycle window. */
function pidDead(pid: number, expectStart?: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const state = /^[^)]+\)\s+(\w)/.exec(stat)?.[1] ?? "?";
    if (state === "Z") return true;
    if (expectStart != null && Number.isFinite(expectStart)) {
      const start = Number(/^[^)]+\)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/.exec(stat)?.[1]);
      if (Number.isFinite(start) && start !== expectStart) return true; // reused
    }
    return false;
  } catch {
    return true; // ENOENT — gone
  }
}

/** Map a recorded remote workdir onto the local mock-fs path. The mock's
 *  $HOME resolves to the ABSOLUTE repo path (fs/home/foundry), so recorded
 *  workdirs are usually already local; accept the ~-expanded "/home/foundry"
 *  form too (what a real cluster would record). */
function remoteWdToLocal(wd: string): string {
  if (wd.startsWith(MOCK_FOUNDRY_LAB)) return wd;
  const stripped = wd.replace(/^\/home\/foundry\/foundry-lab\/?/, "").replace(/^\//, "");
  return join(MOCK_FOUNDRY_LAB, stripped);
}

// ═════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(
    `G-lane cluster e2e — base ${BASE}, ssh-port ${SSH_PORT}` +
    (CEILING_MS ? `, ceiling ${CEILING_MS}ms` : " (no --ceiling: P3/P5b skipped)") +
    (KEEP ? ", --keep (cleanup skipped)" : ""),
  );

  await phase("P0 preflight", async () => {
    const health = await jfetch("/api", undefined, 8000);
    ok(health.status === 200 && health.body?.status === "ok", "dev server /api healthy");

    const tcp = await new Promise<boolean>((res) => {
      const s = net.connect({ host: "127.0.0.1", port: SSH_PORT }, () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 2500);
    });
    ok(tcp, `mock-cluster reachable on :${SSH_PORT}`,
      "start it: ( setsid bash -c 'cd mini-services/mock-cluster && exec bun run dev' >/dev/null 2>&1 </dev/null & )");
    if (!tcp) throw new Error("mock-cluster is not running — aborting");

    ctx.baseline = {
      workflows: await db.workflow.count(),
      nodes: await db.node.count(),
      toolJobs: await db.toolJob.count(),
      connections: readConnections().length,
    };

    // ── Self-heal (P2-7, QA 34-a): a CRASHED previous run (process kill,
    // timeout mid-phase) leaks its workflow/nodes/ToolJob rows/records/dirs —
    // the baseline-count assertions would catch the drift but a rerun could
    // never converge. Reference for "leaked": the FROZEN baseline DB (any
    // cluster-routed row whose id is not in demo-baseline.db is this
    // harness's own leftover — the project's demo hygiene guarantees nothing
    // else lives between runs). A --keep run's CONNECTIONS leak the same way:
    // delete the known names BEFORE the baseline snapshot so the final
    // comparison converges (P1 would delete them silently, leaving the
    // pre-snapshot count stale).
    for (const c of readConnections()) {
      if (c.name === CONN_DIRECT || c.name === CONN_SLURM) {
        await jfetch(`/api/cluster/connections/${c.id}`, { method: "DELETE" }).catch(() => {});
        console.log(`  self-heal: deleted stale connection ${c.name}`);
      }
    }
    const staleWorkflows = await db.workflow.findMany({
      where: { name: WF_NAME },
      select: { id: true },
    });
    if (staleWorkflows.length > 0) {
      for (const wf of staleWorkflows) {
        await jfetch(`/api/workflows/${wf.id}`, { method: "DELETE" }).catch(() => {});
      }
      console.log(`  self-heal: deleted ${staleWorkflows.length} stale ${WF_NAME} workflow(s)`);
    }
    const frozenIds = await (async () => {
      try {
        const baseDb = new PrismaClient({
          datasources: { db: { url: `file:${fileURLToPath(new URL("../../db/demo-baseline.db", import.meta.url))}` } },
        });
        const ids = new Set(
          (await baseDb.toolJob.findMany({ select: { id: true } })).map((r) => r.id),
        );
        await baseDb.$disconnect();
        return ids;
      } catch {
        return null; // baseline db unreadable — skip ToolJob healing honestly
      }
    })();
    if (frozenIds) {
      const clusterRows = await db.toolJob.findMany({
        where: { params: { contains: '\"executor\":\"cluster\"' } },
        select: { id: true },
      });
      const leaked = clusterRows.filter((r) => !frozenIds.has(r.id));
      if (leaked.length > 0) {
        await db.toolJob.deleteMany({ where: { id: { in: leaked.map((r) => r.id) } } });
        const runs = readRuns();
        let pruned = 0;
        for (const r of leaked) {
          const rec = runs[r.id];
          if (rec?.remoteWorkdir) {
            rmSync(remoteWdToLocal(rec.remoteWorkdir), { recursive: true, force: true });
            if (rec.toolKey) {
              rmSync(join(OUTPUTS_DIR, rec.toolKey, r.id), { recursive: true, force: true });
            }
          }
          if (r.id in runs) { delete runs[r.id]; pruned++; }
        }
        if (pruned > 0 && existsSync(RUNS_FILE)) {
          writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
        }
        console.log(
          `  self-heal: deleted ${leaked.length} leaked cluster ToolJob row(s), ` +
          `${pruned} run record(s)`,
        );
      }
    }
    // Re-snapshot AFTER healing so a rerun converges to the same baseline.
    ctx.baseline = {
      workflows: await db.workflow.count(),
      nodes: await db.node.count(),
      toolJobs: await db.toolJob.count(),
      connections: readConnections().length,
    };

    console.log(
      `  baseline: ${ctx.baseline.workflows} workflows · ${ctx.baseline.nodes} nodes · ` +
      `${ctx.baseline.toolJobs} toolJobs · ${ctx.baseline.connections} connections`,
    );
  });

  let directConnId: string | null = null;
  let slurmConnId: string | null = null;

  await phase("P1 cluster connection CRUD", async () => {
    // Idempotency: remove stale connections from a crashed previous run.
    for (const c of readConnections()) {
      if (c.name === CONN_DIRECT || c.name === CONN_SLURM) {
        await jfetch(`/api/cluster/connections/${c.id}`, { method: "DELETE" });
      }
    }

    const res = await jfetch("/api/cluster/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: CONN_DIRECT,
        host: "localhost",
        port: SSH_PORT,
        username: "foundry",
        password: "demo",
        authMethod: "password",
        remoteRoot: "~/foundry-lab",
        remoteToolsDir: "~/foundry-lab/tools",
      }),
    });
    ok(res.status === 201, "POST connection → 201", `got ${res.status}`);
    const dto = (res.body?.connection ?? {}) as Record<string, unknown>;
    directConnId = typeof dto.id === "string" ? dto.id : null;
    ok(directConnId !== null, "connection id returned");
    ok(!("password" in dto), "DTO strips the password secret");
    ok(dto.hasPassword === true, "DTO exposes hasPassword=true");
    if (directConnId) ctx.connIds.push(directConnId);

    const list = await jfetch("/api/cluster/connections");
    const conns = (list.body?.connections ?? []) as { id: string; name: string }[];
    ok(conns.some((c) => c.id === directConnId), "GET connections lists it");
  });

  // ── Shared node-run helpers ───────────────────────────────────────────────
  async function createClusterNode(
    name: string, tool: string, params: Record<string, unknown>,
    connId: string, mode: "direct" | "slurm", x: number, y: number,
  ): Promise<string> {
    const res = await jfetch("/api/workflow/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: ctx.workflowId,
        type: tool,
        name,
        x, y,
        params: { ...params, _cluster: { connectionId: connId, mode } },
      }),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`node create failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return String((res.body as { id?: string }).id ?? "");
  }
  async function getNode(id: string): Promise<Record<string, unknown>> {
    // There is no public single-node GET route (only PATCH/DELETE) — read the
    // node from the workflow GET, the same canonical snapshot the UI uses.
    const res = await jfetch(`/api/workflows/${ctx.workflowId}`);
    const nodes = ((res.body?.nodes ?? []) as Record<string, unknown>[]);
    return nodes.find((n) => n.id === id) ?? {};
  }
  async function getJob(id: string): Promise<Record<string, unknown>> {
    const res = await jfetch(`/api/tools/jobs/${id}`);
    return (res.body ?? {}) as Record<string, unknown>;
  }

  await phase("P2 happy path — direct mode (dispatch → real engine → sweep → sync-back)", async () => {
    const wf = await jfetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: WF_NAME }),
    });
    ok(wf.status === 200 || wf.status === 201, "test workflow created", `got ${wf.status}`);
    ctx.workflowId = String((wf.body as { id?: string })?.id ?? "");
    if (!ctx.workflowId) throw new Error("no workflow id");
    if (!directConnId) throw new Error("no direct connection (P1 failed)");

    const nodeId = await createClusterNode(
      "Cluster Happy Path", "rfdiffusion",
      { contigmap: "80", num_designs: 2 },
      directConnId, "direct", 120, 120,
    );

    // The run POST is synchronous (blocks through the 3s-poll loop until the
    // remote job settles) — give it a generous abort budget.
    const runRes = await jfetch(
      `/api/workflow/nodes/${nodeId}/run`, { method: "POST" }, 180_000,
    );
    ok(runRes.status === 200, "POST run → 200", `got ${runRes.status}`);

    const node = await getNode(nodeId);
    ok(node.status === "completed", "node completed", `status=${String(node.status)}`);
    const logs = String(node.logs ?? "");
    ok(logs.includes("[cluster run · job "), "node logs carry the cluster marker");
    ok(logs.includes("##OUTPUTS##"), "node logs carry the ##OUTPUTS## trailer");
    const jobId = jobIdFromLogs(logs);
    ok(jobId !== null, "cluster jobId extractable from logs");
    if (!jobId) throw new Error("no jobId — cannot continue");
    ctx.jobIds.push(jobId);
    ctx.happyJobId = jobId;

    const job = await getJob(jobId);
    ok(job.status === "completed", "ToolJob row completed", `status=${String(job.status)}`);
    ok(job.exitCode === 0, "ToolJob exitCode 0", `exitCode=${String(job.exitCode)}`);
    ok(String(job.stdout ?? "").startsWith("[cluster "), "ToolJob stdout carries the cluster banner");
    const files = (job.outputFiles ?? []) as string[];
    ok(files.length >= 1, "ToolJob outputFiles synced back", `${files.length} files`);
    ok(files.every((f) => f.startsWith(OUTPUTS_DIR)), "synced files land under local outputs/");

    const record = readRuns()[jobId];
    ok(record?.phase === "done", "run record phase=done", `phase=${record?.phase}`);
    ok((record?.syncedFiles ?? []).length >= 1, "run record syncedFiles non-empty");
    ok((record?.syncedBytes ?? 0) > 0, "run record syncedBytes > 0");

    // File-level evidence: the synced PDB exists locally with real ATOM records.
    const first = files[0];
    ok(existsSync(first), `synced file exists (${first.replace(REPO, "")})`);
    if (existsSync(first)) {
      const head = readFileSync(first, "utf-8").slice(0, 2000);
      ok(head.includes("ATOM"), "synced file has ATOM records (real engine output)");
    }

    // Remote-side evidence (mock fs = the remote host's disk): .cf-exit = 0.
    const wd = record?.remoteWorkdir ?? "";
    const localWd = remoteWdToLocal(wd);
    ok(
      wd.startsWith("/home/foundry/foundry-lab/jobs/") || wd.startsWith(MOCK_FOUNDRY_LAB),
      "remote workdir under remoteRoot",
    );
    ok(existsSync(join(localWd, ".cf-exit")), "remote .cf-exit written");
    if (existsSync(join(localWd, ".cf-exit"))) {
      ok(readFileSync(join(localWd, ".cf-exit"), "utf-8").trim() === "0", "remote .cf-exit = 0");
    }
    ok(existsSync(join(localWd, "run.out")), "remote run.out exists");
  });

  await phase("P3 node Stop → single-point cancel + remote kill + sweep terminal guard", async () => {
    if (!CEILING_MS) {
      console.log("  (skipped — pass --ceiling <ms> with the dev server env FOUNDRY_CLUSTER_POLL_CEILING_MS=<ms>)");
      return;
    }
    if (!directConnId || !ctx.workflowId) throw new Error("P1/P2 prerequisites missing");

    // Long remote job (300 aa × 40 designs ≈ 100 s) + short ceiling (env) →
    // the run lane gives up polling, the node stays "running" with the
    // marker, and the REMOTE job keeps burning — exactly the state a node
    // Stop must be able to cancel.
    const nodeId = await createClusterNode(
      "Cluster Stop Path", "rfdiffusion",
      { contigmap: "300", num_designs: 40 },
      directConnId, "direct", 420, 120,
    );
    void jfetch(`/api/workflow/nodes/${nodeId}/run`, { method: "POST" }, 300_000)
      .catch(() => { /* asserted via DB state below */ });

    const markerNode = await waitFor(
      "node running + poll-ceiling marker in logs",
      CEILING_MS + 90_000,
      async () => {
        const n = await getNode(nodeId);
        return n.status === "running" && jobIdFromLogs(String(n.logs ?? "")) ? n : null;
      },
    ).catch((e: Error) => {
      // P2-6 (QA 34-a): the overwhelmingly likely cause is a mismatch between
      // the server env and the --ceiling declaration — name it.
      throw new Error(
        `${e.message} — the dev server may lack ` +
        `FOUNDRY_CLUSTER_POLL_CEILING_MS=${CEILING_MS} (declared via --ceiling). ` +
        `Restart it per docs/CONTRIBUTING.md (cluster e2e runbook) and rerun.`,
      );
    });
    const logs = String(markerNode.logs ?? "");
    ok(logs.includes("poll ceiling reached"), "logs disclose the poll-ceiling handoff");
    const jobId = jobIdFromLogs(logs);
    ok(jobId !== null, "cluster jobId extractable from running node logs");
    if (!jobId) throw new Error("no jobId — cannot continue");
    ctx.jobIds.push(jobId);
    ctx.stoppedJobId = jobId;

    const beforeJob = await getJob(jobId);
    ok(beforeJob.status === "running", "ToolJob row running before stop");

    // Stop-vs-sweep stress (QA 34-a suggestion 6): poll the jobs list (each
    // GET drives a reconcile sweep) every 1s ACROSS the Stop — with the P1-1
    // conditional-write fix this must not clobber the cancelled verdict; an
    // unconditional ALIVE write would resurrect the row (the pre-fix race).
    let stopStress = 0;
    const stressLoop = (async () => {
      for (let i = 0; i < 9; i++) {
        await jfetch("/api/tools/jobs", undefined, 30_000).catch(() => {});
        stopStress++;
        await sleep(1000);
      }
    })();
    await sleep(3000); // get at least one sweep in flight before the stop

    const stopRes = await jfetch(`/api/workflow/nodes/${nodeId}/stop`, { method: "POST" });
    ok(stopRes.status === 200, "POST stop → 200", `got ${stopRes.status}`);
    await stressLoop;
    ok(stopStress >= 5, `sweep-stress ran alongside the stop (${stopStress} polls)`);

    const node = await getNode(nodeId);
    ok(node.status === "failed", "node failed after stop", `status=${String(node.status)}`);
    const nlogs = String(node.logs ?? "");
    ok(nlogs.includes("[stop] Stopped by user"), "node logs carry the stop note");
    ok(
      nlogs.includes(`[stop] cluster job ${jobId} cancelled on the remote host`),
      "node logs disclose the remote cancellation",
    );

    const job = await getJob(jobId);
    ok(job.status === "cancelled", "ToolJob row cancelled (single-point write)", `status=${String(job.status)}`);
    ok(
      String(job.stderr ?? "").includes("[stop] cancelled via node stop"),
      "ToolJob stderr carries the via-node-stop marker (two-way badge)",
    );

    const record = readRuns()[jobId];
    ok(record?.phase === "cancelled", "run record phase=cancelled", `phase=${record?.phase}`);

    // Remote kill: the session leader from .cf-pid must be dead on the mock
    // host (same /proc — the mock executes locally).
    const localWd = remoteWdToLocal(record?.remoteWorkdir ?? "");
    const pidFile = join(localWd, ".cf-pid");
    if (existsSync(pidFile)) {
      const pidLine = readFileSync(pidFile, "utf-8").trim().split(/\s+/);
      const pid = parseInt(pidLine[0] ?? "", 10);
      const pidStart = parseInt(pidLine[1] ?? "", 10);
      ok(Number.isFinite(pid) && pid > 0, "remote .cf-pid readable", `pid=${pid}`);
      // TERM then KILL escalation is done in-band by stopClusterJob; give the
      // KILL a moment to land before judging liveness.
      await sleep(2500);
      ok(
        pidDead(pid, Number.isFinite(pidStart) ? pidStart : undefined),
        "remote process is dead after cancellation (starttime-checked)",
      );
    } else {
      ok(false, "remote .cf-pid readable", `${pidFile} missing`);
    }

    // Sweep terminal guard (P2-1, QA 30-a): stale sweep blocks must NEVER flip
    // the cancelled row/record back. Drive two sweeps and re-assert.
    await jfetch("/api/tools/jobs", undefined, 30_000).catch(() => {});
    await sleep(3000);
    await jfetch("/api/tools/jobs", undefined, 30_000).catch(() => {});
    await sleep(2000);
    const job2 = await getJob(jobId);
    ok(job2.status === "cancelled", "sweep did NOT resurrect the ToolJob row", `status=${String(job2.status)}`);
    ok(String(job2.stderr ?? "").includes("[stop] cancelled via node stop"),
      "via-node-stop marker survived the sweeps");
    ok(readRuns()[jobId]?.phase === "cancelled", "sweep did NOT resurrect the run record");
    const node2 = await getNode(nodeId);
    ok(node2.status === "failed", "sweep did NOT resurrect the node");
  });

  await phase("P4 happy path — slurm mode (sbatch → squeue/sacct → sync-back)", async () => {
    if (!ctx.workflowId) throw new Error("P2 prerequisites missing");
    // Separate connection with useSlurm for the slurm lane.
    const res = await jfetch("/api/cluster/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: CONN_SLURM,
        host: "localhost",
        port: SSH_PORT,
        username: "foundry",
        password: "demo",
        authMethod: "password",
        remoteRoot: "~/foundry-lab",
        remoteToolsDir: "~/foundry-lab/tools",
        useSlurm: true,
        slurmPartition: "brain2",
      }),
    });
    slurmConnId = typeof (res.body?.connection as { id?: string })?.id === "string"
      ? (res.body!.connection as { id: string }).id
      : null;
    ok(slurmConnId !== null, "slurm connection created");
    if (slurmConnId) ctx.connIds.push(slurmConnId);
    if (!slurmConnId) throw new Error("no slurm connection");

    const nodeId = await createClusterNode(
      "Cluster Slurm Path", "rfdiffusion",
      { contigmap: "80", num_designs: 2 },
      slurmConnId, "slurm", 720, 120,
    );

    const runRes = await jfetch(
      `/api/workflow/nodes/${nodeId}/run`, { method: "POST" }, 180_000,
    );
    ok(runRes.status === 200, "POST run → 200", `got ${runRes.status}`);

    const node = await getNode(nodeId);
    ok(node.status === "completed", "node completed (slurm)", `status=${String(node.status)}`);
    const logs = String(node.logs ?? "");
    const jobId = jobIdFromLogs(logs);
    ok(jobId !== null, "cluster jobId extractable");
    if (!jobId) throw new Error("no jobId — cannot continue");
    ctx.jobIds.push(jobId);

    const record = readRuns()[jobId];
    ok(record?.mode === "slurm", "run record mode=slurm");
    ok(record?.slurmId != null && String(record.slurmId).length > 0, "sbatch id captured");
    // G-lane e2e finding (Task 33-b): the sacct separator bug used to leave
    // slurmState as the whole "COMPLETED|0:0|…" line; assert the parsed state.
    ok(record?.slurmState === "COMPLETED", "sacct state parsed to COMPLETED",
      `slurmState=${record?.slurmState}`);

    const job = await getJob(jobId);
    ok(job.status === "completed", "ToolJob completed (slurm)");
    ok(String(job.stdout ?? "").includes(`· Slurm ${record?.slurmId}`), "stdout banner carries the Slurm id");
    const files = (job.outputFiles ?? []) as string[];
    ok(files.length >= 1 && existsSync(files[0]), "outputs synced back to local disk");
  });

  await phase("P5 poll-ceiling handoff — SSE stream reconcile settles the node", async () => {
    if (!ctx.workflowId || !ctx.happyJobId) throw new Error("P2 prerequisites missing");

    // Build the exact state the run lane leaves behind at a poll ceiling: a
    // "running" node whose logs point at the ToolJob (PATCH allows status +
    // logs — the same route the restore lane uses).
    const mkWaitingNode = async (name: string, jobId: string): Promise<string> => {
      const res = await jfetch("/api/workflow/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: ctx.workflowId,
          type: "output",
          name,
          x: 120, y: 420,
          params: { text: "waiting on a remote cluster job" },
        }),
      });
      const id = String((res.body as { id?: string })?.id ?? "");
      if (!id) throw new Error(`node create failed: ${JSON.stringify(res.body)}`);
      const patch = await jfetch(`/api/workflow/nodes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "running",
          progress: 90,
          result: "Cluster run still in progress after the poll ceiling.",
          logs: `[cluster run · job ${jobId} — poll ceiling reached, remote job still running]`,
        }),
      });
      if (patch.status !== 200) throw new Error(`node patch failed: ${patch.status}`);
      return id;
    };
    const readStreamUntilTerminal = async (
      nodeId: string, timeoutMs: number,
    ): Promise<{ lastStatus: string | null; doneStatus: string | null; logs: string }> => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE}/api/workflow/nodes/${nodeId}/stream`, { signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let lastStatus: string | null = null;
        let doneStatus: string | null = null;
        let lastLogs = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const raw = /^data: (.*)$/m.exec(chunk)?.[1];
            if (!ev || raw == null) continue;
            const data = JSON.parse(raw) as Record<string, unknown>;
            if (ev === "status") {
              lastStatus = String(data.status ?? "");
              lastLogs = String(data.logs ?? "");
            } else if (ev === "done") {
              doneStatus = String(data.status ?? "");
              ac.abort();
              return { lastStatus, doneStatus, logs: lastLogs };
            } else if (ev === "error") {
              throw new Error(`stream error event: ${raw}`);
            }
          }
        }
        return { lastStatus, doneStatus, logs: lastLogs };
      } finally {
        clearTimeout(timer);
      }
    };

    // (a) completed job → node settles completed with the reconcile trailer.
    const nodeA = await mkWaitingNode("Ceiling Handoff (completed)", ctx.happyJobId);
    const a = await readStreamUntilTerminal(nodeA, 30_000);
    ok(a.doneStatus === "completed", "stream emitted done: completed", `done=${a.doneStatus}`);
    ok(a.logs.includes(`[cluster reconcile] job ${ctx.happyJobId} completed`),
      "stream status events carry the reconcile line");
    ok(a.logs.includes("##OUTPUTS##"), "reconciled logs carry the ##OUTPUTS## trailer");
    const nodeARow = await getNode(nodeA);
    ok(nodeARow.status === "completed" && nodeARow.progress === 100,
      "DB node settled completed/100 by the stream reconcile");

    // (b) cancelled job → node settles failed (cancelled jobs map onto node
    // "failed" with an honest result line — they are NOT successes).
    if (ctx.stoppedJobId) {
      const nodeB = await mkWaitingNode("Ceiling Handoff (cancelled)", ctx.stoppedJobId);
      const b = await readStreamUntilTerminal(nodeB, 30_000);
      ok(b.doneStatus === "failed", "stream emitted done: failed", `done=${b.doneStatus}`);
      ok(b.logs.includes(`[cluster reconcile] job ${ctx.stoppedJobId} cancelled`),
        "reconcile line discloses the cancelled job");
      const nodeBRow = await getNode(nodeB);
      ok(nodeBRow.status === "failed", "DB node settled failed for a cancelled job");
    } else {
      console.log(
        CEILING_MS
          ? "  (b skipped — P3 was declared via --ceiling but produced no cancelled job (it failed?)"
          : "  (b skipped — no --ceiling: P3 did not run)",
      );
    }

    // (c) co-driver TRUE POSITIVE (QA 34-a suggestion 1 — the only assertion
    // that pins the stream route's sweep co-driver): a node whose remote job
    // is STILL running settles purely through the STREAM's own 3s sweeps —
    // no jobs-list/cluster-panel poller attached. (P5a would pass even with
    // the co-driver deleted: its job was already terminal.)
    if (CEILING_MS && directConnId) {
      const nodeC = await createClusterNode(
        "Ceiling Handoff (co-driver)", "rfdiffusion",
        { contigmap: "300", num_designs: 12 }, // ~30 s remote — outlives the ceiling
        directConnId, "direct", 1020, 120,
      );
      void jfetch(`/api/workflow/nodes/${nodeC}/run`, { method: "POST" }, 300_000)
        .catch(() => { /* the stream is the assertion */ });
      // Wait for the ceiling handoff (marker in logs, job still running).
      await waitFor(
        "co-driver node at the poll ceiling",
        CEILING_MS + 90_000,
        async () => {
          const n = await getNode(nodeC);
          return n.status === "running" && jobIdFromLogs(String(n.logs ?? "")) ? n : null;
        },
      );
      const cJobId = jobIdFromLogs(String((await getNode(nodeC)).logs ?? ""));
      ok(cJobId !== null, "co-driver job dispatched (still running remotely)");
      if (cJobId) {
        ctx.jobIds.push(cJobId);
        const rowBefore = await getJob(cJobId);
        ok(rowBefore.status === "running", "remote job still running at the handoff");
        // NO /api/tools/jobs calls from here on — the stream is the ONLY
        // sweep driver. (getNode reads the workflow, which never sweeps.)
        const c = await readStreamUntilTerminal(nodeC, 150_000);
        ok(c.doneStatus === "completed", "stream-only settlement → done: completed",
          `done=${c.doneStatus}`);
        ok(c.logs.includes(`[cluster reconcile] job ${cJobId} completed`),
          "co-driver sweeps advanced the row + the stream reconciled it");
        const nodeCRow = await getNode(nodeC);
        ok(nodeCRow.status === "completed",
          "DB node completed without any jobs-list poller attached");
        ok(readRuns()[cJobId]?.phase === "done", "run record reached done via stream sweeps");
      }
    } else {
      console.log("  (c skipped — needs --ceiling (the handoff state) to be observable)");
    }
  });

  await phase("P6 cleanup + baseline restoration", async () => {
    if (KEEP) {
      console.log("  (--keep — skipping cleanup)");
      return;
    }
    // Workflow delete cascades nodes + edges.
    if (ctx.workflowId) {
      const res = await jfetch(`/api/workflows/${ctx.workflowId}`, { method: "DELETE" });
      ok(res.status === 200 || res.status === 204, "test workflow deleted", `status=${res.status}`);
    }
    // ToolJob rows (no public DELETE API — direct Prisma, the same client
    // the app uses; the deleted set is exactly this run's own jobs).
    if (ctx.jobIds.length > 0) {
      const del = await db.toolJob.deleteMany({ where: { id: { in: ctx.jobIds } } });
      ok(del.count === ctx.jobIds.length, "test ToolJob rows deleted", `${del.count}/${ctx.jobIds.length}`);
    }
    // Connections via their API.
    for (const id of ctx.connIds) {
      const res = await jfetch(`/api/cluster/connections/${id}`, { method: "DELETE" });
      ok(res.status === 200 || res.status === 204, `connection ${id.slice(-6)} deleted`);
    }
    // Run records: rewrite data/cluster-runs.json without the test jobs
    // (the mtime change invalidates the server's cache — it reloads).
    if (ctx.jobIds.length > 0 && existsSync(RUNS_FILE)) {
      // P2-8 (QA 34-a): per-jobId dir cleanup BEFORE pruning the records (the
      // remoteWorkdir/toolKey needed for the paths live in them).
      const runs = readRuns();
      for (const id of ctx.jobIds) {
        const rec = runs[id];
        if (rec?.remoteWorkdir) {
          rmSync(remoteWdToLocal(rec.remoteWorkdir), { recursive: true, force: true });
        }
        if (rec?.toolKey) {
          rmSync(join(OUTPUTS_DIR, rec.toolKey, id), { recursive: true, force: true });
        }
      }
      for (const id of ctx.jobIds) delete runs[id];
      writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
      ok(true, "run records + per-job output dirs pruned");
    }
    // Belt-and-braces: sweep any RECORD-LESS stray job dirs left by a crash
    // between phases (tracked + leaked-record dirs were already removed above
    // and by the P0 self-heal; the frozen demo baseline keeps no cluster
    // outputs, so an empty-per-tool tree here is this harness's own residue).
    rmSync(join(MOCK_FOUNDRY_LAB, "jobs", "rfdiffusion"), { recursive: true, force: true });
    rmSync(join(OUTPUTS_DIR, "rfdiffusion"), { recursive: true, force: true });
    ok(true, "mock-cluster job dirs + local outputs/ cleaned");

    // Final baseline comparison — the demo DB must be restored exactly.
    const after = {
      workflows: await db.workflow.count(),
      nodes: await db.node.count(),
      toolJobs: await db.toolJob.count(),
      connections: readConnections().length,
    };
    const b = ctx.baseline!;
    ok(after.workflows === b.workflows, `workflow count restored (${after.workflows}/${b.workflows})`);
    ok(after.nodes === b.nodes, `node count restored (${after.nodes}/${b.nodes})`);
    ok(after.toolJobs === b.toolJobs, `toolJob count restored (${after.toolJobs}/${b.toolJobs})`);
    ok(after.connections === b.connections, `connection count restored (${after.connections}/${b.connections})`);
  });

  await db.$disconnect();

  console.log(
    `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failures.length} failed`,
  );
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
