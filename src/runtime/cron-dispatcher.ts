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
import { gateLatestRun } from "../eval/gate";
import { runEvals } from "../eval/runner";
import { renewExpiringSubscriptions } from "../graph/subscriptions";
import { produceAll } from "../ingest/producers";
import { runBriefsCycle } from "../intelligence/briefs";
import { extractDecisions } from "../intelligence/decisions";
import { runDigestCycle } from "../intelligence/digest";
import {
  runPostMeetingWrapups,
  runPreMeetingBriefs,
} from "../intelligence/meeting-intel";
import { runNudgeCycle } from "../intelligence/nudge";
import { runStaleDetection } from "../intelligence/stale";
import { runWeeklyCycle } from "../intelligence/weekly";
import { consolidate } from "../memory/consolidation";
import { syncAll as syncConnector } from "../openapi/connector-sync";
import { runRoutinesForCron } from "../routines/cron";

export interface CronTrigger {
  cron: string;
  scheduledTime?: number;
}

export async function dispatchCron(
  event: CronTrigger,
  env: Env,
  log: Logger,
  ctx?: ExecutionContext,
): Promise<void> {
  const cron = event.cron;
  log.info("cron_dispatch", { cron });

  switch (cron) {
    case "0 8 * * *":
      await safe(() => runStaleDetection(env, log), "stale", log);
      await safe(() => extractDecisions(env, log), "decisions", log);
      await safe(() => runDigestCycle(env, log), "digest", log);
      await safe(() => runNudgeCycle(env, log), "nudge", log);
      await safe(
        () => renewExpiringSubscriptions(env, log),
        "subscription_renew",
        log,
      );
      await safe(() => syncConnector(env, log), "connector_sync", log);
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

    case "*/15 * * * *":
      await safe(() => produceAll(env, log), "ingest_produce", log);
      await safe(
        () => runPreMeetingBriefs(env, log),
        "pre_meeting_briefs",
        log,
      );
      await safe(
        () => runPostMeetingWrapups(env, log),
        "post_meeting_wrapups",
        log,
      );
      await safe(
        () => consolidate(env, "light", log),
        "memory_light",
        log,
      );
      break;

    case "0 4 * * *":
      await safe(
        () => consolidate(env, "deep", log),
        "memory_deep",
        log,
      );
      // Sunday → also run the REM pass after deep distillation.
      if (new Date().getUTCDay() === 0) {
        await safe(
          () => consolidate(env, "rem", log),
          "memory_rem",
          log,
        );
      }
      await safe(
        async () => {
          const summary = await runEvals(env, log);
          await gateLatestRun(env, summary, log);
        },
        "eval_nightly",
        log,
      );
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
