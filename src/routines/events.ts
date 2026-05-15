// Event-trigger dispatch for routines.
//
// `runRoutinesForEvent(env, resource, changeType, log, ctx)` is called
// from src/graph/subscriptions.ts when a Graph change notification
// arrives. It matches enabled routines whose trigger.kind = 'event'
// AND trigger.resource = the inbound resource path, optionally
// constrained by trigger.changeType.
//
// The Graph subscription handler is responsible for verifying the
// clientState HMAC + decrypting the payload before calling here; this
// module just handles the routing.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { runRoutine } from "./executor";
import { RoutineStore } from "./store";

export type ChangeType = "created" | "updated" | "deleted";

export interface RoutinesEventResult {
  matched: number;
  succeeded: number;
  failed: number;
}

export async function runRoutinesForEvent(
  env: Env,
  resource: string,
  changeType: ChangeType | undefined,
  log: Logger,
  ctx?: ExecutionContext,
): Promise<RoutinesEventResult> {
  const store = new RoutineStore(env);
  const candidates = await store.listEnabledByEvent(resource);
  const matched = candidates.filter((r) => {
    if (r.trigger.kind !== "event") return false;
    if (!r.trigger.changeType) return true;
    return r.trigger.changeType === changeType;
  });

  const result: RoutinesEventResult = {
    matched: matched.length,
    succeeded: 0,
    failed: 0,
  };

  for (const routine of matched) {
    const run = await runRoutine(env, routine, "event", log, ctx ? { ctx } : {});
    if (run.status === "succeeded") result.succeeded += 1;
    else result.failed += 1;
  }

  log.info("routines_event", { resource, changeType, ...result });
  return result;
}
