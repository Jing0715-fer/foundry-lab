"use client";

/**
 * Shared undo/redo application logic (review 2-b, FIX 2 + FIX 3).
 *
 * Both WorkflowCanvas (Ctrl+Z / Ctrl+Shift+Z) and CanvasToolbar (undo/redo
 * buttons) used to carry their own copies of `applySnapshot`. The copies
 * drifted: the toolbar's lacked the history-capture guard, so every toolbar
 * undo/redo re-recorded itself as a NEW history entry (undo became a
 * toggle), and both re-POSTed restored nodes while keeping the OLD local
 * ids — the server minted NEW ids, so every later PATCH/run on those nodes
 * 404'd. This module is the single guarded implementation both call sites
 * now share.
 */

import type { NodeDTO, EdgeDTO } from "./types";
import { useAppStore } from "./store";
import type { HistorySnapshot } from "./history-store";

// ---------------------------------------------------------------------------
// Capture suppression (the guard)
// ---------------------------------------------------------------------------

/**
 * Re-entrancy counter. While > 0, the workflow-change subscription in
 * workflow-canvas.tsx must NOT push history captures:
 *  - `applyHistorySnapshot` holds it while it restores a snapshot (the
 *    restoration itself would otherwise be recorded as new history), and
 *  - mutation sites that push their OWN inline snapshot wrap their store
 *    writes in `withHistorySuppressed` so the same transition isn't
 *    captured twice (one operation → exactly one history entry).
 */
let historyLock = 0;

/** True while an undo/redo restoration or an inline-push mutation is writing. */
export function isApplyingHistory(): boolean {
  return historyLock > 0;
}

/**
 * Run `fn` with history capture suppressed. The lock is released on the NEXT
 * macrotask, not synchronously: zustand subscribers fire synchronously inside
 * the set() calls that `fn` performs, and they must still observe the lock.
 */
export function withHistorySuppressed<T>(fn: () => T): T {
  historyLock += 1;
  try {
    return fn();
  } finally {
    window.setTimeout(() => {
      historyLock -= 1;
    }, 0);
  }
}

/** Snapshot the CURRENT workflow + viewport (the "current" undo/redo needs). */
export function captureCurrentSnapshot(): HistorySnapshot | null {
  const s = useAppStore.getState();
  if (!s.workflow) return null;
  return {
    nodes: s.workflow.nodes,
    edges: s.workflow.edges,
    viewport: s.viewport,
  };
}

// ---------------------------------------------------------------------------
// Snapshot application (id-remapping, DB↔store consistent)
// ---------------------------------------------------------------------------

/** Identity key for an edge — endpoints + ports (two rows can share a pair
 *  of nodes with different ports, so endpoints alone are ambiguous). */
function edgeKey(from: string, to: string, fromPort: string | null, toPort: string | null): string {
  return `${from}->${to}:${fromPort ?? "*"}->${toPort ?? "*"}`;
}

/**
 * Apply an undo/redo snapshot: make the server graph match the snapshot, then
 * make the local store match the server (which may have minted NEW ids for
 * re-created nodes/edges — the local store must use THOSE, or every later
 * PATCH / DELETE on the restored rows 404s).
 *
 * Steps:
 *  1. DELETE nodes that exist now but not in the snapshot (undo of a create).
 *  2. POST nodes that exist in the snapshot but not now (undo of a delete).
 *     The server mints new ids → build an old→new id map.
 *  3. PATCH nodes that exist in BOTH but drifted (position/name/params —
 *     e.g. undoing an auto-arrange) so the server follows the restoration.
 *  4. Remap snapshot nodes AND edge endpoints through the id map.
 *  5. DELETE current edges missing from the snapshot; POST snapshot edges
 *     missing now (against remapped ids) and keep the SERVER's edge rows
 *     (new edge ids) in the store.
 *  6. setWorkflow(remapped snapshot) + setViewport — under the capture lock
 *     so the restoration is not re-captured as history.
 *
 * All requests are best-effort (allSettled / per-item catch): a partial
 * server failure must never leave the local store diverged from what the
 * server actually kept.
 */
