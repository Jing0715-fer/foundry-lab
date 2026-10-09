// Failure-reason classification (F1): the three terminal-failure lanes the
// execution stack can produce, told apart by their persisted result strings.
//
// Contract (write side — all three lanes already encode a stable marker):
//   - User stop   → result "Stopped by user before completion." (stop route)
//   - Watchdog    → result "Error: execution timed out after … (watchdog) —"
//                   + a "[watchdog]" log banner (workflow-engine E1)
//   - Engine/tool → anything else ("Error: …", "Tool failed (exit N) — …",
//                   LLM/network failures, boot-orphan reconciliation…)
//
// Read side: /api/runs classifies failed rows server-side (the SELECT is
// trimmed for the 3s poll, so `result` is fetched in a second bounded query);
// node-card classifies client-side from the NodeDTO result it already has.

export type FailureReason = "stopped" | "watchdog" | "engine";

/** Classify a failed node by its persisted result string. */
export function classifyFailure(
  result: string | null | undefined,
): FailureReason {
  const r = (result ?? "").toLowerCase();
  if (r.includes("stopped by user")) return "stopped";
  if (r.includes("[watchdog]") || r.includes("(watchdog)")) return "watchdog";
  return "engine";
}

export interface FailureReasonMeta {
  label: string;
  /** Pill / badge text classes (consistent light+dark). */
  pillClass: string;
  description: string;
}

export const FAILURE_META: Record<FailureReason, FailureReasonMeta> = {
  stopped: {
    label: "Stopped",
    pillClass: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    description: "Stopped by user — in-flight results were discarded.",
  },
  watchdog: {
    label: "Watchdog",
    pillClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    description:
      "Killed by the execution watchdog (no terminal state in time).",
  },
  engine: {
    label: "Engine",
    pillClass: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    description: "The engine or tool run itself failed (see Logs).",
  },
};
