// POST /api/workflow/nodes/[id]/stop — E4: stop a running (or queued) node
// for real:
//   1. register the stop — the in-flight executeNodeGuarded lands the node
//      in `cancelled` when its execution returns (a late result can never
//      overwrite the user's stop);
//   2. SIGTERM the node's local engine process (real-executor registry,
//      keyed by node id);
//   3. cancel the node's cluster job(s) (scancel / remote process-group
//      kill, via the ToolJob rows tagged triggeredBy "node:<id>");
//   4. flip the row to `cancelled` immediately so the UI reacts at once.
//
// A queued (pending, not yet claimed) node simply flips to cancelled — the
// runner's atomic claim then skips it (count 0) and downstream unlocks.
// Terminal nodes → 409 (nothing to stop).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stopNodeRun } from "@/lib/node-run-control";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const node = await db.node.findUnique({
      where: { id },
      select: { id: true, status: true, name: true },
    });
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

    const res = await stopNodeRun(id);

    const detail =
      res.killedProcess && res.cluster === "cancelled"
        ? "local engine process killed + cluster job cancelled"
        : res.killedProcess
          ? "local engine process killed"
          : res.cluster === "cancelled"
            ? "cluster job cancelled"
            : res.cluster === "error"
              ? `cluster cancel failed${res.warning ? `: ${res.warning}` : ""} — the node row is cancelled; the remote job may finish on its own`
              : "stop registered — the node will land in cancelled when its execution returns";

    return NextResponse.json({ ok: true, detail });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to stop node", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
