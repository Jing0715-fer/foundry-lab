// POST /api/workflow/nodes/[id]/stop — user-initiated stop of a node (E4+K).
//
// The REAL stop (K lane, ported from the parallel S/E line):
//   1. register the stop — the in-flight executeNodeGuarded lands the node
//      in `cancelled` when its execution returns (a late result can never
//      overwrite the user's stop);
//   2. SIGTERM the node's local engine process (real-executor ACTIVE_PROCS
//      registry, keyed by node id) — the work actually halts;
//   3. cancel the node's linked cluster/local ToolJob(s) (scancel / remote
//      process-group kill / local SIGTERM, discovered via the
//      `triggeredBy: "node:<id>"` tag or the legacy node-log marker);
//   4. flip the row to `cancelled` immediately so the UI reacts at once.
//
// A queued (pending, not yet claimed) node simply flips to cancelled — the
// runner's atomic claim only matches pending/idle, so it skips the node and
// downstream unlocks with the normal failure-doesn't-prune semantics.
// Terminal nodes → 409 (nothing to stop).
//
// This is the node-level half of "看得见也管得住" (the Runs sheet fires it per
// active row and for Stop-all).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toNodeDTO } from "@/lib/workflow-engine";
import { stopNodeRun } from "@/lib/node-run-control";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const node = await db.node.findUnique({ where: { id } });
    if (!node) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }
    if (node.status !== "running" && node.status !== "pending") {
      return NextResponse.json(
        {
          error: `Node is ${node.status} — only running or queued nodes can be stopped.`,
        },
        { status: 409 },
      );
    }

    const res = await stopNodeRun(id, node.logs ?? "");

    // The row is already flipped (cancelled) — return the fresh node DTO
    // (same shape the route always returned) plus the stop detail line. A
    // row that did NOT land in cancelled lost a race to a natural settle
    // (completed/failed between the guard read and the flip): 409, same as
    // the pre-K route — the settle owns the verdict, not the stop.
    const final = await db.node.findUnique({ where: { id } });
    if (final && final.status !== "cancelled") {
      return NextResponse.json(
        {
          error: "Node already settled while stopping — refresh the queue.",
          detail: res.detail,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      final
        ? { ...toNodeDTO(final), detail: res.detail }
        : { error: "Node disappeared after stop", detail: res.detail },
      { status: final ? 200 : 500 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
