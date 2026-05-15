// Decision extraction.
//
// Walks recent channel + chat messages and asks the AI router which
// utterances actually represent decisions ("we'll ship Tuesday",
// "let's go with Postgres", "I'll own onboarding") versus chatter.
// Confirmed decisions are persisted to the `decisions` table with
// provenance back to the source message and the speaker.
//
// Runs incrementally — picks up where it left off via a delta cursor
// in delta_state keyed by (resource='decision_scan', scope_key).
//
// Entry point: extractDecisions(env, log). Wire into the daily cron
// alongside the digest cycle (so the digest can read fresh decisions).

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import { listChannelMessages, listChatMessages } from "../graph/messages";
import type { ChatMessage } from "../graph/messages";

const RESOURCE = "decision_scan";
const WINDOW_HOURS = 72;
const MIN_TEXT_LENGTH = 25;

export interface DecisionRunResult {
  channelsScanned: number;
  chatsScanned: number;
  candidatesExamined: number;
  decisionsRecorded: number;
  failures: number;
}

interface DecisionCandidate {
  speaker: string;
  text: string;
  decided_at: string;
  source_message_id: string;
  confidence: number;
}

const SYSTEM_PROMPT = `You are scanning a Teams message log for *decisions*.

A decision is something the speaker is committing to or instructing
others to do — a clear "we will X", "let's go with Y", "I'll own Z".

NOT decisions: questions, opinions, status updates, expressions of
preference without commitment, FYI messages, jokes.

For each speaker turn, emit JSON:
  { "decisions": [
      { "speaker": "<name>", "text": "<≤140 char paraphrase, present tense>",
        "source_message_id": "<id>", "confidence": 0.0-1.0 }
    ] }

confidence ≥ 0.8 means "obvious decision". Default to 0.0 if unsure.
Output strict JSON only, no prose.`;

export async function extractDecisions(
  env: Env,
  log: Logger,
): Promise<DecisionRunResult> {
  const result: DecisionRunResult = {
    channelsScanned: 0,
    chatsScanned: 0,
    candidatesExamined: 0,
    decisionsRecorded: 0,
    failures: 0,
  };

  const channels = await env.ARCADIA_DB.prepare(
    `SELECT channel_id, team_id FROM channels WHERE enabled = 1`,
  ).all<{ channel_id: string; team_id: string }>();
  for (const c of channels.results) {
    try {
      const added = await scanChannel(env, c.team_id, c.channel_id, log);
      result.candidatesExamined += added.examined;
      result.decisionsRecorded += added.recorded;
      result.channelsScanned += 1;
    } catch (e) {
      result.failures += 1;
      log.warn("decisions_channel_failed", {
        channelId: c.channel_id,
        error: String(e),
      });
    }
  }

  const chats = await env.ARCADIA_DB.prepare(
    `SELECT chat_id FROM chats`,
  ).all<{ chat_id: string }>();
  for (const chat of chats.results) {
    try {
      const added = await scanChat(env, chat.chat_id, log);
      result.candidatesExamined += added.examined;
      result.decisionsRecorded += added.recorded;
      result.chatsScanned += 1;
    } catch (e) {
      result.failures += 1;
      log.warn("decisions_chat_failed", {
        chatId: chat.chat_id,
        error: String(e),
      });
    }
  }

  log.info("decisions_extracted", result);
  return result;
}

interface ScanAdded {
  examined: number;
  recorded: number;
}

async function scanChannel(
  env: Env,
  teamId: string,
  channelId: string,
  log: Logger,
): Promise<ScanAdded> {
  const since = await readCursor(env, channelKey(channelId));
  const cutoff = since ?? olderCutoff();
  const page = await listChannelMessages(env, teamId, channelId, { top: 50 });
  const fresh = page.value.filter((m) => m.createdDateTime > cutoff);
  if (fresh.length === 0) return { examined: 0, recorded: 0 };

  const added = await analyseAndPersist(env, fresh, channelId, null, log);

  const newCursor = fresh[0]?.createdDateTime;
  if (newCursor) await writeCursor(env, channelKey(channelId), newCursor);
  return added;
}

