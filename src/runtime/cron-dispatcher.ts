// Routes scheduled events to the right behaviour:
//   "0 8 * * *"      → stale detection → digest → nudge engine → subscription renewal
//   "0 8 * * 1"      → weekly Monday operational report
//   "0 12 * * 1-5"   → morning brief
//   "0 21 * * 1-5"   → evening wrap-up
//   "0 */6 * * *"   → group-membership refresh
//   "0 4 * * *"      → nightly eval suite
//   "*/15 * * * *"  → memory consolidation tick
//
// Real handlers land in the Intelligence + Memory + Eval commits.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function dispatchCron(
  event: ScheduledEvent,
  _env: Env,
  log: Logger,
): Promise<void> {
  log.info("cron_dispatch", { cron: event.cron });
  // TODO: route per event.cron once handlers land.
}
