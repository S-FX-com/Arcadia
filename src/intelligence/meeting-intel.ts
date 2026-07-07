// Pre-meeting briefs + post-meeting wrap-ups.
//
// Pre-brief: for each meeting starting in PRE_WINDOW_MINUTES, write a
// short brief into the `briefs` table targeted at each attendee.
// Pre-brief covers: meeting subject, attendees, what Arcadia recalls
// about the topic, recent decisions touching it, open tasks tied to
// any attendee.
//
// Post-wrap: for each meeting that ended in the last
// POST_WINDOW_MINUTES, write a wrap-up. The wrap-up prefers the meeting
// *transcript* (ingested by src/ingest/producers/meetings.ts as a
// document with source='meeting_transcript', chunked into
// document_chunks). We locate the transcript by a direct D1 query
// (recent + title/owner match), stitch its chunk text back together,
// and feed it — plus recent decisions on record — into a deep-tier,
// charter-injected wrap-up prompt that returns { summary, decisions[],
// actionItems[] }. Decisions are persisted via recordDecision() and
// action items become tasks via the task store. When no transcript is
// found we fall back to the older body-preview wrap-up.
//
// Idempotency has two layers:
//   - Briefs: the briefs table has no uniqueness on meeting id, so we
//     dedupe by checking for an existing brief whose body contains the
//     meeting id within a 12-hour window before inserting.
//   - Extraction: decisions + tasks are extracted once per transcript.
//     A marker row in delta_state (resource='meeting_wrapup', keyed by
//     the transcript document id) guards against re-extraction on the
//     next cycle.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import { calendarView, type CalendarEvent } from "../graph/calendar";
import { MemoryStore } from "../memory/store";
import { TaskStore } from "../tasks/store";
import type { NewTask, Task } from "../tasks/types";
import { recordDecision } from "./decisions";

const PRE_WINDOW_MINUTES = 30;
const POST_WINDOW_MINUTES = 60;
// How far back a transcript document may have been indexed/modified and
// still be considered "this meeting's" transcript. Aligned with the
// meeting-transcript producer's 48h lookback.
const TRANSCRIPT_RECENT_HOURS = 48;
// Decisions extracted from a transcript are attributed with this fixed
// confidence — they are model-summarised, not verbatim commitments.
const TRANSCRIPT_DECISION_CONFIDENCE = 0.8;
const WRAPUP_MARKER_RESOURCE = "meeting_wrapup";

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

export interface MeetingTranscript {
  documentId: string;
  text: string;
}

interface WrapupResult {
  summary: string;
  decisions: string[];
  actionItems: { title: string; owner: string | null }[];
}

// ---------------------------------------------------------------------------
// Injectable seam — mirrors OrgPulseDeps (src/intelligence/org-pulse.ts) and
// NudgeDeps (src/intelligence/nudge.ts). Integration tests substitute the
// calendar walk (Graph), the Router (AI), and — if they wish — the transcript
// fetch, task creation, and memory recall, so the cycle runs against nothing
// but the shared miniflare D1.
// ---------------------------------------------------------------------------

export interface MeetingIntelDeps {
  calendarView: (
    env: Env,
    userAadId: string,
    startIso: string,
    endIso: string,
  ) => Promise<CalendarEvent[]>;
  router: Pick<Router, "complete">;
  createTask: (env: Env, input: NewTask) => Promise<Pick<Task, "id">>;
  fetchTranscript: (
    env: Env,
    event: CalendarEvent,
    user: UserRow,
  ) => Promise<MeetingTranscript | null>;
  createMemoryStore: (env: Env) => Pick<MemoryStore, "recall">;
}

function resolveDeps(
  env: Env,
  deps?: Partial<MeetingIntelDeps>,
): MeetingIntelDeps {
  return {
    calendarView: deps?.calendarView ?? calendarView,
    router: deps?.router ?? new Router(env),
    createTask:
      deps?.createTask ??
      ((e, input) => new TaskStore(e).create(input, "meeting_intel")),
    fetchTranscript: deps?.fetchTranscript ?? defaultFetchTranscript,
    createMemoryStore: deps?.createMemoryStore ?? ((e) => new MemoryStore(e)),
  };
}

