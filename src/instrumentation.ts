// Next.js instrumentation hook — runs once when the server process boots
// (dev and production). Starts the workflow scheduled-run sweeper, which
// persists + fires WorkflowSchedule rows through the real execution engine.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduleSweeper } = await import("./lib/scheduler");
    startScheduleSweeper();
  }
}
