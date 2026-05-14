// Memory consolidation cycles, inspired by the human light / deep / REM model.
//
//   light  — every 15 minutes. Cheap. Dedupe near-identical memories,
//            refresh last-touched timestamps, mark stale.
//   deep   — daily. Combine supporting memories into stronger semantic
//            facts; weaken contradicted memories; promote frequently-used
//            procedures.
//   REM    — weekly. Find weakly-linked memories and try to derive new
//            connections via the deep tier of the AI router.
//
// Real per-cycle behaviour lands when intelligence ships. This module
// declares the entry points the cron dispatcher calls.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export type Cycle = "light" | "deep" | "rem";

export async function consolidate(
  _env: Env,
  cycle: Cycle,
  log: Logger,
): Promise<void> {
  log.info("memory_consolidation", { cycle });
  // TODO: per-cycle behaviour
}
