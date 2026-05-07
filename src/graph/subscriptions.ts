// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — Microsoft Graph Change Notification Subscriptions
//
// Manages subscriptions to Teams channel message events.
// Key constraints:
//   - Teams subscriptions expire after max 60 minutes
//   - Must renew every ~55 minutes to stay active
//   - Validation: Graph POSTs ?validationToken=<token> during subscription creation
//     → must echo back as text/plain, 200 OK
//   - No includeResourceData (avoids certificate encryption complexity)
//     → fetch message content from Graph on each notification
// ─────────────────────────────────────────────────────────────────────────────

import { graphGet, graphPost } from "./client.js";
import { GRAPH } from "../constants.js";
import {
  upsertGraphSubscription,
  getExpiringSubscriptions,
  getSubscriptionById,
  deleteGraphSubscription,
  getSubscriptionForChannel,
} from "../tasks/store.js";
import { cacheMessages } from "../memory/kv.js";
import type {
  ChannelMessage,
  Env,
  GraphNotificationItem,
  GraphNotificationPayload,
  GraphSubscription,
} from "../types.js";

// ─── Subscription creation ────────────────────────────────────────────────────

const SUBSCRIPTION_LIFETIME_MINS = 55; // Keep under 60-minute Graph max

function nowPlusMins(mins: number): string {
  return new Date(Date.now() + mins * 60 * 1000).toISOString();
}

/**
 * Generate a per-subscription client state token.
 * Stored in D1 and compared against incoming notifications for validation.
 */
function generateClientState(env: Env): string {
  // Use GRAPH_NOTIFICATION_SECRET as a namespace + random UUID
  const base = env.GRAPH_NOTIFICATION_SECRET ?? "arcadia";
  return `${base}-${crypto.randomUUID()}`;
}

/**
 * Create a new Graph subscription for a Teams channel.
 * Stores the subscription in D1 and KV.
 */
export async function createSubscription(
  teamId: string,
  channelId: string,
  workerUrl: string,
  env: Env
): Promise<GraphSubscription> {
  // Check if subscription already exists for this channel
  const existing = await getSubscriptionForChannel(teamId, channelId, env);
  if (existing) {
    // Renew instead of creating duplicate
    await renewSubscriptionById(existing.id, env);
    return {
      id: existing.id,
      resource: existing.resource,
      expirationDateTime: new Date(existing.expiration_datetime * 1000).toISOString(),
      clientState: existing.client_state,
      changeType: "created,updated",
      notificationUrl: `${workerUrl}/api/graph/notifications`,
    };
  }

  const resource = `teams('${teamId}')/channels('${channelId}')/messages`;
  const clientState = generateClientState(env);
  const expirationDateTime = nowPlusMins(SUBSCRIPTION_LIFETIME_MINS);

  const sub = await graphPost<GraphSubscription>(
    "/subscriptions",
    {
      changeType: "created,updated",
      notificationUrl: `${workerUrl}/api/graph/notifications`,
      resource,
      expirationDateTime,
      clientState,
    },
    env
  );

  const expirationTs = Math.floor(new Date(sub.expirationDateTime).getTime() / 1000);
  await upsertGraphSubscription(
    sub.id,
    teamId,
    channelId,
    resource,
    expirationTs,
    clientState,
    env
  );

  // Cache subscription ID in KV for fast lookup
  await env.ARCADIA_CACHE.put(`sub:${teamId}:${channelId}`, sub.id);

  console.log(
    `[Arcadia/Sub] Created subscription ${sub.id} for ${teamId}/${channelId} (expires: ${expirationDateTime})`
  );

  return sub;
}

// ─── Subscription renewal ─────────────────────────────────────────────────────

/**
 * Renew a specific subscription by its Graph ID.
 */