export async function runPreMeetingBriefs(
  env: Env,
  log: Logger,
  deps?: Partial<MeetingIntelDeps>,
): Promise<MeetingIntelResult> {
  return runCycle(env, log, "pre_meeting", resolveDeps(env, deps));
}

export async function runPostMeetingWrapups(
  env: Env,
  log: Logger,
  deps?: Partial<MeetingIntelDeps>,
): Promise<MeetingIntelResult> {
  return runCycle(env, log, "post_meeting", resolveDeps(env, deps));
}

async function runCycle(
  env: Env,
  log: Logger,
  kind: "pre_meeting" | "post_meeting",
  deps: MeetingIntelDeps,
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
      events = await deps.calendarView(
        env,
        u.aad_id,
        window.startIso,
        window.endIso,
      );
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
        const written =
          kind === "pre_meeting"
            ? await writePreBriefIfMissing(env, deps, log, u, event)
            : await writePostWrapup(env, deps, log, u, event);
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

// ---------------------------------------------------------------------------
// Pre-meeting brief
// ---------------------------------------------------------------------------

async function writePreBriefIfMissing(
  env: Env,
  deps: MeetingIntelDeps,
  log: Logger,
  user: UserRow,
  event: CalendarEvent,
): Promise<boolean> {
  if (await briefExists(env, "pre_meeting", user.aad_id, event.id)) return false;

  const body = await composeMeetingBrief(
    env,
    deps,
    "pre_meeting",
    user,
    event,
    log,
  );
  await insertBrief(env, "pre_meeting", user.aad_id, body);
  return true;
}

// ---------------------------------------------------------------------------
// Post-meeting wrap-up (transcript-driven, with body-preview fallback)
// ---------------------------------------------------------------------------

async function writePostWrapup(
  env: Env,
  deps: MeetingIntelDeps,
  log: Logger,
  user: UserRow,
  event: CalendarEvent,
): Promise<boolean> {
  const transcript = await deps.fetchTranscript(env, event, user).catch((e) => {
    log.warn("meeting_transcript_fetch_failed", {
      eventId: event.id,
      error: String(e),
    });
    return null;
  });

  // No transcript → fall back to the older body-preview wrap-up.
  if (!transcript) {
    if (await briefExists(env, "post_meeting", user.aad_id, event.id)) {
      return false;
    }
    const body = await composeMeetingBrief(
      env,
      deps,
      "post_meeting",
      user,
      event,
      log,
    );
    await insertBrief(env, "post_meeting", user.aad_id, body);
    return true;
  }

  const subject = event.subject?.trim() || "(no subject)";
  const organizerName =
    event.organizer?.emailAddress?.name ??
    event.organizer?.emailAddress?.address ??
    user.display_name ??
    user.aad_id;

  const wrap = await composeTranscriptWrapup(
    env,
    deps.router,
    user,
    event,
    subject,
    organizerName,
    transcript.text,
    log,
  );

  // Extraction is per-transcript, not per-attendee: persist decisions +
  // tasks exactly once, guarded by a delta_state marker keyed by the
  // transcript document id.
  if (!(await transcriptProcessed(env, transcript.documentId))) {
    await persistExtractions(
      env,
      deps,
      user,
      event,
      subject,
      organizerName,
      transcript,
      wrap,
      log,
    );
    await markTranscriptProcessed(env, transcript.documentId);
  }

  // Brief is per-attendee and deduped by meeting id in body.
  if (await briefExists(env, "post_meeting", user.aad_id, event.id)) {
    return false;
  }
  const summary =
    wrap.summary.trim().length > 0
      ? wrap.summary.trim()
      : `Post-meeting: ${subject}. Transcript processed.`;
  await insertBrief(env, "post_meeting", user.aad_id, `[meeting:${event.id}]\n${summary}`);
  return true;
}

async function persistExtractions(
  env: Env,
  deps: MeetingIntelDeps,
  user: UserRow,
  event: CalendarEvent,
  subject: string,
  organizerName: string,
  transcript: MeetingTranscript,
  wrap: WrapupResult,
  log: Logger,
): Promise<void> {
  const roster = await loadRoster(env, user.tenant_id);
  const decidedAt = event.end.dateTime || new Date().toISOString();
  const decider = resolveOwner(organizerName, roster) ?? user.aad_id;

  for (const d of wrap.decisions) {
    const text = d.trim();
    if (!text) continue;
    // No channel linkage from a calendar event → null channel, organizer
    // noted in the decision text (recordDecision slices to 240 chars).
    await recordDecision(env, {
      channelId: null,
      text: `${text} — from "${subject}" (organizer: ${organizerName})`,
      decidedAt,
      decidedByAadId: decider,
      sourceMessageId: transcript.documentId,
      confidence: TRANSCRIPT_DECISION_CONFIDENCE,
    });
  }

  for (const item of wrap.actionItems) {
    const title = item.title.trim().slice(0, 160);
    if (!title) continue;
    const owner = item.owner ? resolveOwner(item.owner, roster) : undefined;
    const input: NewTask = {
      title,
      priority: "normal",
      description: `From meeting "${subject}".`,
      createdByAadId: decider,
      ...(owner ? { ownerAadId: owner } : {}),
    };
    await deps.createTask(env, input);
  }

  log.info("meeting_wrapup_extracted", {
    eventId: event.id,
    documentId: transcript.documentId,
    decisions: wrap.decisions.length,
    actionItems: wrap.actionItems.length,
  });
}

// ---------------------------------------------------------------------------
// Transcript discovery (default D1 path — no Graph)
// ---------------------------------------------------------------------------

async function defaultFetchTranscript(
  env: Env,
  event: CalendarEvent,
  user: UserRow,
): Promise<MeetingTranscript | null> {
  const subject = event.subject?.trim() ?? "";
  const cutoff = new Date(
    Date.now() - TRANSCRIPT_RECENT_HOURS * 3600 * 1000,
  ).toISOString();

  // Recent meeting_transcript document whose title matches the subject OR
  // whose owner is the calendar owner (the transcript producer scopes each
  // transcript to the aad whose calendar it walked).
  const doc = await env.ARCADIA_DB.prepare(
    `SELECT id FROM documents
       WHERE source = 'meeting_transcript'
         AND (COALESCE(last_modified_at, indexed_at) >= ?)
         AND ((? <> '' AND title = ?) OR owner_aad_id = ?)
       ORDER BY COALESCE(last_modified_at, indexed_at) DESC
       LIMIT 1`,
  )
    .bind(cutoff, subject, subject, user.aad_id)
    .first<{ id: string }>();
  if (!doc) return null;

  const chunks = await env.ARCADIA_DB.prepare(
    `SELECT text FROM document_chunks
       WHERE document_id = ?
       ORDER BY ordinal ASC`,
  )
    .bind(doc.id)
    .all<{ text: string }>();
  const text = chunks.results.map((c) => c.text).join("\n").trim();
  if (!text) return null;

  return { documentId: doc.id, text };
}

// ---------------------------------------------------------------------------
// AI composition
// ---------------------------------------------------------------------------

const WRAPUP_SYSTEM_PROMPT = `You are Arcadia, writing a post-meeting wrap-up from a transcript.

Return STRICT JSON only, nothing outside it:

{
  "summary": "<4-6 line wrap-up: lead with the outcome, then the key points and follow-ups>",
  "decisions": ["<each decision as one short present-tense sentence>"],
  "actionItems": [ { "title": "<imperative task, leads with the verb>", "owner": "<attendee display name or null>" } ]
}

Only include decisions and action items actually supported by the transcript.
Be conservative — better to omit than to invent. No prose outside the JSON.`;

async function composeTranscriptWrapup(
  env: Env,
  router: Pick<Router, "complete">,
  user: UserRow,
  event: CalendarEvent,
  subject: string,
  organizerName: string,
  transcriptText: string,
  log: Logger,
): Promise<WrapupResult> {
  const recent = await recentDecisionsBlock(env);
  try {
    const system = await injectCharter(env, WRAPUP_SYSTEM_PROMPT);
    const reply = await router.complete({
      system,
      messages: [
        {
          role: "user",
          content: `Meeting: ${subject}
Organizer: ${organizerName}
Ended: ${event.end.dateTime}

Recent decisions on record:
${recent || "(none)"}

Transcript:
${transcriptText}`,
        },
      ],
      tier: "deep",
      maxTokens: 1200,
      temperature: 0,
    });
    return parseWrapup(reply.text);
  } catch (e) {
    log.warn("meeting_wrapup_compose_failed", {
      eventId: event.id,
      userAadId: user.aad_id,
      error: String(e),
    });
    return { summary: "", decisions: [], actionItems: [] };
  }
}

function parseWrapup(raw: string): WrapupResult {
  const empty: WrapupResult = { summary: "", decisions: [], actionItems: [] };
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as {
      summary?: unknown;
      decisions?: unknown;
      actionItems?: unknown;
    };
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const decisions = Array.isArray(obj.decisions)
      ? obj.decisions.filter((d): d is string => typeof d === "string")
      : [];
    const actionItems: WrapupResult["actionItems"] = [];
    if (Array.isArray(obj.actionItems)) {
      for (const a of obj.actionItems) {
        if (!a || typeof a !== "object") continue;
        const r = a as Record<string, unknown>;
        const title = typeof r.title === "string" ? r.title : "";
        if (!title) continue;
        const owner = typeof r.owner === "string" && r.owner ? r.owner : null;
        actionItems.push({ title, owner });
      }
    }
    return { summary, decisions, actionItems };
  } catch {
    return empty;
  }
}

