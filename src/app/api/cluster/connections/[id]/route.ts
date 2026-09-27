// Single cluster connection API — edit (PATCH) + delete (DELETE).
// Editing drops the pooled SSH client so the next exec reconnects with the
// updated host/auth credentials.

import { NextResponse } from "next/server";
import { upsertConnection, getConnection, deleteConnection } from "@/lib/cluster/connections";
import { dropConnection } from "@/lib/cluster/ssh";
import { toClusterConnectionDTO } from "@/lib/cluster/types";
import { parseConnectionBody } from "../route";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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
  if (!getConnection(id)) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  dropConnection(id); // stale sockets must not survive a config edit
  try {
    const conn = upsertConnection({ ...input, id });
    return NextResponse.json({ connection: toClusterConnectionDTO(conn) });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to save connection", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  dropConnection(id);
  const deleted = deleteConnection(id);
  if (!deleted) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
