// Meeting-transcript producer.
//
// For the same kind of capped, KV-round-robin user set as the calendar
// producer (cursor `ingest:meetings_cursor`), this producer does its own
// bounded calendarView walk over the last 48h. For each ended event that
// carries an onlineMeeting.joinUrl it resolves the online meeting
// (/users/{aadId}/onlineMeetings?$filter=JoinWebUrl eq '...'), lists its
// transcripts, fetches each transcript as text/vtt, and enqueues an INLINE
// meeting_transcript IngestMessage scoped to the organizer (P2 will widen
// to attendees).
//
// The onlineMeetings + transcript APIs are Microsoft "protected APIs": until
// the tenant's app registration is approved they return 402/403. That is
// treated as graceful degradation — logged once per run, after which the
// producer stops and returns zeros rather than failing the cron.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import type { CalendarEvent } from "../../graph/calendar";
import type { IngestMessage } from "../types";
import {
  defaultProducerDeps,
  GraphError,
  loadCursor,
  saveCursor,
  type ProducerDeps,
} from "./deps";

interface OnlineMeeting {
  id: string;
  joinWebUrl?: string;
}

interface Transcript {
  id: string;
  createdDateTime?: string;
}

const MEET_CAP = 25;
const MEET_CURSOR_KEY = "ingest:meetings_cursor";
const LOOKBACK_HOURS = 48;
const HOUR_MS = 3_600_000;

export interface MeetingsProducerResult {
  users: number;
  transcripts: number;
  enqueued: number;
  failures: number;
  degraded: boolean;
}

export async function produceMeetings(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
  cap: number = MEET_CAP,
): Promise<MeetingsProducerResult> {
  const cursor = await loadCursor(env, MEET_CURSOR_KEY);
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users WHERE aad_id > ? ORDER BY aad_id LIMIT ?`,
  )
    .bind(cursor, cap)
    .all<{ aad_id: string }>();

  const result: MeetingsProducerResult = {
    users: rows.results.length,
    transcripts: 0,
    enqueued: 0,
    failures: 0,
    degraded: false,
  };

  const now = deps.now().getTime();
  const startIso = new Date(now - LOOKBACK_HOURS * HOUR_MS).toISOString();
  const endIso = new Date(now).toISOString();

  for (const row of rows.results) {
    if (result.degraded) break;
    try {
      await walkUserMeetings(env, row.aad_id, startIso, endIso, result, deps);
    } catch (e) {
      if (e instanceof GraphError && (e.status === 402 || e.status === 403)) {
        log.warn("ingest_meetings_degraded", {
          aadId: row.aad_id,
          status: e.status,
        });
        result.degraded = true;
        break;
      }
      if (e instanceof GraphError && e.status === 404) {
        log.debug("ingest_meetings_user_skipped", {
          aadId: row.aad_id,
          status: e.status,
        });
        continue;
      }
      result.failures += 1;
      log.warn("ingest_meetings_failed", {
        aadId: row.aad_id,
        error: String(e),
      });
    }
  }

  await saveCursor(
    env,
    MEET_CURSOR_KEY,
    rows.results.map((r) => r.aad_id),
    cap,
  );

  log.info("ingest_produced_meetings", result);
  return result;
}

async function walkUserMeetings(
  env: Env,
  aadId: string,
  startIso: string,
  endIso: string,
  result: MeetingsProducerResult,
  deps: ProducerDeps,
): Promise<void> {
  const { items: events } = await deps.graphAllPages<CalendarEvent>(
    env,
    {
      path: `/users/${aadId}/calendarView`,
      query: {
        startDateTime: startIso,
        endDateTime: endIso,
        $select: "id,subject,end,onlineMeeting,isOnlineMeeting,isCancelled",
        $orderby: "end/dateTime",
      },
    },
    { maxPages: 20 },
  );

  for (const ev of events) {
    if (ev.isCancelled) continue;
    const joinUrl = ev.onlineMeeting?.joinUrl;
    if (!joinUrl) continue;

    const { items: meetings } = await deps.graphAllPages<OnlineMeeting>(
      env,
      {
        path: `/users/${aadId}/onlineMeetings`,
        query: { $filter: `JoinWebUrl eq '${joinUrl}'` },
      },
      { maxPages: 2 },
    );
    const meeting = meetings[0];
    if (!meeting) continue;

    const { items: transcripts } = await deps.graphAllPages<Transcript>(
      env,
      { path: `/users/${aadId}/onlineMeetings/${meeting.id}/transcripts` },
      { maxPages: 5 },
    );

    for (const t of transcripts) {
      result.transcripts += 1;
      const content = await deps.graphText(env, {
        path: `/users/${aadId}/onlineMeetings/${meeting.id}/transcripts/${t.id}/content`,
        query: { $format: "text/vtt" },
      });
      if (!content.trim()) continue;

      const msg: IngestMessage = {
        source: "meeting_transcript",
        resourceId: t.id,
        body: { content, contentType: "text" },
        ownerAadId: aadId,
        scope: { resourceType: "user", resourceId: aadId },
        ...(ev.subject ? { title: ev.subject } : {}),
        ...(t.createdDateTime ? { lastModifiedAt: t.createdDateTime } : {}),
      };
      await deps.send(env, msg);
      result.enqueued += 1;
    }
  }
}
