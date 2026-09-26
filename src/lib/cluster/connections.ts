// Cluster connection registry — persistence + lookups.
//
// Stored at data/cluster-connections.json with 0600 permissions (the file can
// contain secrets: password / passphrase). DTO projection strips secrets.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { ClusterConnection, ClusterConnectionDTO } from "./types";
import { toClusterConnectionDTO } from "./types";

const DATA_DIR = join(process.cwd(), "data");
const REGISTRY_FILE = join(DATA_DIR, "cluster-connections.json");

const DEFAULTS = {
  port: 22,
  remoteRoot: "~/foundry-lab",
  remoteToolsDir: "~/foundry-lab/tools",
};

function readRaw(): ClusterConnection[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    const txt = readFileSync(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? (parsed as ClusterConnection[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(list: ClusterConnection[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  try { chmodSync(REGISTRY_FILE, 0o600); } catch { /* best-effort (win) */ }
}

export function listConnections(): ClusterConnection[] {
  return readRaw();
}

export function listConnectionDTOs(): ClusterConnectionDTO[] {
  return readRaw().map(toClusterConnectionDTO);
}

export function getConnection(id: string): ClusterConnection | undefined {
  return readRaw().find((c) => c.id === id);
}

/** Find a live connection by host+username (host-matched recovery, cryoflow
 *  pattern: "the cluster is a host, not a connection id"). */
export function liveConnectionForHost(host: string, username?: string): ClusterConnection | undefined {
  return readRaw().find(
    (c) => c.host === host && (username == null || c.username === username),
  );
}

/** Upsert by id (or create when id is absent). Secrets: empty string = clear,
 *  absent field = keep the stored value. */
export function upsertConnection(input: Partial<ClusterConnection> & { name: string }): ClusterConnection {
  const list = readRaw();
  const now = new Date().toISOString();
  let conn: ClusterConnection | undefined = input.id ? list.find((c) => c.id === input.id) : undefined;

  if (!conn) {
    conn = {
      id: input.id ?? randomUUID(),
      name: input.name,
      host: input.host ?? "",
      port: input.port ?? DEFAULTS.port,
      username: input.username ?? "",
      authMethod: input.authMethod ?? "password",
      privateKeyPath: input.privateKeyPath ?? null,
      passphrase: input.passphrase ?? null,
      password: input.password ?? null,
      remoteRoot: input.remoteRoot || DEFAULTS.remoteRoot,
      remoteToolsDir: input.remoteToolsDir || DEFAULTS.remoteToolsDir,
      envLines: input.envLines ?? [],
      useSlurm: input.useSlurm ?? false,
      slurmPartition: input.slurmPartition ?? null,
      slurmTimeMin: input.slurmTimeMin ?? null,
      createdAt: now,
      updatedAt: now,
      lastProbe: null,
    };
    list.push(conn);
  } else {
    // Secret semantics: field present + empty string → clear; absent → keep.
    const keepSecret = (cur: string | null | undefined, next: string | null | undefined) =>
      next === undefined ? (cur ?? null) : (next === "" ? null : next);
    conn.name = input.name ?? conn.name;
    conn.host = input.host ?? conn.host;
    conn.port = input.port ?? conn.port;
    conn.username = input.username ?? conn.username;
    conn.authMethod = input.authMethod ?? conn.authMethod;
    conn.privateKeyPath = input.privateKeyPath !== undefined ? input.privateKeyPath : conn.privateKeyPath;
    conn.passphrase = keepSecret(conn.passphrase, input.passphrase);
    conn.password = keepSecret(conn.password, input.password);
    conn.remoteRoot = input.remoteRoot || conn.remoteRoot || DEFAULTS.remoteRoot;
    conn.remoteToolsDir = input.remoteToolsDir || conn.remoteToolsDir || DEFAULTS.remoteToolsDir;
    conn.envLines = input.envLines ?? conn.envLines;
    conn.useSlurm = input.useSlurm ?? conn.useSlurm;
    conn.slurmPartition = input.slurmPartition !== undefined ? input.slurmPartition : conn.slurmPartition;
    conn.slurmTimeMin = input.slurmTimeMin !== undefined ? input.slurmTimeMin : conn.slurmTimeMin;
    conn.updatedAt = now;
  }

  writeRaw(list);
  return conn;
}

export function deleteConnection(id: string): boolean {
  const list = readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeRaw(list);
  return true;
}

export function persistProbe(id: string, probe: ClusterConnection["lastProbe"]): void {
  const list = readRaw();
  const conn = list.find((c) => c.id === id);
  if (!conn) return;
  conn.lastProbe = probe;
  conn.updatedAt = new Date().toISOString();
  writeRaw(list);
}
