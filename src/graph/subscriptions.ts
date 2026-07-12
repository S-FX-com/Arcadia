// Microsoft Graph change-notification subscriptions.
//
// Three responsibilities in one module:
//   handleGraphNotification()  inbound webhook — validation handshake,
//                              clientState verification, lifecycle events,
//                              fan-out of change notifications to the ingest
//                              queue
//   ensureSubscriptions()      reconcile the desired tenant-wide subscription
//                              set against Graph (create / renew / recreate),
//                              cron-driven and self-rate-limited
//   createSubscription, renewSubscription, deleteSubscription — CRUD
//                              against Graph, with HMAC-derived clientState
//                              so each subscription verifies its own
//                              notifications
//
// The Graph calls go through an injectable `SubscriptionDeps` seam so the
// reconcile + lifecycle logic can be integration-tested without a live Graph.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import type { IngestMessage } from "../ingest/types";
import { graph, GraphError, type GraphRequest } from "./client";

const SUB_PATH = "/subscriptions";
const MAX_EXPIRATION_DAYS = 3;

// Per-resource maximum subscription lifetimes (minutes). Graph rejects a
// requested expiration over the resource-specific ceiling with a 400; the
// create/renew paths fall back to GETALL_FALLBACK_MINUTES on that error.
//   - Teams/chat getAllMessages: ~60 minutes hard ceiling.
//   - Mail / calendar (Outlook): ~4230 minutes (just under 3 days).
const GETALL_MAX_MINUTES = 60;
const OUTLOOK_MAX_MINUTES = 4230;
const OVER_MAX_FALLBACK_MINUTES = 55;
// Renew when a subscription expires within this window.
const RENEW_WITHIN_MS = 12 * 3600 * 1000;
// Cron rate-limit: at most one ensure run per this many minutes.
const ENSURE_MIN_INTERVAL_MINUTES = 50;
const ENSURE_LAST_KEY = "subs:last_ensure";
// Number of most-recently-active users to place per-user mail/calendar subs on.
const PER_USER_SUB_LIMIT = 25;

function maxMinutesForResource(resource: string): number {
  return resource.includes("getAllMessages")
    ? GETALL_MAX_MINUTES
    : OUTLOOK_MAX_MINUTES;
}

// Microsoft signs webhook validationTokens with the common signing keys,
// not a tenant-specific set. One remote JWKS per isolate; jose caches
// fetched keys and re-fetches on unknown-kid.
let commonJwks: JWTVerifyGetKey | undefined;
function commonSigningKeys(): JWTVerifyGetKey {
  if (!commonJwks) {
    commonJwks = createRemoteJWKSet(
      new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"),
    );
  }
  return commonJwks;
}

// ---------------------------------------------------------------------------
// Injectable Graph seam (mirrors RegistryDeps in registry.ts)
// ---------------------------------------------------------------------------

export interface SubscriptionDeps {
  graph: <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;
}

const defaultSubDeps: SubscriptionDeps = { graph };

export interface GraphNotifyOptions {
  /** Test seam: local key resolver instead of Microsoft's common JWKS. */
  keyResolver?: JWTVerifyGetKey;
  /** Test seam: injectable Graph client for lifecycle renew/recreate. */
  deps?: SubscriptionDeps;
  /** Test seam: capture the fan-out instead of hitting the real queue. */
  enqueue?: (env: Env, msgs: IngestMessage[]) => Promise<void>;
}

/**
 * Verify one Microsoft-signed validationToken (present when a
 * notification carries resource data). Audience is our app id; the
 * issuer is accepted in both v1 (sts.windows.net) and v2 forms.
 */
async function verifyValidationToken(
  env: Env,
  token: string,
  opts: GraphNotifyOptions,
): Promise<boolean> {
  const getKey = opts.keyResolver ?? commonSigningKeys();
  try {
    await jwtVerify(token, getKey, {
      audience: env.GRAPH_CLIENT_ID,
      issuer: [
        `https://sts.windows.net/${env.GRAPH_TENANT_ID}/`,
        `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/v2.0`,
      ],
      clockTolerance: 60,
    });
    return true;
  } catch {
    return false;
  }
}

interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
  lifecycleNotificationUrl?: string;
}

type LifecycleEvent =
  | "missed"
  | "subscriptionRemoved"
  | "reauthorizationRequired";

// One notification entry covers both change and lifecycle deliveries; Graph
// puts lifecycle events either at the envelope top level or inside `value`.
interface NotificationEntry {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string; "@odata.type"?: string };
  encryptedContent?: unknown;
  tenantId?: string;
  lifecycleEvent?: LifecycleEvent;
}

interface NotificationEnvelope {
  value?: NotificationEntry[];
  validationTokens?: string[];
  // Top-level (single) lifecycle shape.
  lifecycleEvent?: LifecycleEvent;
  subscriptionId?: string;
  clientState?: string;
}

async function hmacSha256Base64(key: string, data: string): Promise<string> {
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
    expirationMinutes?: number;
  },
  deps: SubscriptionDeps = defaultSubDeps,
): Promise<GraphSubscription> {
  const expiration =
    spec.expirationMinutes !== undefined
      ? new Date(Date.now() + spec.expirationMinutes * 60 * 1000).toISOString()
      : new Date(
          Date.now() +
            Math.min(spec.expirationDays ?? MAX_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS) *
              24 *
              3600 *
              1000,
        ).toISOString();
  const clientState = await deriveClientState(env, spec.resource);

  const created = await deps.graph<GraphSubscription>(env, {
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
  // We persist the resource/changeType/notificationUrl we *requested* (not the
  // Graph echo) so reconcile lookups by resource stay stable across runs.
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO graph_subscriptions (
       id, resource, change_type, notification_url, expiration_at,
       client_state_hash, last_renewed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      created.id,
      spec.resource,
      spec.changeType,
      spec.notificationUrl,
      expiration,
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
  opts: { days?: number; minutes?: number } = {},
  deps: SubscriptionDeps = defaultSubDeps,
): Promise<GraphSubscription> {
  const expiration =
    opts.minutes !== undefined
      ? new Date(Date.now() + opts.minutes * 60 * 1000).toISOString()
      : new Date(
          Date.now() +
            Math.min(opts.days ?? MAX_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS) *
              24 *
              3600 *
              1000,
        ).toISOString();
  const renewed = await deps.graph<GraphSubscription>(env, {
    method: "PATCH",
    path: `${SUB_PATH}/${id}`,
    body: { expirationDateTime: expiration },
  });
  // Prefer the Graph-echoed expiration; fall back to the one we requested.
  const persisted = renewed?.expirationDateTime ?? expiration;
  await env.ARCADIA_DB.prepare(
    `UPDATE graph_subscriptions SET expiration_at = ?, last_renewed_at = ? WHERE id = ?`,
  )
    .bind(persisted, new Date().toISOString(), id)
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
  const cutoff = new Date(Date.now() + windowHours * 3600 * 1000).toISOString();
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

export async function deleteSubscription(
  env: Env,
  id: string,
  deps: SubscriptionDeps = defaultSubDeps,
): Promise<void> {
  await deps.graph<void>(env, { method: "DELETE", path: `${SUB_PATH}/${id}` });
  await env.ARCADIA_DB.prepare(`DELETE FROM graph_subscriptions WHERE id = ?`)
    .bind(id)
    .run();
}

// ===========================================================================
// ensureSubscriptions — reconcile the desired tenant-wide subscription set
// ===========================================================================

interface DesiredSub {
  resource: string;
  changeType: string;
  maxMinutes: number;
  /** getAllMessages resources: a Graph 402/403 means the tenant hasn't opted
   *  into the metered/licensed model — log once and continue. */
  licensingTolerant?: boolean;
  /** Per-user resources: a 403/404 (no mailbox / no access) just skips. */
  perUserSkip?: boolean;
}

export interface EnsureResult {
  created: number;
  renewed: number;
  recreated: number;
  /** Already fresh (expires > 12h out) — nothing to do. */
  fresh: number;
  skipped: number;
  failed: number;
  /** PUBLIC_HOST unset → whole run was a no-op. */
  noop: boolean;
  /** KV rate-limit prevented this run. */
  rateLimited: boolean;
}

export interface EnsureSubscriptionsOptions {
  deps?: SubscriptionDeps;
  /** Bypass the KV rate-limit (tests). */
  force?: boolean;
  /** Override the rate-limit window. */
  minIntervalMinutes?: number;
  /** Override "now" for deterministic tests. */
  now?: number;
}

// Log the licensing caveat at most once per isolate per resource.
const licensingLogged = new Set<string>();

function notifyUrlFor(env: Env): string | undefined {
  return env.PUBLIC_HOST
    ? `https://${env.PUBLIC_HOST}/api/graph/notify`
    : undefined;
}

function emptyEnsureResult(): EnsureResult {
  return {
    created: 0,
    renewed: 0,
    recreated: 0,
    fresh: 0,
    skipped: 0,
    failed: 0,
    noop: false,
    rateLimited: false,
  };
}

/**
 * Reconcile the desired, tenant-wide, app-only subscription set against Graph:
 *   - /teams/getAllMessages + /chats/getAllMessages (all Teams messages)
 *   - per-user /users/{id}/messages + /users/{id}/events for the 25
 *     most-recently-active users
 * For each: skip if a covering row expires >12h out, renew if it expires
 * within 12h, create if missing, drop+recreate on a Graph 404. No-op (returns
 * zeros) when PUBLIC_HOST is unset so hostname-less deployments never crash the
 * cron. Cron-driven; self-rate-limited via KV to once per ~50 minutes so the
 * ~1h getAllMessages subscriptions stay alive.
 */
export async function ensureSubscriptions(
  env: Env,
  log: Logger,
  opts: EnsureSubscriptionsOptions = {},
): Promise<EnsureResult> {
  const deps = opts.deps ?? defaultSubDeps;
  const now = opts.now ?? Date.now();

  const notifyUrl = notifyUrlFor(env);
  if (!notifyUrl) {
    log.info("subscription_ensure_noop_no_public_host");
    return { ...emptyEnsureResult(), noop: true };
  }

  // KV rate-limit — the */15 cron calls this every 15 min, but getAllMessages
  // subs only need re-touching under an hour, so ~50 min cadence is plenty.
  if (!opts.force) {
    const minInterval = opts.minIntervalMinutes ?? ENSURE_MIN_INTERVAL_MINUTES;
    const last = await env.ARCADIA_CACHE.get(ENSURE_LAST_KEY);
    if (last) {
      const lastMs = Date.parse(last);
      if (Number.isFinite(lastMs) && now - lastMs < minInterval * 60 * 1000) {
        log.info("subscription_ensure_ratelimited", { lastAt: last });
        return { ...emptyEnsureResult(), rateLimited: true };
      }
    }
  }

  const desired = await buildDesiredSubs(env);
  const result = emptyEnsureResult();

  for (const d of desired) {
    try {
      const outcome = await reconcileResource(env, deps, d, notifyUrl, now);
      result[outcome] += 1;
    } catch (e) {
      if (
        d.licensingTolerant &&
        e instanceof GraphError &&
        (e.status === 402 || e.status === 403)
      ) {
        if (!licensingLogged.has(d.resource)) {
          licensingLogged.add(d.resource);
          log.warn("subscription_licensing_unavailable", {
            resource: d.resource,
            status: e.status,
          });
        }
        result.skipped += 1;
        continue;
      }
      if (
        d.perUserSkip &&
        e instanceof GraphError &&
        (e.status === 403 || e.status === 404)
      ) {
        log.debug("subscription_user_skipped", {
          resource: d.resource,
          status: e.status,
        });
        result.skipped += 1;
        continue;
      }
      result.failed += 1;
      log.warn("subscription_ensure_failed", {
        resource: d.resource,
        error: String(e),
      });
    }
  }

  await env.ARCADIA_CACHE.put(ENSURE_LAST_KEY, new Date(now).toISOString());
  log.info("subscription_ensure", result);
  return result;
}

async function buildDesiredSubs(env: Env): Promise<DesiredSub[]> {
  const desired: DesiredSub[] = [
    {
      resource: "/teams/getAllMessages",
      changeType: "created,updated",
      maxMinutes: GETALL_MAX_MINUTES,
      licensingTolerant: true,
    },
    {
      resource: "/chats/getAllMessages",
      changeType: "created,updated",
      maxMinutes: GETALL_MAX_MINUTES,
      licensingTolerant: true,
    },
  ];

  const users = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users
      ORDER BY (last_seen_at IS NULL), last_seen_at DESC, registered_at DESC
      LIMIT ?`,
  )
    .bind(PER_USER_SUB_LIMIT)
    .all<{ aad_id: string }>();

  for (const u of users.results) {
    desired.push({
      resource: `/users/${u.aad_id}/messages`,
      changeType: "created,updated",
      maxMinutes: OUTLOOK_MAX_MINUTES,
      perUserSkip: true,
    });
    desired.push({
      resource: `/users/${u.aad_id}/events`,
      changeType: "created,updated",
      maxMinutes: OUTLOOK_MAX_MINUTES,
      perUserSkip: true,
    });
  }

  return desired;
}

type ReconcileOutcome = "created" | "renewed" | "recreated" | "fresh";

async function reconcileResource(
  env: Env,
  deps: SubscriptionDeps,
  desired: DesiredSub,
  notifyUrl: string,
  now: number,
): Promise<ReconcileOutcome> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT id, expiration_at FROM graph_subscriptions
      WHERE resource = ? ORDER BY expiration_at DESC LIMIT 1`,
  )
    .bind(desired.resource)
    .first<{ id: string; expiration_at: string }>();

  if (row) {
    const expMs = Date.parse(row.expiration_at);
    if (Number.isFinite(expMs) && expMs - now > RENEW_WITHIN_MS) {
      return "fresh";
    }
    // Expiring within the window → renew.
    try {
      await renewWithFallback(env, deps, row.id, desired.maxMinutes);
      return "renewed";
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        // Graph-side subscription is gone — drop the row and recreate.
        await env.ARCADIA_DB.prepare(
          `DELETE FROM graph_subscriptions WHERE id = ?`,
        )
          .bind(row.id)
          .run();
        await createWithFallback(env, deps, desired, notifyUrl);
        return "recreated";
      }
      throw e;
    }
  }

  await createWithFallback(env, deps, desired, notifyUrl);
  return "created";
}

async function createWithFallback(
  env: Env,
  deps: SubscriptionDeps,
  desired: Pick<DesiredSub, "resource" | "changeType" | "maxMinutes">,
  notifyUrl: string,
): Promise<void> {
  const spec = {
    resource: desired.resource,
    changeType: desired.changeType,
    notificationUrl: notifyUrl,
    lifecycleNotificationUrl: notifyUrl,
    expirationMinutes: desired.maxMinutes,
  };
  try {
    await createSubscription(env, spec, deps);
  } catch (e) {
    if (e instanceof GraphError && e.status === 400) {
      // Requested lifetime exceeded the resource ceiling — retry short.
      await createSubscription(
        env,
        { ...spec, expirationMinutes: OVER_MAX_FALLBACK_MINUTES },
        deps,
      );
      return;
    }
    throw e;
  }
}

async function renewWithFallback(
  env: Env,
  deps: SubscriptionDeps,
  id: string,
  maxMinutes: number,
): Promise<void> {
  try {
    await renewSubscription(env, id, { minutes: maxMinutes }, deps);
  } catch (e) {
    if (e instanceof GraphError && e.status === 400) {
      await renewSubscription(
        env,
        id,
        { minutes: OVER_MAX_FALLBACK_MINUTES },
        deps,
      );
      return;
    }
    throw e;
  }
}

// ===========================================================================
// Inbound webhook
// ===========================================================================

export async function handleGraphNotification(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
  opts: GraphNotifyOptions = {},
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

  let payload: NotificationEnvelope;
  try {
    payload = (await request.json()) as NotificationEnvelope;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const deps = opts.deps ?? defaultSubDeps;
  const notifyUrl = notifyUrlFor(env);

  // Lifecycle — top-level (single) shape.
  if (payload.lifecycleEvent && payload.subscriptionId) {
    scheduleLifecycle(
      ctx,
      env,
      log,
      deps,
      notifyUrl,
      payload.subscriptionId,
      payload.lifecycleEvent,
    );
    return new Response(null, { status: 202 });
  }

  const entries = payload.value ?? [];
  const lifecycleEntries = entries.filter((e) => e.lifecycleEvent);
  const changeEntries = entries.filter((e) => !e.lifecycleEvent);

  // Lifecycle — array shape (Graph's real delivery format).
  for (const e of lifecycleEntries) {
    if (!e.lifecycleEvent) continue;
    scheduleLifecycle(
      ctx,
      env,
      log,
      deps,
      notifyUrl,
      e.subscriptionId,
      e.lifecycleEvent,
    );
  }

  if (changeEntries.length === 0) {
    return new Response(null, { status: 202 });
  }

  // Rich notifications (with resource data) carry Microsoft-signed
  // validationTokens. When present, every token MUST verify or we reject
  // the whole delivery — a forged clientState is not enough on its own.
  const validationTokens = payload.validationTokens ?? [];
  if (validationTokens.length > 0) {
    for (const token of validationTokens) {
      const ok = await verifyValidationToken(env, token, opts);
      if (!ok) {
        log.warn("graph_validationtoken_invalid");
        return new Response("invalid validation token", { status: 401 });
      }
    }
  } else {
    // No validationTokens: a delivery carrying resource data (encrypted
    // or resourceData) must never be trusted on clientState alone.
    const carriesResourceData = changeEntries.some(
      (e) => e.encryptedContent !== undefined || e.resourceData !== undefined,
    );
    if (carriesResourceData) {
      log.warn("graph_missing_validationtokens");
      return new Response("missing validation tokens", { status: 401 });
    }
  }

  const toEnqueue: IngestMessage[] = [];
  for (const entry of changeEntries) {
    const ok = await verifyClientState(
      env,
      entry.subscriptionId,
      entry.clientState,
    );
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
    if (!entry.resource) continue;
    const msg = mapNotificationToIngest(entry.resource);
    if (!msg) {
      log.info("graph_notification_unmapped", { resource: entry.resource });
      continue;
    }
    toEnqueue.push(msg);
  }

  if (toEnqueue.length > 0) {
    const enqueue = opts.enqueue ?? enqueueIngest;
    ctx.waitUntil(
      enqueue(env, toEnqueue).catch((e) =>
        log.error("graph_fanout_enqueue_failed", { error: String(e) }),
      ),
    );
  }

  return new Response(null, { status: 202 });
}

function scheduleLifecycle(
  ctx: ExecutionContext,
  env: Env,
  log: Logger,
  deps: SubscriptionDeps,
  notifyUrl: string | undefined,
  subscriptionId: string,
  event: LifecycleEvent,
): void {
  log.info("graph_lifecycle", { subscriptionId, lifecycleEvent: event });
  ctx.waitUntil(
    handleLifecycle(env, deps, notifyUrl, subscriptionId, event).catch((e) =>
      log.error("graph_lifecycle_failed", {
        subscriptionId,
        lifecycleEvent: event,
        error: String(e),
      }),
    ),
  );
}

/**
 * React to a lifecycle event by renewing or recreating the subscription:
 *   - reauthorizationRequired / missed → renew; a 404 means it's gone, so
 *     drop the row and recreate.
 *   - subscriptionRemoved → drop the row and recreate from scratch.
 * Recreate needs a notificationUrl; when PUBLIC_HOST is unset we can still
 * renew (PATCH needs no URL) but skip recreation.
 */
export async function handleLifecycle(
  env: Env,
  deps: SubscriptionDeps,
  notifyUrl: string | undefined,
  subscriptionId: string,
  event: LifecycleEvent,
): Promise<void> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT resource, change_type FROM graph_subscriptions WHERE id = ?`,
  )
    .bind(subscriptionId)
    .first<{ resource: string; change_type: string }>();

  const recreate = async (): Promise<void> => {
    await env.ARCADIA_DB.prepare(`DELETE FROM graph_subscriptions WHERE id = ?`)
      .bind(subscriptionId)
      .run();
    if (row && notifyUrl) {
      await createWithFallback(
        env,
        deps,
        {
          resource: row.resource,
          changeType: row.change_type,
          maxMinutes: maxMinutesForResource(row.resource),
        },
        notifyUrl,
      );
    }
  };

  if (event === "subscriptionRemoved") {
    await recreate();
    return;
  }

  const maxMinutes = row ? maxMinutesForResource(row.resource) : OUTLOOK_MAX_MINUTES;
  try {
    await renewWithFallback(env, deps, subscriptionId, maxMinutes);
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) {
      await recreate();
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Fan-out: notification resource → IngestMessage
// ---------------------------------------------------------------------------

/**
 * Normalise a Graph notification `resource` string to a plain path. Graph
 * uses OData key syntax with quoted ids in change notifications, e.g.
 *   teams('t')/channels('c')/messages('m')  →  teams/t/channels/c/messages/m
 * Both quoted and unquoted key forms are handled.
 */
function normalizeResourcePath(resource: string): string {
  return resource
    .replace(/\('?([^')]*)'?\)/g, "/$1")
    .replace(/^\/+/, "");
}

/**
 * Map a change-notification resource to an IngestMessage. Returns null for
 * resource shapes we don't ingest (caller logs + skips).
 */
export function mapNotificationToIngest(resource: string): IngestMessage | null {
  const path = normalizeResourcePath(resource);

  const channel = path.match(
    /^teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)$/i,
  );
  if (channel) {
    const [, , cid, mid] = channel;
    if (!cid || !mid) return null;
    return {
      source: "teams_channel_message",
      resourceId: mid,
      uri: `/${path}`,
      scope: { resourceType: "channel", resourceId: cid },
    };
  }

  const chat = path.match(/^chats\/([^/]+)\/messages\/([^/]+)$/i);
  if (chat) {
    const [, chatId, mid] = chat;
    if (!chatId || !mid) return null;
    return {
      source: "chat_message",
      resourceId: mid,
      uri: `/${path}`,
      scope: { resourceType: "chat", resourceId: chatId },
    };
  }

  const mail = path.match(/^users\/([^/]+)\/messages\/([^/]+)$/i);
  if (mail) {
    const [, aadId, mid] = mail;
    if (!aadId || !mid) return null;
    return {
      source: "mail_message",
      resourceId: mid,
      uri: `/${path}`,
      ownerAadId: aadId,
      scope: { resourceType: "user", resourceId: aadId },
    };
  }

  const event = path.match(/^users\/([^/]+)\/events\/([^/]+)$/i);
  if (event) {
    const [, aadId, eventId] = event;
    if (!aadId || !eventId) return null;
    return {
      source: "calendar_event",
      resourceId: eventId,
      uri: `/${path}`,
      ownerAadId: aadId,
      scope: { resourceType: "user", resourceId: aadId },
    };
  }

  return null;
}

async function enqueueIngest(env: Env, msgs: IngestMessage[]): Promise<void> {
  const first = msgs[0];
  if (msgs.length === 1 && first) {
    await env.INGEST_QUEUE.send(first);
    return;
  }
  await env.INGEST_QUEUE.sendBatch(msgs.map((body) => ({ body })));
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
