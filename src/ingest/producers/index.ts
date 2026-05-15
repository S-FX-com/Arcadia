// Cron entry for the ingest producer side.
//
// Runs all enabled producers sequentially. Wire into
// runtime/cron-dispatcher.ts on a frequent-enough cron — */15 makes
// sense for messages, hourly for drive/sharepoint. For day-zero we
// run them all on the existing */15 tick.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { produceDrives } from "./drive";
import { produceMessages } from "./messages";
import { produceSharepoint } from "./sharepoint";

export interface ProduceAllResult {
  messages: { enqueued: number; channels: number; chats: number; failures: number };
  drives: { drives: number; enqueued: number; failures: number };
  sharepoint: { sites: number; enqueued: number; failures: number };
}

export async function produceAll(
  env: Env,
  log: Logger,
): Promise<ProduceAllResult> {
  const messages = await produceMessages(env, log);
  const drives = await produceDrives(env, log);
  const sharepoint = await produceSharepoint(env, log);
  return { messages, drives, sharepoint };
}
