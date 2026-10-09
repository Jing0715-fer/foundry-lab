// Cancel-source marker for ToolJobs (F-lane — Stop/watchdog semantics, the
// ToolJob half of the two-way badge).
//
// When a user Stops a canvas NODE, the stop route best-effort-cancels the
// ToolJob linked to that node's logs (cluster lane or local lane). The node
// half of the visibility contract already exists ([stop] notes in node logs +
// failure pills); this module gives the TOOLJOB half a machine-checkable
// trace so job rows can badge "cancelled via node stop" instead of a bare
// "cancelled" that looks identical to a job stopped from its own panel.

/** Marker appended to ToolJob.stderr by the node-stop route. */
export const CANCELLED_VIA_NODE_STOP = "[stop] cancelled via node stop";

/** Does this ToolJob stderr carry the node-stop cancellation trace? */
export function isCancelledViaNodeStop(stderr: string | null | undefined): boolean {
  return (stderr ?? "").includes(CANCELLED_VIA_NODE_STOP);
}
