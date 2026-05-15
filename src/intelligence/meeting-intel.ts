// Pre-meeting briefs + post-meeting wrap-ups.
//
// Pre-brief: for each meeting starting in PRE_WINDOW_MINUTES, write a
// short brief into the `briefs` table targeted at each attendee.
// Pre-brief covers: meeting subject, attendees, what Arcadia recalls
// about the topic, recent decisions touching it, open tasks tied to
// any attendee.
//
// Post-wrap: for each meeting that ended in the last
// POST_WINDOW_MINUTES, write a wrap-up. For now the wrap-up reads
// the meeting body preview and recent decisions; a follow-up commit
// pulls transcript via /onlineMeetings/{id}/transcripts.
//
// Idempotency: the briefs table has a (kind, target_id) shape but no
// uniqueness on the meeting id. We dedupe by checking for an
// existing brief with body containing the meeting id within a 12-hour
// window before inserting.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import { calendarView, type CalendarEvent } from "../graph/calendar";
import { MemoryStore } from "../memory/store";

const PRE_WINDOW_MINUTES = 30;
const POST_WINDOW_MINUTES = 60;

export interface MeetingIntelResult {
  preChecked: number;
  preWritten: number;
  postChecked: number;
  postWritten: number;
  failures: number;
}

interface UserRow {
  aad_id: string;
  tenant_id: string;
  display_name: string | null;
}

export async function runPreMeetingBriefs(
  env: Env,
  log: Logger,
): Promise<MeetingIntelResult> {
  return runCycle(env, log, "pre_meeting");
}

export async function runPostMeetingWrapups(
  env: Env,
  log: Logger,
): Promise<MeetingIntelResult> {
  return runCycle(env, log, "post_meeting");
}

async function runCycle(
  env: Env,
  log: Logger,
  kind: "pre_meeting" | "post_meeting",
): Promise<MeetingIntelResult> {
  const result: MeetingIntelResult = {
    preChecked: 0,
    preWritten: 0,
    postChecked: 0,
    postWritten: 0,
    failures: 0,
  };

  const users = await env.ARCADIA_DB.prepare(
    `SELECT aad_id, tenant_id, display_name FROM users
      WHERE last_seen_at IS NOT NULL
      ORDER BY last_seen_at DESC
      LIMIT 100`,
  ).all<UserRow>();

  const router = new Router(env);
  const window =
    kind === "pre_meeting"
      ? {
          startIso: new Date().toISOString(),
          endIso: new Date(Date.now() + PRE_WINDOW_MINUTES * 60_000).toISOString(),
        }
      : {
          startIso: new Date(Date.now() - POST_WINDOW_MINUTES * 60_000 * 2).toISOString(),
          endIso: new Date(Date.now()).toISOString(),
        };

  for (const u of users.results) {
    let events: CalendarEvent[];
    try {
      events = await calendarView(env, u.aad_id, window.startIso, window.endIso);
    } catch (e) {
      result.failures += 1;
      log.warn("meeting_calendar_failed", {
        userAadId: u.aad_id,
        error: String(e),
      });
      continue;
    }

    for (const event of events) {
      const inScope =
        kind === "pre_meeting"
          ? new Date(event.start.dateTime) > new Date()
          : new Date(event.end.dateTime) < new Date();
      if (!inScope) continue;
      if (kind === "pre_meeting") result.preChecked += 1;
      else result.postChecked += 1;

      try {
        const written = await writeBriefIfMissing(
          env,
          router,
          log,
          kind,
          u,
          event,
        );
        if (written) {
          if (kind === "pre_meeting") result.preWritten += 1;
          else result.postWritten += 1;
        }
      } catch (e) {
        result.failures += 1;
        log.warn("meeting_brief_failed", {
          eventId: event.id,
          userAadId: u.aad_id,
          error: String(e),
        });
      }
    }
  }

  log.info("meeting_intel", { kind, ...result });
  return result;
}

