#!/usr/bin/env bun
// File-shim client for the mock cluster's scheduler tools (Task 33-b, G-lane
// e2e channel).
//
// The mini-SLURM state machine lives INSIDE the SSH server process, so
// PATH-level invocations (the app's reconcile sweep embeds `$(squeue …)` /
// `$(sacct …)` inside command substitutions — real bash resolves those, not
// the exec-layer interceptor) forward to the server's loopback endpoint
// (127.0.0.1:3023/sched) and replay its stdout/stderr/exit code verbatim.
// See mini-services/mock-cluster/index.ts ("Loopback scheduler endpoint").
//
// Usage: bun sched-client.ts <tool> [argv...]

// Module marker (P1-2, QA 34-a): the repo-wide tsc gate reads this file; a
// top-level await in a non-module trips TS1375. Under Bun it runs either way.
export {};

const tool = process.argv[2];
const argv = process.argv.slice(3);
if (!tool) {
  console.error("sched-client: missing tool argument");
  process.exit(64);
}

try {
  const q = (s: string): string => encodeURIComponent(s);
  const url =
    `http://127.0.0.1:3023/sched?tool=${q(tool)}` +
    `&argv=${q(JSON.stringify(argv))}&cwd=${q(process.cwd())}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`sched-client: loopback HTTP ${res.status}`);
    process.exit(126);
  }
  const { out, err, code } = (await res.json()) as {
    out: string; err: string; code: number;
  };
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code ?? 0);
} catch (e) {
  console.error(`sched-client: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(126);
}
