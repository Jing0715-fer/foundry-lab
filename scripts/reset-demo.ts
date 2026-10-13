#!/usr/bin/env bun
// scripts/reset-demo.ts — demo data governance (C1).
//
//   bun run demo:snapshot  → freeze the CURRENT db/custom.db as the demo
//                             baseline (db/demo-baseline.db). Take the snapshot
//                             with the demo workflows/campaigns in their
//                             intended showcase state.
//   bun run demo:reset     → restore the baseline over db/custom.db
//                             (destructive to everything created since the
//                             snapshot). Pass --force to skip the prompt.
//
// The runs/ output directories referenced by demo screening campaigns live on
// disk and are NOT touched — a reset restores only the database rows.
//
// IMPORTANT (stale-client ops note, README "Development notes"):
//   - Best practice: run while the dev server is STOPPED.
//   - After a reset, RESTART the dev server — the running server holds an
//     open SQLite connection and a Prisma client bound to the previous file
//     generation.

import { copyFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const LIVE = fileURLToPath(new URL("../db/custom.db", import.meta.url));
const BASELINE = fileURLToPath(new URL("../db/demo-baseline.db", import.meta.url));

const mode = process.argv[2];

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--force")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

switch (mode) {
  case "snapshot": {
    if (!existsSync(LIVE)) {
      console.error("No db/custom.db found — start the dev server once first.");
      process.exit(1);
    }
    copyFileSync(LIVE, BASELINE);
    console.log(`OK: demo baseline frozen -> ${BASELINE}`);
    console.log("    Run `bun run demo:reset` at any time to restore this exact state.");
    break;
  }
  case "reset": {
    if (!existsSync(BASELINE)) {
      console.error("No demo baseline found — run `bun run demo:snapshot` first.");
      process.exit(1);
    }
    const ok = await confirm(
      "Reset db/custom.db to the demo baseline? Everything created since the snapshot is lost. [y/N]",
    );
    if (!ok) {
      console.log("Aborted — nothing changed.");
      break;
    }
    copyFileSync(BASELINE, LIVE);
    console.log("OK: demo database restored from the baseline.");
    console.log("WARN: restart the dev server (bun run dev) — the running server");
    console.log("      holds a stale Prisma client / open SQLite connection.");
    break;
  }
  default: {
    console.log("Usage: bun run demo:snapshot | bun run demo:reset [--force]");
    process.exit(mode ? 1 : 0);
  }
}
