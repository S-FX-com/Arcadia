// Client-scoped status synthesis (Copilot-style cross-asset rollup).
//
// Given a Client and a viewer, federate across the Client's asset
// bundle (Teams channels + chats, Planner plan ids, SharePoint sites,
// Loop workspaces, Enque teams) and ask the AI router to compose a
// short, sectioned status report.
//
// What's pulled (today):
//   - Open + in-progress + blocked tasks owned by anyone, joined to
//     channels/chats in the Client's bundle
//   - Recent decisions in those channels/chats
//   - Stale threads in those channels
//   - Recent digests for the same channels (last 7 days)
//
// What lands later:
//   - SharePoint recent activity (when graph/search.ts ships)
//   - Planner item rollup (when planner-sync ships bidirectional read)
//   - Enque queue state (when the Enque repo wires in)

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import {
  ClientScopeResolver,
  ClientStore,
  isEmptyTeamsScope,
  type Client,
  type ClientScope,
} from "../clients";

export interface ClientStatusSection {
  title: string;
  bullets: string[];
}

export interface ClientStatus {
  client: Client;
  scope: ClientScope;
  generatedAt: string;
  summary: string;
  sections: ClientStatusSection[];
  counts: {
    openTasks: number;
    blockedTasks: number;
    decisionsLast7d: number;
    staleThreads: number;
    digestsLast7d: number;
  };
}

interface TaskRow {
  id: string;
  title: string;
  owner_display_name: string | null;
  deadline_at: string | null;
  priority: string;
  status: string;
}

interface DecisionRow {
  text: string;
  decided_at: string;
}

interface ThreadRow {
  topic: string | null;
  last_activity_at: string;
}

interface DigestRow {
  channel_display_name: string | null;
  posted_at: string;
}

const WINDOW_DAYS = 7;
const MAX_PER_LIST = 10;