async function writeBriefIfMissing(
  env: Env,
  router: Router,
  log: Logger,
  kind: "pre_meeting" | "post_meeting",
  user: UserRow,
  event: CalendarEvent,
): Promise<boolean> {
  const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM briefs
       WHERE kind = ? AND target_kind = 'user' AND target_id = ?
         AND body LIKE ?
         AND posted_at >= ?
       LIMIT 1`,
  )
    .bind(kind, user.aad_id, `%${event.id}%`, since)
    .first<{ x: number }>();
  if (existing) return false;

  const body = await composeMeetingBrief(env, router, kind, user, event, log);

  await env.ARCADIA_DB.prepare(
    `INSERT INTO briefs (id, kind, target_kind, target_id, body, message_id, posted_at)
     VALUES (?, ?, 'user', ?, ?, NULL, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      kind,
      user.aad_id,
      body,
      new Date().toISOString(),
    )
    .run();
  return true;
}

async function composeMeetingBrief(
  env: Env,
  router: Router,
  kind: "pre_meeting" | "post_meeting",
  user: UserRow,
  event: CalendarEvent,
  log: Logger,
): Promise<string> {
  const subject = event.subject?.trim() || "(no subject)";
  const memory = new MemoryStore(env);
  const recalled = await memory
    .recall(`${subject}\n${event.bodyPreview ?? ""}`, {
      limit: 5,
      viewer: user.aad_id,
      tenantId: user.tenant_id,
    })
    .catch((e) => {
      log.warn("meeting_memory_failed", { error: String(e) });
      return [];
    });
  const memoryBlock = recalled
    .map((h) => `- (${h.memory.kind}) ${h.memory.content}`)
    .join("\n");

  const tasks = await env.ARCADIA_DB.prepare(
    `SELECT title, status, priority, deadline_at
       FROM tasks
      WHERE owner_aad_id = ?
        AND status IN ('open', 'in_progress', 'blocked')
      ORDER BY deadline_at IS NULL, deadline_at LIMIT 5`,
  )
    .bind(user.aad_id)
    .all<{ title: string; status: string; priority: string; deadline_at: string | null }>();
  const taskBlock = tasks.results
    .map(
      (t) =>
        `- [${t.status}] ${t.title}${t.deadline_at ? ` (due ${t.deadline_at})` : ""} [${t.priority}]`,
    )
    .join("\n");

  const attendees = (event.attendees ?? [])
    .map((a) => a.emailAddress?.name ?? a.emailAddress?.address ?? "")
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");

  const fallback =
    kind === "pre_meeting"
      ? `Pre-meeting: ${subject}. ${attendees ? `Attendees: ${attendees}.` : ""}${event.start.dateTime ? ` Starts ${event.start.dateTime}.` : ""}`
      : `Post-meeting: ${subject}. ${event.end.dateTime ? `Ended ${event.end.dateTime}.` : ""}`;

  try {
    const basePrompt =
      kind === "pre_meeting"
        ? "You are Arcadia. Write a tight 4–6 line pre-meeting brief. Lead with the goal of the meeting. Name what Arcadia recalls about the topic. Call out tasks the attendee owns that might surface. No headers, no filler."
        : "You are Arcadia. Write a tight 4–6 line post-meeting wrap-up. Lead with the outcome (best you can infer). Call out decisions made (if memory has them recently) and follow-ups expected. No headers, no filler.";
    const system = await injectCharter(env, basePrompt);
    const reply = await router.complete({
      system,
      messages: [
        {
          role: "user",
          content: `For ${user.display_name ?? user.aad_id}.
Meeting id: ${event.id}
Subject: ${subject}
Window: ${event.start.dateTime} → ${event.end.dateTime}
Attendees: ${attendees || "(unknown)"}
Body preview: ${event.bodyPreview ?? "(empty)"}

Recalled context:
${memoryBlock || "(nothing relevant)"}

Open tasks for this user:
${taskBlock || "(none)"}`,
        },
      ],
      tier: "balanced",
      maxTokens: 350,
    });
    // Embed the event id so future runs can dedupe.
    return `[meeting:${event.id}]\n${reply.text.trim()}`;
  } catch (e) {
    log.warn("meeting_compose_failed", {
      kind,
      eventId: event.id,
      error: String(e),
    });
    return `[meeting:${event.id}]\n${fallback}`;
  }
}
