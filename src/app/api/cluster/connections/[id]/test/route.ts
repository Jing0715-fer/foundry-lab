// POST /api/cluster/connections/[id]/test — probe a cluster connection.
//
// Runs the full environment probe over SSH (login-shell identity, python3 +
// numpy, conda, module system, Slurm partitions, GPUs, external-tool
// availability) and persists the result as the connection's lastProbe so the
// panels (Cluster + AlphaFold) can render it and pre-select partitions.
//
// Response: { probe: ClusterProbeDTO } — probe.ok=false carries probe.error.

import { NextResponse } from "next/server";
import { getConnection, persistProbe } from "@/lib/cluster/connections";
import { probeCluster } from "@/lib/cluster/probe";
import type { ClusterProbeDTO } from "@/lib/cluster/types";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conn = getConnection(id);
  if (!conn) {
    return NextResponse.json(
      { error: `Connection not found: ${id}` },
      { status: 404 },
    );
  }

  try {
    const probe = await probeCluster(conn);
    // Persist so connection lists/panels keep the freshest probe (partitions
    // feed the salloc pre-select; tool rows feed the AF2 "module available"
    // hints).
    persistProbe(id, probe);
    return NextResponse.json({ probe: probe as ClusterProbeDTO });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The probe itself degrades per-stage and never throws; a throw here means
    // something structural (pool explosion, serialization) — still return a
    // shaped probe so the client can render the failure honestly.
    const probe: ClusterProbeDTO = {
      ok: false,
      testedAt: new Date().toISOString(),
      durationMs: 0,
      error: `Probe crashed: ${msg}`,
      uname: "",
      hostname: conn.host,
      user: conn.username,
      homeDir: "",
      dateEpoch: 0,
      python3: null,
      conda: null,
      moduleSystem: "none",
      tools: [],
      slurm: { available: false, partitions: [] },
      gpus: [],
    };
    persistProbe(id, probe);
    return NextResponse.json({ probe });
  }
}
