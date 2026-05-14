// Daily channel digest.
//
// For each enabled channel:
//   1. Pull the last 24h of channel messages from Graph
//   2. Pull open tasks + recent decisions + stale threads for the channel
//   3. Ask the AI router to compose a structured digest
//   4. Persist to `digests` (so `digest_refresh` can re-render later)
//   5. Post the digestCard back to the channel via outbound bot send
//
// The cron entry is "0 8 * * *". One AI call per channel — guard with
// the digest cron hour so re-running idempotently within the same day
// doesn't double-post.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { digestCard, type DigestSection } from "../cards/digest";
import { listChannelMessages, type ChatMessage } from "../graph/messages";
import { postCard } from "../runtime/bot-outbound";

interface ChannelRow {
  channel_id: string;
  team_id: string;
  tenant_id: string;
  service_url: string;
  conversation_id: string | null;
  display_name: string | null;
}

interface TaskSummary {
  id: string;
  title: string;
  owner_display_name: string | null;
  deadline_at: string | null;
  priority: string;
  status: string;
}

interface DigestStoredBody {
  channelDisplayName: string;
  sections: DigestSection[];
}

export interface DigestRunResult {
  channelsConsidered: number;
  digestsPosted: number;
  failures: number;
}

const WINDOW_HOURS = 24;
const MAX_MESSAGES = 50;

export async function runDigestCycle(
  env: Env,
  log: Logger,
): Promise<DigestRunResult> {
  const channels = await env.ARCADIA_DB.prepare(
    `SELECT channel_id, team_id, tenant_id, service_url, conversation_id, display_name
       FROM channels
      WHERE enabled = 1`,
  ).all<ChannelRow>();

  const result: DigestRunResult = {
    channelsConsidered: channels.results.length,
    digestsPosted: 0,
    failures: 0,
  };

  for (const channel of channels.results) {
    try {
      if (await alreadyPostedToday(env, channel.channel_id)) {
        log.info("digest_skip_already_posted", {
          channelId: channel.channel_id,
        });
        continue;
      }
      await generateAndPost(env, channel, log);
      result.digestsPosted += 1;
    } catch (e) {
      result.failures += 1;
      log.error("digest_failed", {
        channelId: channel.channel_id,
        error: String(e),
      });
    }
  }

  log.info("digest_cycle", result);
  return result;
}

async function alreadyPostedToday(
  env: Env,
  channelId: string,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM digests
       WHERE channel_id = ?
         AND substr(posted_at, 1, 10) = ?
       LIMIT 1`,
  )
    .bind(channelId, today)
    .first<{ x: number }>();
  return row !== null;
}

async function generateAndPost(
  env: Env,
  channel: ChannelRow,
  log: Logger,
): Promise<void> {
  const messages = await fetchRecentMessages(env, channel, log);
  const openTasks = await fetchOpenTasks(env, channel.channel_id);
  const staleThreads = await fetchStaleThreads(env, channel.channel_id);
  const recentDecisions = await fetchRecentDecisions(env, channel.channel_id);

  const sections = await composeSections(
    env,
    channel,
    messages,
    openTasks,
    staleThreads,
    recentDecisions,
    log,
  );

  const id = crypto.randomUUID();
  const channelName = channel.display_name ?? "Channel";
  const stored: DigestStoredBody = {
    channelDisplayName: channelName,
    sections,
  };

  await env.ARCADIA_DB.prepare(
    `INSERT INTO digests (id, channel_id, body, message_id, posted_at)
     VALUES (?, ?, ?, NULL, ?)`,
  )
    .bind(id, channel.channel_id, JSON.stringify(stored), new Date().toISOString())
    .run();

  if (!channel.conversation_id) {
    log.warn("digest_no_conversation_id", { channelId: channel.channel_id });
    return;
  }

  const viewerAadIds = await fetchRecentViewers(env, channel.tenant_id);
  const card = digestCard({
    digestId: id,
    channelDisplayName: channelName,
    generatedAt: new Date().toISOString(),
    viewerAadIds,
    sections,
  });

  await postCard(
    env,
    {
      serviceUrl: channel.service_url,
      conversationId: channel.conversation_id,
    },
    card,
    log,
    { summary: `${channelName} — daily digest` },
  );
}

async function fetchRecentMessages(
  env: Env,
  channel: ChannelRow,
  log: Logger,
): Promise<ChatMessage[]> {
  try {
    const page = await listChannelMessages(env, channel.team_id, channel.channel_id, {
      top: MAX_MESSAGES,
    });
    const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000;
    return page.value.filter(
      (m) => new Date(m.createdDateTime).getTime() >= cutoff,
    );
  } catch (e) {
    log.warn("digest_graph_unavailable", {
      channelId: channel.channel_id,
      error: String(e),
    });
    return [];
  }
}

async function fetchOpenTasks(
  env: Env,
  channelId: string,
): Promise<TaskSummary[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT t.id, t.title, u.display_name AS owner_display_name,
            t.deadline_at, t.priority, t.status
       FROM tasks t
       LEFT JOIN users u ON u.aad_id = t.owner_aad_id
      WHERE t.channel_id = ?
        AND t.status IN ('open', 'in_progress', 'blocked')
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
        t.deadline_at IS NULL,
        t.deadline_at
      LIMIT 10`,
  )
    .bind(channelId)
    .all<TaskSummary>();
  return rows.results;
}

