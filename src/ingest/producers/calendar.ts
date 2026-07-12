// Per-user calendar producer.
//
// Users come from the `users` registry table, processed in a capped,
// KV-round-robin batch (cursor `ingest:calendar_cursor`). Each user's
// calendar is walked via /users/{aadId}/calendarView/delta over a fixed
// window (now-7d .. now+30d); the @odata.deltaLink is persisted verbatim
// in delta_state (resource 'calendar') so the window rides forward on the
// next run.
//
// Unlike drive/mail, calendar events are enqueued with an INLINE plain-text
// body (subject / organizer / attendees / start / end / location /
// preview) — there is no separate body to fetch, so the consumer indexes
// the block directly.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { loadDeltaToken, saveDeltaToken } from "../../graph/delta";
import type { GraphRequest } from "../../graph/client";
import type { CalendarEvent } from "../../graph/calendar";
import type { IngestMessage } from "../types";
import {
  defaultProducerDeps,
  loadCursor,
  saveCursor,
  type ProducerDeps,
} from "./deps";

type CalEvent = CalendarEvent & {
  location?: { displayName?: string };
  "@removed"?: unknown;
};

const RESOURCE = "calendar";
const CAL_CAP = 25;
const CAL_CURSOR_KEY = "ingest:calendar_cursor";
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CalendarProducerResult {
  users: number;
  enqueued: number;
  failures: number;
}

export async function produceCalendar(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
  cap: number = CAL_CAP,
): Promise<CalendarProducerResult> {
  const cursor = await loadCursor(env, CAL_CURSOR_KEY);
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users WHERE aad_id > ? ORDER BY aad_id LIMIT ?`,
  )
    .bind(cursor, cap)
    .all<{ aad_id: string }>();

  const result: CalendarProducerResult = {
    users: rows.results.length,
    enqueued: 0,
    failures: 0,
  };

  for (const row of rows.results) {
    try {
      result.enqueued += await walkCalendar(env, row.aad_id, log, deps);
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_calendar_failed", {
        aadId: row.aad_id,
        error: String(e),
      });
    }
  }

  await saveCursor(
    env,
    CAL_CURSOR_KEY,
    rows.results.map((r) => r.aad_id),
    cap,
  );

  log.info("ingest_produced_calendar", result);
  return result;
}

async function walkCalendar(
  env: Env,
  aadId: string,
  log: Logger,
  deps: ProducerDeps,
): Promise<number> {
  const stored = await loadDeltaToken(env, RESOURCE, aadId);
  let req: GraphRequest;
  if (stored) {
    req = { path: stored };
  } else {
    const now = deps.now().getTime();
    req = {
      path: `/users/${aadId}/calendarView/delta`,
      query: {
        startDateTime: new Date(now - LOOKBACK_DAYS * DAY_MS).toISOString(),
        endDateTime: new Date(now + LOOKAHEAD_DAYS * DAY_MS).toISOString(),
      },
    };
  }

  const { items, deltaLink } = await deps.graphAllPages<CalEvent>(env, req, {
    maxPages: 40,
  });

  let count = 0;
  for (const e of items) {
    if (e["@removed"] !== undefined) continue;
    if (e.isCancelled) continue;
    const text = buildEventText(e);
    if (!text.trim()) continue;

    const msg: IngestMessage = {
      source: "calendar_event",
      resourceId: e.id,
      body: { content: text, contentType: "text" },
      ownerAadId: aadId,
      scope: { resourceType: "user", resourceId: aadId },
      ...(e.subject ? { title: e.subject } : {}),
      ...(e.end?.dateTime ? { lastModifiedAt: e.end.dateTime } : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (deltaLink) await saveDeltaToken(env, RESOURCE, aadId, deltaLink);
  log.info("ingest_calendar_walked", { aadId, enqueued: count });
  return count;
}

function buildEventText(e: CalEvent): string {
  const lines: string[] = [];
  if (e.subject) lines.push(`Subject: ${e.subject}`);
  const organizer =
    e.organizer?.emailAddress?.name ?? e.organizer?.emailAddress?.address;
  if (organizer) lines.push(`Organizer: ${organizer}`);
  const attendees = (e.attendees ?? [])
    .map((a) => a.emailAddress?.name ?? a.emailAddress?.address)
    .filter((n): n is string => Boolean(n));
  if (attendees.length) lines.push(`Attendees: ${attendees.join(", ")}`);
  if (e.start?.dateTime) lines.push(`Start: ${e.start.dateTime}`);
  if (e.end?.dateTime) lines.push(`End: ${e.end.dateTime}`);
  if (e.location?.displayName) lines.push(`Location: ${e.location.displayName}`);
  if (e.bodyPreview) lines.push("", e.bodyPreview);
  return lines.join("\n");
}
