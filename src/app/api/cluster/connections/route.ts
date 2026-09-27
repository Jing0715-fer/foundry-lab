// Cluster connections API — list + upsert (create or edit).
//
// Secrets (password / passphrase) never leave the server: DTOs expose
// hasPassword / hasPassphrase booleans only. Editing a connection drops its
// pooled SSH client so the next exec reconnects with fresh credentials.

import { NextResponse } from "next/server";
import {
  listConnectionDTOs,
  upsertConnection,
  getConnection,
} from "@/lib/cluster/connections";
import { dropConnection } from "@/lib/cluster/ssh";
import { toClusterConnectionDTO, type ClusterConnection } from "@/lib/cluster/types";

/** Parse + validate an upsert body. Absent fields = "keep current value";
 *  secret fields sent as "" = clear. */
export function parseConnectionBody(
  body: Record<string, unknown>,
): { input: (Partial<ClusterConnection> & { name: string }) | null; error?: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!name || !host || !username) {
    return { input: null, error: "name, host and username are required" };
  }

  const input: Partial<ClusterConnection> & { name: string } = { name, host, username };
  if (typeof body.id === "string" && body.id) input.id = body.id;

  const port = Number(body.port);
  if (Number.isFinite(port) && port > 0 && port < 65536) input.port = Math.floor(port);

  const authMethod = typeof body.authMethod === "string" ? body.authMethod : "";
  if (authMethod === "password" || authMethod === "key" || authMethod === "agent") {
    input.authMethod = authMethod;
  }

  if (typeof body.privateKeyPath === "string") {
    input.privateKeyPath = body.privateKeyPath.trim() || null;
  }
  if (typeof body.passphrase === "string") input.passphrase = body.passphrase; // "" clears
  if (typeof body.password === "string") input.password = body.password; // "" clears

  if (typeof body.remoteRoot === "string" && body.remoteRoot.trim()) {
    input.remoteRoot = body.remoteRoot.trim();
  }
  if (typeof body.remoteToolsDir === "string" && body.remoteToolsDir.trim()) {
    input.remoteToolsDir = body.remoteToolsDir.trim();
  }
  if (Array.isArray(body.envLines)) {
    input.envLines = body.envLines.map((l) => String(l).trim()).filter((l) => l.length > 0);
  } else if (typeof body.envLines === "string") {
    input.envLines = body.envLines.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }

  if (typeof body.useSlurm === "boolean") input.useSlurm = body.useSlurm;
  if (typeof body.slurmPartition === "string") {
    input.slurmPartition = body.slurmPartition.trim() || null;
  } else if (body.slurmPartition === null) {
    input.slurmPartition = null;
  }
  if (body.slurmTimeMin === null) {
    input.slurmTimeMin = null;
  } else {
    const timeMin = Number(body.slurmTimeMin);
    if (Number.isFinite(timeMin) && timeMin > 0) input.slurmTimeMin = Math.floor(timeMin);
  }

  return { input };
}

export async function GET() {
  return NextResponse.json({ connections: listConnectionDTOs() });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { input, error } = parseConnectionBody(body);
  if (!input) {
    return NextResponse.json({ error: error ?? "Invalid connection body" }, { status: 400 });
  }

  // Editing via POST (id present) — drop the pooled client first.
  if (input.id && getConnection(input.id)) dropConnection(input.id);

  try {
    const conn = upsertConnection(input);
    return NextResponse.json({ connection: toClusterConnectionDTO(conn) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to save connection", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
