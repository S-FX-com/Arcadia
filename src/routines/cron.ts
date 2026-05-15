// Cron-trigger dispatch for routines.
//
// `runRoutinesForCron(env, cron, log, ctx)` matches the wrangler cron
// string against every enabled routine whose trigger.kind = 'cron' and
// trigger.cron = the same string, then runs them sequentially. The
// caller is the worker's scheduled() handler via cron-dispatcher.ts.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { runRoutine } from "./executor";
import { RoutineStore } from "./store";

export interface RoutinesCronResult {
  matched: number;
  succeeded: number;
  failed: number;
}

export async function runRoutinesForCron(
  env: Env,
  cron: string,
  log: Logger,
  ctx?: ExecutionContext,
): Promise<RoutinesCronResult> {
  const store = new RoutineStore(env);
  const matched = await store.listEnabledByCron(cron);

  const result: RoutinesCronResult = {
    matched: matched.length,
    succeeded: 0,
    failed: 0,
  };

  for (const routine of matched) {
    const run = await runRoutine(env, routine, "cron", log, ctx ? { ctx } : {});
    if (run.status === "succeeded") result.succeeded += 1;
    else result.failed += 1;
  }

  log.info("routines_cron", { cron, ...result });
  return result;
}
