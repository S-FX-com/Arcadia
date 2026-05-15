// Stale-thread detection.
//
// A thread is stale when its `last_activity_at` is older than the
// configured threshold (`STALE_THREAD_HOURS`, default 48). This module
// only marks the `stale_at` column — anything that wants to act on the
// staleness (digest, nudge) reads that column and decides.
//
// The threads table is hydrated by the ingest pipeline (item 16); this
// runner is purely SQL and is safe to call before that lands — it
// returns zero rows touched when the table is empty.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { config } from "../lib/config";

export interface StaleResult {
  scanned: number;
  marked: number;
  cleared: number;
}

export async function runStaleDetection(
  env: Env,
  log: Logger,
): Promise<StaleResult> {
  const cfg = config(env);
  const thresholdMs = cfg.staleThreadHours * 3600 * 1000;
  const threshold = new Date(Date.now() - thresholdMs).toISOString();

  const total = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM threads`,
  ).first<{ n: number }>();
  const scanned = total?.n ?? 0;

  // Mark threads stale where they crossed the threshold since last run.
  const marked = await env.ARCADIA_DB.prepare(
    `UPDATE threads
        SET stale_at = ?
      WHERE stale_at IS NULL
        AND last_activity_at < ?`,
  )
    .bind(new Date().toISOString(), threshold)
    .run();

  // Clear staleness on threads that have woken up since they were
  // marked. last_activity_at would have been updated by ingest.
  const cleared = await env.ARCADIA_DB.prepare(
    `UPDATE threads
        SET stale_at = NULL
      WHERE stale_at IS NOT NULL
        AND last_activity_at >= ?`,
  )
    .bind(threshold)
    .run();

  const result: StaleResult = {
    scanned,
    marked: marked.meta.changes ?? 0,
    cleared: cleared.meta.changes ?? 0,
  };
  log.info("stale_detection", result);
  return result;
}