async function scanChat(
  env: Env,
  chatId: string,
  log: Logger,
): Promise<ScanAdded> {
  const since = await readCursor(env, chatKey(chatId));
  const cutoff = since ?? olderCutoff();
  const page = await listChatMessages(env, chatId, { top: 50 });
  const fresh = page.value.filter((m) => m.createdDateTime > cutoff);
  if (fresh.length === 0) return { examined: 0, recorded: 0 };

  const added = await analyseAndPersist(env, fresh, null, chatId, log);
  const newCursor = fresh[0]?.createdDateTime;
  if (newCursor) await writeCursor(env, chatKey(chatId), newCursor);
  return added;
}

async function analyseAndPersist(
  env: Env,
  messages: ChatMessage[],
  channelId: string | null,
  _chatId: string | null,
  log: Logger,
): Promise<ScanAdded> {
  // Build a transcript bounded to messages with substantive text.
  const lines: string[] = [];
  const speakerById = new Map<string, string | undefined>();
  for (const m of messages) {
    const body = stripHtml(m.body.content);
    if (body.length < MIN_TEXT_LENGTH) continue;
    const speaker = m.from?.user?.displayName ?? "unknown";
    speakerById.set(m.id, m.from?.user?.id);
    lines.push(`[${m.id}] ${speaker}: ${body}`);
  }

  if (lines.length === 0) return { examined: 0, recorded: 0 };

  const router = new Router(env);
  let raw: string;
  try {
    const system = await injectCharter(env, SYSTEM_PROMPT);
    const reply = await router.complete({
      system,
      messages: [{ role: "user", content: lines.join("\n") }],
      tier: "balanced",
      maxTokens: 800,
      temperature: 0,
    });
    raw = reply.text;
  } catch (e) {
    log.warn("decisions_router_failed", { error: String(e) });
    return { examined: lines.length, recorded: 0 };
  }

  const parsed = parseDecisions(raw);
  if (!parsed) return { examined: lines.length, recorded: 0 };

  let recorded = 0;
  for (const candidate of parsed) {
    if (candidate.confidence < 0.8) continue;
    const referenced = messages.find((m) => m.id === candidate.source_message_id);
    if (!referenced) continue;
    const decidedBy = speakerById.get(referenced.id) ?? null;
    await env.ARCADIA_DB.prepare(
      `INSERT INTO decisions
         (id, channel_id, thread_id, text, decided_at, decided_by_aad_id,
          source_message_id, confidence)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        channelId,
        candidate.text.slice(0, 240),
        referenced.createdDateTime,
        decidedBy,
        referenced.id,
        candidate.confidence,
      )
      .run();
    recorded += 1;
  }

  return { examined: lines.length, recorded };
}

function parseDecisions(raw: string): DecisionCandidate[] | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as {
      decisions?: unknown;
    };
    if (!Array.isArray(obj.decisions)) return null;
    const out: DecisionCandidate[] = [];
    for (const d of obj.decisions) {
      if (!d || typeof d !== "object") continue;
      const r = d as Record<string, unknown>;
      const speaker = typeof r.speaker === "string" ? r.speaker : "";
      const text = typeof r.text === "string" ? r.text : "";
      const source =
        typeof r.source_message_id === "string"
          ? r.source_message_id
          : "";
      const confidence =
        typeof r.confidence === "number"
          ? Math.max(0, Math.min(1, r.confidence))
          : 0;
      if (!text || !source) continue;
      out.push({
        speaker,
        text,
        decided_at: new Date().toISOString(),
        source_message_id: source,
        confidence,
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function readCursor(env: Env, scopeKey: string): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(RESOURCE, scopeKey)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

async function writeCursor(
  env: Env,
  scopeKey: string,
  cursor: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state
       (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(RESOURCE, scopeKey, cursor, new Date().toISOString())
    .run();
}

function olderCutoff(): string {
  return new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
}

function channelKey(channelId: string): string {
  return `channel:${channelId}`;
}

function chatKey(chatId: string): string {
  return `chat:${chatId}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
