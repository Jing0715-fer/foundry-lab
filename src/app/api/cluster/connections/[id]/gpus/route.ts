// GPU availability route — the tutorial's "check which GPU cards are free
// before running" step: nvidia-smi ON THE COMPUTE NODE (ssh <node>) rather
// than the login node. GET /api/cluster/connections/[id]/gpus?node=gpu05
//
// Returns rows: [{ index, name, memUsedMiB, memTotalMiB, utilPct }] sorted by
// index, plus the node actually queried. The AlphaFold panel uses this to
// suggest a free CUDA_VISIBLE_DEVICES card.

import { NextResponse } from "next/server";
import { getConnection } from "@/lib/cluster/connections";
import { exec } from "@/lib/cluster/ssh";

interface GpuRow {
  index: number;
  name: string;
  memUsedMiB: number;
  memTotalMiB: number;
  utilPct: number;
}

/** "  32512" / "95 %" CSV cells → int. */
function parseMiB(cell: string): number {
  const n = parseInt(cell.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conn = getConnection(id);
  if (!conn) {
    return NextResponse.json({ error: `Connection not found: ${id}` }, { status: 404 });
  }

  const url = new URL(request.url);
  const node = (url.searchParams.get("node") ?? conn.af2?.node ?? "gpu05").trim();
  if (!/^[\w.-]+$/.test(node)) {
    return NextResponse.json({ error: "Invalid node name" }, { status: 400 });
  }

  // ssh to the compute node and query the cards there (the tutorial's flow:
  // the cards that matter are the ones on gpu05, not on mgt).
  const query =
    `ssh ${node} "nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu ` +
    `--format=csv,noheader" 2>/dev/null`;
  const res = await exec(conn, query, { timeoutMs: 25_000 });

  const rows: GpuRow[] = [];
  if (!res.error) {
    for (const line of res.stdout.split("\n")) {
      const cells = line.split(",").map((c) => c.trim());
      if (cells.length < 5) continue;
      const index = parseInt(cells[0], 10);
      if (!Number.isFinite(index)) continue;
      rows.push({
        index,
        name: cells[1] || "GPU",
        memUsedMiB: parseMiB(cells[2]),
        memTotalMiB: parseMiB(cells[3]),
        utilPct: parseMiB(cells[4]),
      });
    }
  }
  rows.sort((a, b) => a.index - b.index);

  if (rows.length === 0) {
    return NextResponse.json(
      {
        node,
        gpus: [],
        error:
          res.error ??
          "nvidia-smi returned no cards on the node — is the GPU node reachable (ssh) and are drivers loaded?",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ node, gpus: rows });
}