async function fetchStaleThreads(
  env: Env,
  channelId: string,
): Promise<{ topic: string | null; last_activity_at: string }[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT topic, last_activity_at
       FROM threads
      WHERE channel_id = ?
        AND stale_at IS NOT NULL
      ORDER BY last_activity_at DESC
      LIMIT 5`,
  )
    .bind(channelId)
    .all<{ topic: string | null; last_activity_at: string }>();
  return rows.results;
}

async function fetchRecentDecisions(
  env: Env,
  channelId: string,
): Promise<{ text: string; decided_at: string }[]> {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT text, decided_at
       FROM decisions
      WHERE channel_id = ?
        AND decided_at >= ?
      ORDER BY decided_at DESC
      LIMIT 5`,
  )
    .bind(channelId, cutoff)
    .all<{ text: string; decided_at: string }>();
  return rows.results;
}

async function fetchRecentViewers(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users
       WHERE tenant_id = ?
       ORDER BY COALESCE(last_seen_at, registered_at) DESC
       LIMIT 50`,
  )
    .bind(tenantId)
    .all<{ aad_id: string }>();
  return rows.results.map((r) => r.aad_id);
}

async function composeSections(
  env: Env,
  channel: ChannelRow,
  messages: ChatMessage[],
  openTasks: TaskSummary[],
  staleThreads: { topic: string | null; last_activity_at: string }[],
  recentDecisions: { text: string; decided_at: string }[],
  log: Logger,
): Promise<DigestSection[]> {
  const fixed: DigestSection[] = [
    {
      title: "Open tasks",
      items: openTasks.map((t) => ({
        text: t.title,
        subtitle: taskSubtitle(t),
      })),
    },
    {
      title: "Recent decisions",
      items: recentDecisions.map((d) => ({
        text: d.text,
        subtitle: d.decided_at,
      })),
    },
    {
      title: "Stale threads",
      items: staleThreads.map((t) => ({
        text: t.topic ?? "(untitled thread)",
        subtitle: `quiet since ${t.last_activity_at}`,
      })),
    },
  ];

  if (messages.length === 0) {
    return [
      {
        title: "Conversation",
        items: [{ text: "No new messages in the last 24h." }],
      },
      ...fixed,
    ];
  }

  const aiSection = await summarizeConversation(env, channel, messages, log);
  return [aiSection, ...fixed];
}

async function summarizeConversation(
  env: Env,
  channel: ChannelRow,
  messages: ChatMessage[],
  log: Logger,
): Promise<DigestSection> {
  const router = new Router(env);
  const transcript = messages
    .slice()
    .reverse()
    .map((m) => {
      const who =
        m.from?.user?.displayName ??
        m.from?.application?.displayName ??
        "unknown";
      const body = stripHtml(m.body.content).slice(0, 400);
      return `[${m.createdDateTime}] ${who}: ${body}`;
    })
    .join("\n");

  try {
    const reply = await router.complete({
      system:
        "You are Arcadia, summarising a Teams channel's last 24 hours. Output a short JSON object: {\"bullets\":[\"…\",\"…\"]}. Each bullet leads with the answer, names people when relevant, and is under 140 characters. 3 to 6 bullets. No filler.",
      messages: [
        {
          role: "user",
          content: `Channel: ${channel.display_name ?? channel.channel_id}\n\nTranscript:\n${transcript}`,
        },
      ],
      tier: "balanced",
      maxTokens: 500,
    });
    const bullets = parseBullets(reply.text);
    return {
      title: "Conversation",
      items: bullets.map((b) => ({ text: b })),
    };
  } catch (e) {
    log.warn("digest_summary_failed", {
      channelId: channel.channel_id,
      error: String(e),
    });
    return {
      title: "Conversation",
      items: [{ text: "Summary unavailable for this cycle." }],
    };
  }
}

function parseBullets(text: string): string[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        bullets?: unknown;
      };
      if (Array.isArray(parsed.bullets)) {
        return parsed.bullets
          .filter((b): b is string => typeof b === "string")
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
          .slice(0, 6);
      }
    } catch {
      // fall through to line split
    }
  }
  return trimmed
    .split("\n")
    .map((l) => l.replace(/^[\s\-\*•]+/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 6);
}

function taskSubtitle(t: TaskSummary): string {
  const parts: string[] = [];
  if (t.owner_display_name) parts.push(t.owner_display_name);
  if (t.deadline_at) parts.push(`due ${t.deadline_at}`);
  parts.push(t.priority);
  return parts.join(" · ");
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
