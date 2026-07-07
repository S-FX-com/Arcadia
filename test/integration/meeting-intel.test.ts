// Integration tests for post-meeting wrap-ups (EXECUTION-PLAN §Phase 3 item 5):
// src/intelligence/meeting-intel.ts runPostMeetingWrapups.
//
// The transcript PRODUCER already lands meeting transcripts as documents
// (source='meeting_transcript') chunked into document_chunks. These tests seed
// that state directly into the shared miniflare D1, then drive
// runPostMeetingWrapups with:
//   - an injected calendar seam returning canned ended meetings (no Graph),
//   - an injected fake Router returning a canned { summary, decisions,
//     actionItems } wrap-up (no AI),
//   - an injected empty MemoryStore (no Vectorize/Workers AI).
// The transcript-fetch and task-create seams use their real D1 defaults, so the
// test exercises transcript discovery + recordDecision + the task store end to
// end.
//
// Assertions:
//   1. a wrap-up brief is written for the transcript meeting,
//   2. the canned decisions are persisted to `decisions` (via recordDecision),
//   3. the canned action items become rows in `tasks` (owner resolved when the
//      name matches a users row, else unassigned),
//   4. a second run does NOT duplicate briefs, decisions, or tasks,
//   5. a meeting with no transcript still gets a body-preview wrap-up brief.
//
// All ids use an "mi-" prefix + a dedicated tenant so these aggregate counts
// can't be perturbed by rows other files write into the same shared D1.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import type { CompleteRequest, CompleteResponse } from "../../src/ai/types";
import type { CalendarEvent } from "../../src/graph/calendar";
import { MemoryStore } from "../../src/memory/store";
import {
  runPostMeetingWrapups,
  type MeetingIntelDeps,
} from "../../src/intelligence/meeting-intel";

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = "mi-tenant";
const ORGANIZER = "mi-user-organizer";
const ASSIGNEE = "mi-user-assignee";
const ORGANIZER_NAME = "Priya Nair";
const ASSIGNEE_NAME = "Tom Becker";

const TRANSCRIPT_SUBJECT = "Q3 Launch Sync";
const NO_TRANSCRIPT_SUBJECT = "Ad-hoc Hallway Chat";
const TRANSCRIPT_MEETING_ID = "mi-event-transcript";
const NO_TRANSCRIPT_MEETING_ID = "mi-event-plain";
const TRANSCRIPT_DOC_ID = "mi-doc-transcript";

const DECISION_A = "Ship the launch on Tuesday";
const DECISION_B = "Freeze scope after this week";
const ACTION_ASSIGNED = "Draft the launch checklist";
const ACTION_UNASSIGNED = "Book the retro room";

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

