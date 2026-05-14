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