export async function synthesizeClientStatus(
  env: Env,
  clientId: string,
  log: Logger,
): Promise<ClientStatus | null> {
  const store = new ClientStore(env);
  const client = await store.byId(clientId);
  if (!client) return null;

  const resolver = new ClientScopeResolver(env);
  const scope = await resolver.resolve(clientId);

  const cutoff = new Date(
    Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  const [openTasks, blockedTasks, decisions, staleThreads, recentDigests] =
    await Promise.all([
      fetchOpenTasks(env, scope, false),
      fetchOpenTasks(env, scope, true),
      fetchRecentDecisions(env, scope, cutoff),
      fetchStaleThreads(env, scope),
      fetchRecentDigests(env, scope, cutoff),
    ]);

  const sections: ClientStatusSection[] = [
    {
      title: "Open work",
      bullets: openTasks.map(formatTask),
    },
    {
      title: "Blocked",
      bullets: blockedTasks.map(formatTask),
    },
    {
      title: "Recent decisions",
      bullets: decisions.map((d) => `${d.text} — ${d.decided_at}`),
    },
    {
      title: "Stale threads",
      bullets: staleThreads.map(
        (t) =>
          `${t.topic ?? "(untitled thread)"} — quiet since ${t.last_activity_at}`,
      ),
    },
    {
      title: "Recent digests",
      bullets: recentDigests.map(
        (d) =>
          `${d.channel_display_name ?? "Channel"} — posted ${d.posted_at}`,
      ),
    },
  ];

  const summary = await composeSummary(env, client, scope, sections, log);

  return {
    client,
    scope,
    generatedAt: new Date().toISOString(),
    summary,
    sections,
    counts: {
      openTasks: openTasks.length,
      blockedTasks: blockedTasks.length,
      decisionsLast7d: decisions.length,
      staleThreads: staleThreads.length,
      digestsLast7d: recentDigests.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Federated D1 queries
// ---------------------------------------------------------------------------

async function fetchOpenTasks(
  env: Env,
  scope: ClientScope,
  blocked: boolean,
): Promise<TaskRow[]> {
  const channelClause = inClause("t.channel_id", scope.channelIds);
  const chatClause = inClause("t.chat_id", scope.chatIds);
  if (!channelClause && !chatClause) return [];

  const where = blocked
    ? "t.status = 'blocked'"
    : "t.status IN ('open','in_progress')";
  const scopeWhere = [channelClause?.sql, chatClause?.sql]
    .filter((s): s is string => Boolean(s))
    .join(" OR ");
  const binds = [
    ...(channelClause?.binds ?? []),
    ...(chatClause?.binds ?? []),
  ];

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT t.id, t.title, u.display_name AS owner_display_name,
            t.deadline_at, t.priority, t.status
       FROM tasks t
       LEFT JOIN users u ON u.aad_id = t.owner_aad_id
      WHERE ${where} AND (${scopeWhere})
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
        t.deadline_at IS NULL,
        t.deadline_at
      LIMIT ?`,
  )
    .bind(...binds, MAX_PER_LIST)
    .all<TaskRow>();
  return rows.results;
}

async function fetchRecentDecisions(
  env: Env,
  scope: ClientScope,
  cutoff: string,
): Promise<DecisionRow[]> {
  const channelClause = inClause("channel_id", scope.channelIds);
  if (!channelClause) return [];
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT text, decided_at
       FROM decisions
      WHERE ${channelClause.sql}
        AND decided_at >= ?
      ORDER BY decided_at DESC
      LIMIT ?`,
  )
    .bind(...channelClause.binds, cutoff, MAX_PER_LIST)
    .all<DecisionRow>();
  return rows.results;
}

async function fetchStaleThreads(
  env: Env,
  scope: ClientScope,
): Promise<ThreadRow[]> {
  const channelClause = inClause("channel_id", scope.channelIds);
  if (!channelClause) return [];
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT topic, last_activity_at
       FROM threads
      WHERE ${channelClause.sql}
        AND stale_at IS NOT NULL
      ORDER BY last_activity_at DESC
      LIMIT ?`,
  )
    .bind(...channelClause.binds, MAX_PER_LIST)
    .all<ThreadRow>();
  return rows.results;
}

async function fetchRecentDigests(
  env: Env,
  scope: ClientScope,
  cutoff: string,
): Promise<DigestRow[]> {
  const channelClause = inClause("d.channel_id", scope.channelIds);
  if (!channelClause) return [];
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT c.display_name AS channel_display_name, d.posted_at
       FROM digests d
       LEFT JOIN channels c ON c.channel_id = d.channel_id
      WHERE ${channelClause.sql}
        AND d.posted_at >= ?
      ORDER BY d.posted_at DESC
      LIMIT ?`,
  )
    .bind(...channelClause.binds, cutoff, MAX_PER_LIST)
    .all<DigestRow>();
  return rows.results;
}

// ---------------------------------------------------------------------------
// AI summary
// ---------------------------------------------------------------------------

async function composeSummary(
  env: Env,
  client: Client,
  scope: ClientScope,
  sections: ClientStatusSection[],
  log: Logger,
): Promise<string> {
  if (isEmptyTeamsScope(scope) && sections.every((s) => s.bullets.length === 0)) {
    return `${client.displayName} has no Teams assets attached yet, and no Arcadia signals to summarise.`;
  }

  const router = new Router(env);
  const corpus = sections
    .filter((s) => s.bullets.length > 0)
    .map((s) => `## ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");

  const basePrompt = `You are Arcadia, giving a fast status read on one Client.

Write a single tight paragraph (3–5 sentences) that:
- leads with the most important thing the operator should know,
- names blocked work and overdue items if any,
- mentions the most recent decision if it's load-bearing,
- closes with the one thing to push on next.

No bullets, no headers, no filler. Speak in your own voice.`;

  try {
    const system = await injectCharter(env, basePrompt);
    const reply = await router.complete({
      system,
      messages: [
        {
          role: "user",
          content: `Client: ${client.displayName} (${client.slug}).\n\nSignals:\n${corpus}`,
        },
      ],
      tier: "balanced",
      maxTokens: 400,
    });
    return reply.text.trim();
  } catch (e) {
    log.warn("client_status_summary_failed", {
      clientId: client.id,
      error: String(e),
    });
    return fallbackSummary(client, sections);
  }
}

function fallbackSummary(
  client: Client,
  sections: ClientStatusSection[],
): string {
  const counts = sections
    .filter((s) => s.bullets.length > 0)
    .map((s) => `${s.bullets.length} ${s.title.toLowerCase()}`)
    .join(", ");
  return counts
    ? `${client.displayName}: ${counts}.`
    : `${client.displayName}: nothing to surface.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InClause {
  sql: string;
  binds: string[];
}

function inClause(column: string, ids: string[]): InClause | null {
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(",");
  return { sql: `${column} IN (${placeholders})`, binds: [...ids] };
}

function formatTask(t: TaskRow): string {
  const parts: string[] = [t.title];
  const meta: string[] = [];
  if (t.owner_display_name) meta.push(t.owner_display_name);
  if (t.deadline_at) meta.push(`due ${t.deadline_at}`);
  meta.push(t.priority);
  meta.push(t.status);
  parts.push(`(${meta.join(" · ")})`);
  return parts.join(" ");
}