async function seedUsers(): Promise<void> {
  const db = testEnv.ARCADIA_DB;
  await db
    .prepare(
      `INSERT INTO users (aad_id, tenant_id, display_name, last_seen_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    )
    .bind(
      ORGANIZER,
      TENANT,
      ORGANIZER_NAME,
      minutesAgo(5),
      ASSIGNEE,
      TENANT,
      ASSIGNEE_NAME,
      minutesAgo(5),
    )
    .run();
}

async function seedTranscript(): Promise<void> {
  const db = testEnv.ARCADIA_DB;
  await db
    .prepare(
      `INSERT INTO documents
         (id, source, resource_id, owner_aad_id, title, last_modified_at, indexed_at)
       VALUES (?, 'meeting_transcript', ?, ?, ?, ?, ?)`,
    )
    .bind(
      TRANSCRIPT_DOC_ID,
      "mi-transcript-resource",
      ORGANIZER,
      TRANSCRIPT_SUBJECT,
      minutesAgo(10),
      minutesAgo(10),
    )
    .run();
  await db
    .prepare(
      `INSERT INTO document_chunks (id, document_id, ordinal, text)
       VALUES (?, ?, 0, ?), (?, ?, 1, ?)`,
    )
    .bind(
      "mi-chunk-0",
      TRANSCRIPT_DOC_ID,
      "Priya: Let's ship the launch on Tuesday.",
      "mi-chunk-1",
      TRANSCRIPT_DOC_ID,
      "Tom: I'll draft the checklist. We freeze scope after this week.",
    )
    .run();
}

function endedMeeting(id: string, subject: string): CalendarEvent {
  return {
    id,
    subject,
    bodyPreview: `${subject} agenda`,
    organizer: { emailAddress: { name: ORGANIZER_NAME, address: "priya@mi" } },
    attendees: [
      { emailAddress: { name: ORGANIZER_NAME, address: "priya@mi" } },
      { emailAddress: { name: ASSIGNEE_NAME, address: "tom@mi" } },
    ],
    start: { dateTime: minutesAgo(60), timeZone: "UTC" },
    end: { dateTime: minutesAgo(30), timeZone: "UTC" },
  };
}

// Fake Router: returns a canned structured wrap-up for the transcript path and
// a plain line for the fallback path (both parse fine for their consumers).
function fakeRouter(): Pick<
  { complete: (r: CompleteRequest) => Promise<CompleteResponse> },
  "complete"
> {
  const canned = JSON.stringify({
    summary: "We aligned on the Tuesday launch and locked scope.",
    decisions: [DECISION_A, DECISION_B],
    actionItems: [
      { title: ACTION_ASSIGNED, owner: ASSIGNEE_NAME },
      { title: ACTION_UNASSIGNED, owner: null },
    ],
  });
  return {
    complete: async (): Promise<CompleteResponse> => ({
      text: canned,
      model: "fake",
      tier: "deep",
    }),
  };
}

function deps(events: CalendarEvent[]): Partial<MeetingIntelDeps> {
  return {
    calendarView: async () => events,
    router: fakeRouter(),
    // Empty memory store — never touch Vectorize / Workers AI under miniflare.
    createMemoryStore: () => new MemoryStore(testEnv, async () => []),
  };
}

async function countDecisions(text: string): Promise<number> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM decisions WHERE text LIKE ? AND source_message_id = ?`,
  )
    .bind(`${text}%`, TRANSCRIPT_DOC_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countTasks(title: string): Promise<number> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE title = ?`,
  )
    .bind(title)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countBriefs(eventId: string): Promise<number> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM briefs
      WHERE kind = 'post_meeting' AND target_kind = 'user'
        AND target_id = ? AND body LIKE ?`,
  )
    .bind(ORGANIZER, `%${eventId}%`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("runPostMeetingWrapups (transcript intelligence)", () => {
  it("wraps up from a transcript: brief + decisions + tasks, idempotent, with body-preview fallback", async () => {
    await seedUsers();
    await seedTranscript();

    const events = [
      endedMeeting(TRANSCRIPT_MEETING_ID, TRANSCRIPT_SUBJECT),
      endedMeeting(NO_TRANSCRIPT_MEETING_ID, NO_TRANSCRIPT_SUBJECT),
    ];

    const result = await runPostMeetingWrapups(testEnv, log, deps(events));
    expect(result.failures).toBe(0);

    // 1. Wrap-up brief written for the transcript meeting.
    expect(await countBriefs(TRANSCRIPT_MEETING_ID)).toBe(1);

    // 5. No-transcript meeting still gets a (body-preview) wrap-up brief.
    expect(await countBriefs(NO_TRANSCRIPT_MEETING_ID)).toBe(1);

    // 2. Canned decisions persisted via recordDecision (provenance = doc id).
    expect(await countDecisions(DECISION_A)).toBe(1);
    expect(await countDecisions(DECISION_B)).toBe(1);

    // 3. Action items became tasks; owner resolved for the matching name.
    expect(await countTasks(ACTION_ASSIGNED)).toBe(1);
    expect(await countTasks(ACTION_UNASSIGNED)).toBe(1);
    const assigned = await testEnv.ARCADIA_DB.prepare(
      `SELECT owner_aad_id FROM tasks WHERE title = ?`,
    )
      .bind(ACTION_ASSIGNED)
      .first<{ owner_aad_id: string | null }>();
    expect(assigned?.owner_aad_id).toBe(ASSIGNEE);
    const unassigned = await testEnv.ARCADIA_DB.prepare(
      `SELECT owner_aad_id FROM tasks WHERE title = ?`,
    )
      .bind(ACTION_UNASSIGNED)
      .first<{ owner_aad_id: string | null }>();
    expect(unassigned?.owner_aad_id).toBeNull();

    // 4. Re-run does NOT duplicate briefs, decisions, or tasks.
    const rerun = await runPostMeetingWrapups(testEnv, log, deps(events));
    expect(rerun.failures).toBe(0);

    expect(await countBriefs(TRANSCRIPT_MEETING_ID)).toBe(1);
    expect(await countBriefs(NO_TRANSCRIPT_MEETING_ID)).toBe(1);
    expect(await countDecisions(DECISION_A)).toBe(1);
    expect(await countDecisions(DECISION_B)).toBe(1);
    expect(await countTasks(ACTION_ASSIGNED)).toBe(1);
    expect(await countTasks(ACTION_UNASSIGNED)).toBe(1);
  });
});
