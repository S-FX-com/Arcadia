// Microsoft Graph change-notification subscriptions.
//
// Two responsibilities in one module:
//   handleGraphNotification()  inbound webhook — validation handshake,
//                              clientState verification, lifecycle events,
//                              fan-out to per-resource handlers
//   createSubscription, renewSubscription, deleteSubscription — CRUD
//                              against Graph, with HMAC-derived clientState
//                              so each subscription verifies its own
//                              notifications

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { graph } from "./client";

const SUB_PATH = "/subscriptions";
const MAX_EXPIRATION_DAYS = 3;

interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
  lifecycleNotificationUrl?: string;
}

interface ChangeNotification {
  value: {
    subscriptionId: string;
    clientState?: string;
    changeType: string;
    resource: string;
    resourceData?: { id?: string; "@odata.type"?: string };
    tenantId?: string;
  }[];
  validationTokens?: string[];
}

interface LifecycleNotification {
  lifecycleEvent: "missed" | "subscriptionRemoved" | "reauthorizationRequired";
  subscriptionId: string;
  clientState?: string;
}

async function hmacSha256Base64(
  key: string,
  data: string,
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
}

export async function deriveClientState(
  env: Env,
  resourceContext: string,
): Promise<string> {
  return hmacSha256Base64(env.GRAPH_NOTIFICATION_SECRET, resourceContext);
}

export async function createSubscription(
  env: Env,
  spec: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    lifecycleNotificationUrl?: string;
    expirationDays?: number;
  },
): Promise<GraphSubscription> {
  const days = Math.min(
    spec.expirationDays ?? MAX_EXPIRATION_DAYS,
    MAX_EXPIRATION_DAYS,
  );
  const expiration = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const clientState = await deriveClientState(env, spec.resource);

  const created = await graph<GraphSubscription>(env, {
    method: "POST",
    path: SUB_PATH,
    body: {
      changeType: spec.changeType,
      resource: spec.resource,
      notificationUrl: spec.notificationUrl,
      lifecycleNotificationUrl: spec.lifecycleNotificationUrl,
      expirationDateTime: expiration,
      clientState,
    },
  });

  const now = new Date().toISOString();
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO graph_subscriptions (
       id, resource, change_type, notification_url, expiration_at,
       client_state_hash, last_renewed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      created.id,
      created.resource,
      created.changeType,
      created.notificationUrl,
      created.expirationDateTime,
      clientState,
      now,
      now,
    )
    .run();

  return created;
}

export async function renewSubscription(
  env: Env,
  id: string,
  days = MAX_EXPIRATION_DAYS,
): Promise<GraphSubscription> {
  const expiration = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const renewed = await graph<GraphSubscription>(env, {
    method: "PATCH",
    path: `${SUB_PATH}/${id}`,
    body: { expirationDateTime: expiration },
  });
  await env.ARCADIA_DB.prepare(
    `UPDATE graph_subscriptions SET expiration_at = ?, last_renewed_at = ? WHERE id = ?`,
  )
    .bind(renewed.expirationDateTime, new Date().toISOString(), id)
    .run();
  return renewed;
}

export interface RenewAllResult {
  considered: number;
  renewed: number;
  failed: number;
}

/**
 * Renew every active subscription whose expiration_at is within
 * `windowHours` from now. Cron-driven — wired into the 8am daily
 * tick.
 */
export async function renewExpiringSubscriptions(
  env: Env,
  log: Logger,
  windowHours = 24,
): Promise<RenewAllResult> {
  const cutoff = new Date(
    Date.now() + windowHours * 3600 * 1000,
  ).toISOString();
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT id FROM graph_subscriptions WHERE expiration_at <= ?`,
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const result: RenewAllResult = {
    considered: rows.results.length,
    renewed: 0,
    failed: 0,
  };
  for (const r of rows.results) {
    try {
      await renewSubscription(env, r.id);
      result.renewed += 1;
    } catch (e) {
      result.failed += 1;
      log.warn("subscription_renew_failed", {
        subscriptionId: r.id,
        error: String(e),
      });
    }
  }
  log.info("subscription_renew", result);
  return result;
}

export async function deleteSubscription(env: Env, id: string): Promise<void> {
  await graph<void>(env, { method: "DELETE", path: `${SUB_PATH}/${id}` });
  await env.ARCADIA_DB.prepare(`DELETE FROM graph_subscriptions WHERE id = ?`)
    .bind(id)
    .run();
}

export async function handleGraphNotification(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    log.info("graph_validation_handshake");
    return new Response(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let payload: ChangeNotification | LifecycleNotification;
  try {
    payload = (await request.json()) as ChangeNotification | LifecycleNotification;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if ((payload as LifecycleNotification).lifecycleEvent) {
    const evt = payload as LifecycleNotification;
    log.info("graph_lifecycle", {
      subscriptionId: evt.subscriptionId,
      event: evt.lifecycleEvent,
    });
    if (evt.lifecycleEvent === "reauthorizationRequired") {
      ctx.waitUntil(
        renewSubscription(env, evt.subscriptionId).catch((e) =>
          log.error("graph_renew_failed", { error: String(e) }),
        ),
      );
    }
    return new Response(null, { status: 202 });
  }

  const change = payload as ChangeNotification;
  for (const entry of change.value ?? []) {
    const ok = await verifyClientState(env, entry.subscriptionId, entry.clientState);
    if (!ok) {
      log.warn("graph_clientstate_mismatch", {
        subscriptionId: entry.subscriptionId,
      });
      continue;
    }
    log.info("graph_notification", {
      subscriptionId: entry.subscriptionId,
      changeType: entry.changeType,
      resource: entry.resource,
    });
    // TODO: fan out to per-resource handlers (messages → ingest queue,
    // calendar → routine triggers, presence → nudge engine). Lands in
    // the Intelligence commit.
  }
  return new Response(null, { status: 202 });
}

async function verifyClientState(
  env: Env,
  subscriptionId: string,
  incoming?: string,
): Promise<boolean> {
  if (!incoming) return false;
  const row = await env.ARCADIA_DB.prepare(
    `SELECT client_state_hash FROM graph_subscriptions WHERE id = ?`,
  )
    .bind(subscriptionId)
    .first<{ client_state_hash: string }>();
  if (!row) return false;
  return safeEqual(incoming, row.client_state_hash);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