export async function applyHistorySnapshot(snap: HistorySnapshot): Promise<void> {
  historyLock += 1;
  try {
    const s = useAppStore.getState();
    const wf = s.workflow;
    if (wf) {
      const curIds = new Set(wf.nodes.map((n) => n.id));
      const snapIds = new Set(snap.nodes.map((n) => n.id));

      // 1. Undo-of-create: delete nodes that only exist now.
      const toDelete = wf.nodes.filter((n) => !snapIds.has(n.id));
      await Promise.allSettled(
        toDelete.map((n) =>
          fetch(`/api/workflow/nodes/${n.id}`, { method: "DELETE" }).catch(
            () => null,
          ),
        ),
      );

      // 2. Undo-of-delete: re-create nodes that only exist in the snapshot.
      //    The server mints NEW ids for them — we keep an old→new map so the
      //    restored store references rows that actually exist server-side.
      const missing = snap.nodes.filter((n) => !curIds.has(n.id));
      const idMap = new Map<string, string>();
      const created = await Promise.allSettled(
        missing.map((n) =>
          fetch("/api/workflow/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // Contract (task 3-a): the node is created in the CURRENT
              // workflow — without this the server falls back to its
              // first-workflow default and the node lands in the wrong graph.
              workflowId: wf.id,
              type: n.type,
              name: n.name,
              x: n.x,
              y: n.y,
              refId: n.refId ?? undefined,
              params: n.params,
              // Sweep linkage — restored variants must rejoin their group so
              // compare / one-click campaign still resolve after a redo.
              sweepGroup: n.sweepGroup ?? undefined,
            }),
          })
            .then((r) =>
              r.ok
                ? (r.json() as Promise<NodeDTO>)
                : Promise.reject(new Error(`HTTP ${r.status}`)),
            )
            .catch(() => null),
        ),
      );
      missing.forEach((n, i) => {
        const r = created[i];
        if (r.status === "fulfilled" && r.value) {
          idMap.set(n.id, r.value.id);
        }
      });

      // 3. Drift sync for nodes present in both (undo of an auto-arrange or
      //    a rename): PATCH the restored geometry/name/params so a page
      //    reload doesn't silently revert the undo.
      const drifted = snap.nodes.filter((n) => {
        const cur = wf.nodes.find((c) => c.id === n.id);
        if (!cur) return false;
        return (
          cur.x !== n.x ||
          cur.y !== n.y ||
          cur.name !== n.name ||
          JSON.stringify(cur.params) !== JSON.stringify(n.params)
        );
      });
      await Promise.allSettled(
        drifted.map((n) =>
          fetch(`/api/workflow/nodes/${n.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              x: n.x,
              y: n.y,
              name: n.name,
              params: n.params,
            }),
          }).catch(() => null),
        ),
      );

      // 4. Remap the snapshot onto server reality: every restored node keeps
      // its snapshot fields but takes the NEW server id where one was minted.
      // The POST was made with the snapshot's type/name/xy/params, so the row
      // mirrors the snapshot except for ids/timestamps (and status — a fresh
      // row is always idle; the store keeps the snapshot's view until the
      // next poll/reload reconciles it).
      const finalNodes: NodeDTO[] = snap.nodes.map((n) => {
        const newId = idMap.get(n.id);
        return newId ? { ...n, id: newId, workflowId: wf.id } : { ...n, workflowId: wf.id };
      });

      // 5. Edge diff against remapped ids. Edges to POST get server rows
      //    (new ids) back; edges that already exist keep their live row.
      const remapId = (id: string): string => idMap.get(id) ?? id;
      const finalEdgesDraft: EdgeDTO[] = snap.edges.map((e) => {
        const from = remapId(e.fromNodeId);
        const to = remapId(e.toNodeId);
        return from === e.fromNodeId && to === e.toNodeId
          ? { ...e, workflowId: wf.id }
          : { ...e, fromNodeId: from, toNodeId: to, workflowId: wf.id };
      });

      const snapKeys = new Set(
        finalEdgesDraft.map((e) =>
          edgeKey(e.fromNodeId, e.toNodeId, e.fromPort, e.toPort),
        ),
      );
      const curByKey = new Map(
        wf.edges.map((e) => [
          edgeKey(e.fromNodeId, e.toNodeId, e.fromPort, e.toPort),
          e,
        ]),
      );

      // Delete current edges the snapshot doesn't have (undo of a connect).
      // Node deletions above already cascaded some of these — 404s expected.
      await Promise.allSettled(
        wf.edges
          .filter(
            (e) =>
              !snapKeys.has(edgeKey(e.fromNodeId, e.toNodeId, e.fromPort, e.toPort)),
          )
          .map((e) =>
            fetch(`/api/workflow/edges/${e.id}`, { method: "DELETE" }).catch(
              () => null,
            ),
          ),
      );

      // POST snapshot edges missing now (undo of an edge delete) — against
      // the remapped node ids, capturing the server's new edge rows.
      const edgesToCreate = finalEdgesDraft.filter(
        (e) =>
          !curByKey.has(edgeKey(e.fromNodeId, e.toNodeId, e.fromPort, e.toPort)),
      );
      const createdEdges = await Promise.allSettled(
        edgesToCreate.map((e) =>
          fetch("/api/workflow/edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fromNodeId: e.fromNodeId,
              toNodeId: e.toNodeId,
              fromPort: e.fromPort ?? undefined,
              toPort: e.toPort ?? undefined,
            }),
          })
            .then((r) =>
              r.ok
                ? (r.json() as Promise<EdgeDTO>)
                : Promise.reject(new Error(`HTTP ${r.status}`)),
            )
            .catch(() => null),
        ),
      );

      // Final edge list: live server rows where they exist, the POSTed
      // server rows for re-created edges, and the (remapped) snapshot edge
      // as a last-resort placeholder when its POST failed — the store then
      // still shows the intended graph while the DB honestly lacks the row.
      const finalEdges: EdgeDTO[] = finalEdgesDraft.map((e) => {
        const k = edgeKey(e.fromNodeId, e.toNodeId, e.fromPort, e.toPort);
        const existing = curByKey.get(k);
        if (existing) return existing;
        const idx = edgesToCreate.findIndex((c) =>
          edgeKey(c.fromNodeId, c.toNodeId, c.fromPort, c.toPort) === k
        );
        const r = idx >= 0 ? createdEdges[idx] : null;
        return r && r.status === "fulfilled" && r.value ? r.value : e;
      });

      // 6. Commit the restored graph to the store. The lock held for this
      //    whole function already covers the synchronous subscribers that
      //    setWorkflow triggers, so the restoration is not re-captured as
      //    history.
      s.setWorkflow({ ...wf, nodes: finalNodes, edges: finalEdges });
    }
    s.setViewport(snap.viewport);
  } finally {
    // Release on the next macrotask — the synchronous subscribers triggered
    // by setWorkflow above must still observe the lock.
    window.setTimeout(() => {
      historyLock -= 1;
    }, 0);
  }
}
