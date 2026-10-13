// In-memory STOP request registry (K lane — ported from the parallel S/E
// line, Task 22 reference branch).
//
// The stop route registers a node here BEFORE flipping the row; the in-flight
// executeNodeGuarded consults it AFTER its execution promise settles, so a
// stop requested mid-run wins over the natural outcome: the node reports
// `cancelled` (not completed/failed) and every persist lane's conditional
// write ("only a row still running takes the outcome") keeps that verdict.
//
// Deliberately dependency-free (no db, no engine imports): workflow-engine
// imports the readers while the stop route (via node-run-control) imports
// the writer — no circular imports possible.
//
// Lifetime caveat: this is per-process state. The dev server and route
// handlers share one Node process, so the registry is globally coherent; a
// server restart simply drops stale flags (a stopped run is terminal in the
// DB anyway — the registry only arbitrates in-flight executions).

const STOP_REQUESTED = new Set<string>();

/** Register a stop for a node (idempotent). */
export function requestStop(nodeId: string): void {
  STOP_REQUESTED.add(nodeId);
}

/** Has a stop been requested for this node (and not yet consumed)? */
export function isStopRequested(nodeId: string): boolean {
  return STOP_REQUESTED.has(nodeId);
}

/** Consume/clear the stop flag for a node. */
export function clearStop(nodeId: string): void {
  STOP_REQUESTED.delete(nodeId);
}
