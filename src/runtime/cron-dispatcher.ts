// Routes scheduled events to the right behaviour:
//   "0 8 * * *"      → stale detection → digest → nudge engine
//                       (subscription renewal lives in graph/* and
//                        is appended once that cron path is wired)
//   "0 8 * * 1"      → weekly Monday operational report
//   "0 12 * * 1-5"   → morning brief
//   "0 21 * * 1-5"   → evening wrap-up
//   "0 */6 * * *"   → group-membership refresh (stub — ACL commit)
//   "0 4 * * *"      → nightly eval suite (stub — eval commit)
//   "*/15 * * * *"  → memory consolidation tick (stub — consolidation
//                        cycles live behind src/memory/consolidation.ts)
//
// Each branch is fail-soft: one handler erroring does not abort the
// rest of the cycle. ctx.waitUntil() is unnecessary here because the
// scheduled() handler in src/index.ts already keeps the Worker alive
// for the duration of this call.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { refreshGroupMembership } from "../acl/group-membership";
import { runBriefsCycle } from "../intelligence/briefs";
import { runDigestCycle } from "../intelligence/digest";
import { runNudgeCycle } from "../intelligence/nudge";
import { runStaleDetection } from "../intelligence/stale";
import { runWeeklyCycle } from "../intelligence/weekly";
import { runRoutinesForCron } from "../routines/cron";

export async function dispatchCron(
  event: ScheduledEvent,
  env: Env,
  log: Logger,
  ctx?: ExecutionContext,
): Promise<void> {
  const cron = event.cron;
  log.info("cron_dispatch", { cron });

  switch (cron) {
    case "0 8 * * *":
      await safe(() => runStaleDetection(env, log), "stale", log);
      await safe(() => runDigestCycle(env, log), "digest", log);
      await safe(() => runNudgeCycle(env, log), "nudge", log);
      break;

    case "0 8 * * 1":
      await safe(() => runWeeklyCycle(env, log), "weekly", log);
      break;

    case "0 12 * * 1-5":
      await safe(
        () => runBriefsCycle(env, "morning", log),
        "morning_brief",
        log,
      );
      break;

    case "0 21 * * 1-5":
      await safe(
        () => runBriefsCycle(env, "evening", log),
        "evening_brief",
        log,
      );
      break;

    case "0 */6 * * *":
      await safe(
        () => refreshGroupMembership(env, log),
        "group_membership_refresh",
        log,
      );
      break;

    case "0 4 * * *":
    case "*/15 * * * *":
      log.info("cron_unimplemented", { cron });
      break;

    default:
      log.warn("cron_unknown", { cron });
      break;
  }

  // Every cron tick also runs any user routine bound to that exact
  // cron string. Built-in cycles ran first so a user routine reading
  // from the digests/briefs/nudges tables sees fresh data.
  await safe(
    () => runRoutinesForCron(env, cron, log, ctx),
    "routines_cron",
    log,
  );
}

async function safe<T>(
  fn: () => Promise<T>,
  label: string,
  log: Logger,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error("cron_step_failed", { step: label, error: String(e) });
  }
}