async function renewSubscriptionById(
  subscriptionId: string,
  env: Env
): Promise<void> {
  const expirationDateTime = nowPlusMins(SUBSCRIPTION_LIFETIME_MINS);

  try {
    await graphPost<{ id: string; expirationDateTime: string }>(
      `/subscriptions/${subscriptionId}`,
      { expirationDateTime },
      env
    );
  } catch {
    // Graph PATCH uses the same client but needs PATCH method — use raw fetch
    const { getGraphToken } = await import("./client.js");
    const token = await getGraphToken(env);
    await fetch(`${GRAPH.BASE_URL}/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime }),
    });
  }

  const expirationTs = Math.floor(
    new Date(expirationDateTime).getTime() / 1000
  );
  await upsertGraphSubscription(
    subscriptionId,
    "", // team_id not needed for renewal (UPDATE path)
    "",
    "",
    expirationTs,
    "",
    env,
    true // isRenewal
  );

  console.log(`[Arcadia/Sub] Renewed subscription ${subscriptionId} (expires: ${expirationDateTime})`);
}

/**
 * Renew all subscriptions expiring within 30 minutes.
 * Called from the daily cron handler.
 */
export async function renewExpiringSubscriptions(env: Env): Promise<void> {
  const RENEWAL_BUFFER_SECS = 1800; // Renew if < 30 min remaining
  const expiring = await getExpiringSubscriptions(RENEWAL_BUFFER_SECS, env);

  if (expiring.length === 0) {
    console.log("[Arcadia/Sub] No subscriptions need renewal.");
    return;
  }

  console.log(`[Arcadia/Sub] Renewing ${expiring.length} expiring subscription(s)…`);

  await Promise.allSettled(
    expiring.map(async (sub) => {
      try {
        await renewSubscriptionById(sub.id, env);
      } catch (err) {
        console.error(`[Arcadia/Sub] Renewal failed for ${sub.id}:`, err);
      }
    })
  );
}

// ─── Subscription deletion ────────────────────────────────────────────────────

/** Delete a subscription from Graph and D1. */
export async function deleteSubscription(
  subscriptionId: string,
  env: Env
): Promise<void> {
  try {
    const { getGraphToken } = await import("./client.js");
    const token = await getGraphToken(env);
    await fetch(`${GRAPH.BASE_URL}/subscriptions/${subscriptionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.warn(`[Arcadia/Sub] Graph DELETE failed for ${subscriptionId}:`, err);
  }
  await deleteGraphSubscription(subscriptionId, env);
}

// ─── Validation handshake ─────────────────────────────────────────────────────

/**
 * Handle Graph's subscription validation handshake.
 *
 * When Graph creates (or re-validates) a subscription, it POSTs to the
 * notification URL with ?validationToken=<token> as a query parameter.
 * The endpoint must respond with the token as plain text, 200 OK.
 *
 * Returns a Response if this IS a validation request, null otherwise.
 */
export function validateNotificationRequest(request: Request): Response | null {
  const url = new URL(request.url);
  const token = url.searchParams.get("validationToken");
  if (!token) return null;

  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// ─── Notification processing ──────────────────────────────────────────────────

/**
 * Parse a Graph resource path to extract teamId, channelId, and messageId.
 * Example path: teams('team-id')/channels('channel-id')/messages('msg-id')
 */
function parseResourcePath(resource: string): {
  teamId: string;
  channelId: string;
  messageId: string;
} | null {
  const match = resource.match(
    /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)/
  );
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { teamId: match[1], channelId: match[2], messageId: match[3] };
}

/**
 * Normalize a Graph message to ChannelMessage format (minimal, for notifications).
 */
function normalizeGraphMessageMinimal(raw: Record<string, unknown>): ChannelMessage | null {
  if (!raw.id || !raw.createdDateTime) return null;
  if (raw.deletedDateTime) return null;

  const from = raw.from as Record<string, Record<string, string>> | undefined;
  const isBot = !!from?.application;
  const authorId = from?.user?.id ?? from?.application?.id ?? "unknown";
  const authorName = from?.user?.displayName ?? from?.application?.displayName ?? authorId;

  const body = raw.body as { contentType?: string; content?: string } | undefined;
  const rawContent = body?.content ?? "";
  const text =
    body?.contentType === "html"
      ? rawContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : rawContent.trim();

  if (!text) return null;

  return {
    id: raw.id as string,
    timestamp: raw.createdDateTime as string,
    authorId,
    authorName,
    text,
    isBot,
    ...(typeof raw.replyToId === "string" && { replyToId: raw.replyToId }),
  };
}

/**
 * Process a single Graph notification item:
 *   1. Validate clientState against D1
 *   2. Parse resource path
 *   3. Fetch message from Graph
 *   4. Cache message in KV
 *   5. Run task detection
 */
export async function processNotification(
  item: GraphNotificationItem,
  env: Env
): Promise<void> {
  // Skip deletions
  if (item.changeType === "deleted") return;

  // Validate clientState
  const subRecord = await getSubscriptionById(item.subscriptionId, env);
  if (!subRecord) {
    console.warn(`[Arcadia/Sub] Unknown subscription ${item.subscriptionId} — ignoring`);
    return;
  }
  if (subRecord.client_state !== item.clientState) {
    console.warn(`[Arcadia/Sub] clientState mismatch for ${item.subscriptionId} — ignoring`);
    return;
  }

  // Parse resource path
  const parsed = parseResourcePath(item.resource);
  if (!parsed) {
    console.warn(`[Arcadia/Sub] Cannot parse resource: ${item.resource}`);
    return;
  }
  const { teamId, channelId, messageId } = parsed;

  // Fetch full message from Graph
  let message: ChannelMessage | null = null;
  try {
    const raw = await graphGet<Record<string, unknown>>(
      `/teams/${teamId}/channels/${channelId}/messages/${messageId}`,
      env
    );
    message = normalizeGraphMessageMinimal(raw);
  } catch (err) {
    console.error(`[Arcadia/Sub] Failed to fetch message ${messageId}:`, err);
    return;
  }

  if (!message) return;

  // Update KV message cache
  await cacheMessages(teamId, channelId, [message], env);

  // Run task detection on the new message
  if (!message.isBot) {
    try {
      const { detectAndStoreTasks } = await import("../tasks/detect.js");
      const threadId = message.replyToId ?? message.id;
      await detectAndStoreTasks(teamId, channelId, threadId, [message], env);
    } catch (err) {
      console.error(`[Arcadia/Sub] Task detection failed for ${messageId}:`, err);
    }
  }
}

/**
 * Process a batch of notification items from a Graph notification payload.
 * Responds 202 Accepted immediately; processing happens in waitUntil.
 */
export async function processNotificationBatch(
  payload: GraphNotificationPayload,
  env: Env
): Promise<void> {
  await Promise.allSettled(
    payload.value.map((item) => processNotification(item, env))
  );
}
