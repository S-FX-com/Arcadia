// Routes scheduled events to the right behaviour:
//   "0 8 * * *"      → stale detection → digest → nudge engine →
//                       daily heartbeat (memory-balance / staleness /
//                       proactive-opportunity scan)
//                       (subscription renewal lives in graph/* and
//                        is appended once that cron path is wired)
//   "0 8 * * 1"      → weekly Monday operational report
//   "0 12 * * 1-5"   → morning brief
//   "0 21 * * 1-5"   → evening wrap-up
//   "0 */6 * * *"   → group-membership refresh (stub — ACL commit)
//   "0 4 * * *"      → deep memory consolidation → curiosity budget →
//                       (Sunday) REM synthesis + weekly self-model →
//                       nightly eval suite
//   "*/15 * * * *"  → subscription reconcile (ensureSubscriptions, KV
//                        rate-limited to ~50 min) → ingest producers →
//                        meeting intel → memory consolidation tick
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
import { syncRegistry } from "../graph/registry";
import {
  ensureSubscriptions,
  renewExpiringSubscriptions,
} from "../graph/subscriptions";
import { produceAll } from "../ingest/producers";
import { runBriefsCycle } from "../intelligence/briefs";
import { runCuriosity } from "../intelligence/curiosity";
import { extractDecisions } from "../intelligence/decisions";
import { runDigestCycle } from "../intelligence/digest";
import { runHeartbeat } from "../intelligence/heartbeat";
import {
  runPostMeetingWrapups,
  runPreMeetingBriefs,
} from "../intelligence/meeting-intel";
import { runNudgeCycle } from "../intelligence/nudge";
import { runStaleDetection } from "../intelligence/stale";
import { runWeeklyCycle } from "../intelligence/weekly";
import { consolidate } from "../memory/consolidation";
import { SelfModel } from "../memory/self-model";
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
      // Daily heartbeat: memory-balance / staleness / proactive-opportunity
      // scan. Observes + records only (surfaced later by the org-pulse).
      await safe(() => runHeartbeat(env, log), "heartbeat", log);
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
      // Registry sync first: it derives resource_acl group grants (channel →
      // team group, site → group). refreshGroupMembership then walks exactly
      // the groups referenced in resource_acl, so newly-derived group grants
      // get their membership rows in the same tick — no 6h ACL blind spot.
      await safe(() => syncRegistry(env, log), "registry_sync", log);
      await safe(
        () => refreshGroupMembership(env, log),
        "group_membership_refresh",
        log,
      );
      break;

    case "*/15 * * * *":
      // Reconcile Graph subscriptions here — there is no hourly cron, and this
      // is the closest tick. ensureSubscriptions self-rate-limits via KV to
      // ~once/50 min, which is what keeps the ~1h getAllMessages subs alive.
      await safe(() => ensureSubscriptions(env, log), "subscription_ensure", log);
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
      // Curiosity budget: identify model gaps and record a bounded number
      // of open research questions (after deep distillation refreshes the
      // semantic layer the gap scan reads from).
      await safe(() => runCuriosity(env, log), "curiosity", log);
      // Sunday → also run the REM pass after deep distillation, then rebuild
      // the weekly self-model from the freshly-consolidated week.
      if (new Date().getUTCDay() === 0) {
        await safe(
          () => consolidate(env, "rem", log),
          "memory_rem",
          log,
        );
        await safe(() => SelfModel.regenerate(env, log), "self_model", log);
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
