// Bot Framework outbound helpers.
//
// Both reactive replies (from /api/messages → handleMessage) and
// proactive sends (cron-driven digests, nudges, briefs) ultimately POST
// to the conversation's serviceUrl with a Bot Framework token. This
// module owns the token cache and the conversation-targeted POSTs so
// callers don't have to know about either.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import type { AdaptiveCard } from "../cards/types";

const TOKEN_KEY = "bot_outbound_token";
const TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Acquires an outbound Bot Framework token, cached in KV. */
export async function acquireBotToken(env: Env): Promise<string> {
  const cached = await env.ARCADIA_CACHE.get(TOKEN_KEY);
  if (cached) return cached;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.TEAMS_APP_ID,
    client_secret: env.TEAMS_APP_PASSWORD,
    scope: "https://api.botframework.com/.default",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`bot_token_${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as TokenResponse;
  await env.ARCADIA_CACHE.put(TOKEN_KEY, json.access_token, {
    expirationTtl: Math.max(60, json.expires_in - 300),
  });
  return json.access_token;
}

export interface ConversationRef {
  serviceUrl: string;
  conversationId: string;
}

export interface BotActor {
  id: string;
  name?: string;
}

/** POST a card-only message to a conversation (proactive send). */
export async function postCard(
  env: Env,
  ref: ConversationRef,
  card: AdaptiveCard,
  log: Logger,
  opts: { from?: BotActor; summary?: string } = {},
): Promise<void> {
  const from: BotActor = opts.from ?? { id: env.TEAMS_APP_ID, name: "Arcadia" };
  const body = {
    type: "message",
    from,
    summary: opts.summary,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
  };
  await sendToConversation(env, ref, body, log);
}

/** POST a plain text message to a conversation (proactive send). */
export async function postText(
  env: Env,
  ref: ConversationRef,
  text: string,
  log: Logger,
  opts: { from?: BotActor } = {},
): Promise<void> {
  const from: BotActor = opts.from ?? { id: env.TEAMS_APP_ID, name: "Arcadia" };
  const body = { type: "message", from, text };
  await sendToConversation(env, ref, body, log);
}

/**
 * Resolve or create a 1:1 bot conversation with `userAadId`. The
 * conversation id is cached in KV under `dm:<aadId>` so subsequent
 * deliveries reuse it.
 *
 * Returns null if we have no serviceUrl to bind against — that means
 * the bot has never seen activity from this tenant and can't reach
 * any user yet.
 */
export async function getOrCreateUserDm(
  env: Env,
  userAadId: string,
  tenantId: string,
  log: Logger,
): Promise<ConversationRef | null> {
  const cacheKey = `dm:${userAadId}`;
  const cached = await env.ARCADIA_CACHE.get(cacheKey, { type: "json" });
  if (cached && typeof cached === "object") {
    const c = cached as ConversationRef;
    if (c.serviceUrl && c.conversationId) return c;
  }

  const channel = await env.ARCADIA_DB.prepare(
    `SELECT service_url FROM channels
      WHERE tenant_id = ?
      ORDER BY COALESCE(last_seen_at, registered_at) DESC
      LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ service_url: string }>();
  if (!channel?.service_url) {
    log.warn("dm_no_service_url", { tenantId });
    return null;
  }

  try {
    const conversationId = await createDirectConversation(
      env,
      channel.service_url,
      tenantId,
      userAadId,
    );
    const ref: ConversationRef = {
      serviceUrl: channel.service_url,
      conversationId,
    };
    await env.ARCADIA_CACHE.put(cacheKey, JSON.stringify(ref), {
      expirationTtl: 14 * 24 * 3600,
    });
    return ref;
  } catch (e) {
    log.warn("dm_create_failed", { userAadId, error: String(e) });
    return null;
  }
}

async function createDirectConversation(
  env: Env,
  serviceUrl: string,
  tenantId: string,
  userAadId: string,
): Promise<string> {
  const token = await acquireBotToken(env);
  const base = serviceUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v3/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      bot: { id: env.TEAMS_APP_ID, name: "Arcadia" },
      members: [{ id: userAadId }],
      channelData: { tenant: { id: tenantId } },
      isGroup: false,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `create_conversation_${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("create_conversation_no_id");
  return json.id;
}

async function sendToConversation(
  env: Env,
  ref: ConversationRef,
  body: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  const token = await acquireBotToken(env);
  const base = ref.serviceUrl.replace(/\/$/, "");
  const url = `${base}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    log.error("bot_post_failed", {
      status: res.status,
      conversationId: ref.conversationId,
      body: text.slice(0, 200),
    });
    throw new Error(`bot_post_${res.status}`);
  }
}