async function recentDecisionsBlock(env: Env): Promise<string> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT text, decided_at FROM decisions
      ORDER BY decided_at DESC LIMIT 8`,
  ).all<{ text: string; decided_at: string }>();
  return rows.results.map((r) => `- ${r.text} (${r.decided_at})`).join("\n");
}

// The original body-preview brief composer. Still used for pre-meeting
// briefs and for the post-meeting fallback when no transcript is found.
async function composeMeetingBrief(
  env: Env,
  deps: MeetingIntelDeps,
  kind: "pre_meeting" | "post_meeting",
  user: UserRow,
  event: CalendarEvent,
  log: Logger,
): Promise<string> {
  const subject = event.subject?.trim() || "(no subject)";
  const memory = deps.createMemoryStore(env);
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
    const reply = await deps.router.complete({
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

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function briefExists(
  env: Env,
  kind: "pre_meeting" | "post_meeting",
  targetId: string,
  eventId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM briefs
       WHERE kind = ? AND target_kind = 'user' AND target_id = ?
         AND body LIKE ?
         AND posted_at >= ?
       LIMIT 1`,
  )
    .bind(kind, targetId, `%${eventId}%`, since)
    .first<{ x: number }>();
  return existing !== null;
}

async function insertBrief(
  env: Env,
  kind: "pre_meeting" | "post_meeting",
  targetId: string,
  body: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO briefs (id, kind, target_kind, target_id, body, message_id, posted_at)
     VALUES (?, ?, 'user', ?, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), kind, targetId, body, new Date().toISOString())
    .run();
}

async function transcriptProcessed(
  env: Env,
  documentId: string,
): Promise<boolean> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM delta_state WHERE resource = ? AND scope_key = ? LIMIT 1`,
  )
    .bind(WRAPUP_MARKER_RESOURCE, documentId)
    .first<{ x: number }>();
  return row !== null;
}

async function markTranscriptProcessed(
  env: Env,
  documentId: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state
       (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      WRAPUP_MARKER_RESOURCE,
      documentId,
      documentId,
      new Date().toISOString(),
    )
    .run();
}

async function loadRoster(
  env: Env,
  tenantId: string,
): Promise<Map<string, string>> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT aad_id, display_name FROM users
      WHERE tenant_id = ? AND display_name IS NOT NULL`,
  )
    .bind(tenantId)
    .all<{ aad_id: string; display_name: string | null }>();
  const map = new Map<string, string>();
  for (const r of rows.results) {
    if (r.display_name) map.set(r.display_name.toLowerCase(), r.aad_id);
  }
  return map;
}

function resolveOwner(
  name: string,
  roster: Map<string, string>,
): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return roster.get(key);
}
