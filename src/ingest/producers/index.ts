// Cron entry for the ingest producer side.
//
// Runs every producer, each isolated in try/catch so one failing producer
// never aborts the rest, and records ONE ingest_runs row per producer
// (source = producer name) with its enqueued/failures counts + detail_json
// for the /sources observability page. Wired into the existing */15 cron in
// runtime/cron-dispatcher.ts.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { produceDrives, type DriveProducerResult } from "./drive";
import { produceMessages, type MessagesProducerResult } from "./messages";
import {
  produceSharepoint,
  type SharepointProducerResult,
} from "./sharepoint";
import { produceMail, type MailProducerResult } from "./mail";
import { produceCalendar, type CalendarProducerResult } from "./calendar";
import { produceMeetings, type MeetingsProducerResult } from "./meetings";
import { defaultProducerDeps, type ProducerDeps } from "./deps";

export interface ProduceAllResult {
  messages: MessagesProducerResult | null;
  drives: DriveProducerResult | null;
  sharepoint: SharepointProducerResult | null;
  mail: MailProducerResult | null;
  calendar: CalendarProducerResult | null;
  meetings: MeetingsProducerResult | null;
}

export async function produceAll(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
): Promise<ProduceAllResult> {
  return {
    messages: await runProducer(
      env,
      "messages",
      () => produceMessages(env, log, deps),
      log,
    ),
    drives: await runProducer(
      env,
      "drives",
      () => produceDrives(env, log, deps),
      log,
    ),
    sharepoint: await runProducer(
      env,
      "sharepoint",
      () => produceSharepoint(env, log, deps),
      log,
    ),
    mail: await runProducer(env, "mail", () => produceMail(env, log, deps), log),
    calendar: await runProducer(
      env,
      "calendar",
      () => produceCalendar(env, log, deps),
      log,
    ),
    meetings: await runProducer(
      env,
      "meetings",
      () => produceMeetings(env, log, deps),
      log,
    ),
  };
}

async function runProducer<T extends { enqueued: number; failures: number }>(
  env: Env,
  source: string,
  fn: () => Promise<T>,
  log: Logger,
): Promise<T | null> {
  const startedAt = new Date().toISOString();
  try {
    const r = await fn();
    await recordRun(env, source, startedAt, r.enqueued, r.failures, r);
    return r;
  } catch (e) {
    log.error("ingest_producer_failed", { source, error: String(e) });
    await recordRun(env, source, startedAt, 0, 1, { error: String(e) });
    return null;
  }
}

async function recordRun(
  env: Env,
  source: string,
  startedAt: string,
  enqueued: number,
  failures: number,
  detail: unknown,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO ingest_runs
       (id, source, started_at, finished_at, enqueued, processed, failures, detail_json)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      source,
      startedAt,
      new Date().toISOString(),
      enqueued,
      failures,
      JSON.stringify(detail),
    )
    .run();
}
