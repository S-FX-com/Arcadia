import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { GraphError, type GraphRequest } from "../../src/graph/client";
import {
  deriveClientState,
  ensureSubscriptions,
  handleGraphNotification,
  mapNotificationToIngest,
  type SubscriptionDeps,
} from "../../src/graph/subscriptions";
import type { IngestMessage } from "../../src/ingest/types";
import { logger } from "../../src/lib/logger";

// These integration tests exercise ensureSubscriptions and the webhook
// fan-out against the miniflare D1 + KV, with the Graph client and the ingest
// queue replaced by injectable seams (mirroring RegistryDeps in registry.ts).

const testEnv = env as unknown as Env;
const envHost: Env = { ...testEnv, PUBLIC_HOST: "arcadia.test" };
const NOTIFY_URL = "https://arcadia.test/api/graph/notify";
const log = logger();

// ---------------------------------------------------------------------------
// Graph seam
// ---------------------------------------------------------------------------

interface CapturedCall {
  method: string;
  path: string;
  body: unknown;
}

interface FakeSub {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

/** A behavior may inspect a call and throw (e.g. a GraphError) before the
 *  default response is produced. */
type GraphBehavior = (call: CapturedCall) => void;

function graphSeam(behavior?: GraphBehavior): {
  deps: SubscriptionDeps;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let seq = 0;
  const graph = async <T = unknown>(
    _env: Env,
    req: GraphRequest,
  ): Promise<T> => {
    const call: CapturedCall = {
      method: req.method ?? "GET",
      path: req.path,
      body: req.body,
    };
    calls.push(call);
    if (behavior) behavior(call);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === "POST") {
      seq += 1;
      const sub: FakeSub = {
        id: `newsub-${seq}`,
        resource: String(body.resource ?? ""),
        changeType: String(body.changeType ?? ""),
        notificationUrl: String(body.notificationUrl ?? ""),
        expirationDateTime: String(body.expirationDateTime ?? ""),
        ...(typeof body.clientState === "string"
          ? { clientState: body.clientState }
          : {}),
      };
      return sub as unknown as T;
    }
    if (req.method === "PATCH") {
      const id = req.path.split("/").pop() ?? "";
      const sub: FakeSub = {
        id,
        resource: "",
        changeType: "",
        notificationUrl: "",
        expirationDateTime: String(body.expirationDateTime ?? ""),
      };
      return sub as unknown as T;
    }
    return undefined as unknown as T;
  };
  return { deps: { graph }, calls };
}

function postBodyOf(call: CapturedCall | undefined): {
  resource?: string;
  changeType?: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
  clientState?: string;
  expirationDateTime?: string;
} {
  return (call?.body ?? {}) as Record<string, string>;
}

async function clearSubs(resources: string[]): Promise<void> {
  for (const r of resources) {
    await testEnv.ARCADIA_DB.prepare(
      `DELETE FROM graph_subscriptions WHERE resource = ?`,
    )
      .bind(r)
      .run();
  }
}

async function seedSub(row: {
  id: string;
  resource: string;
  expiresInMs: number;
  clientStateHash?: string;
}): Promise<void> {
  const exp = new Date(Date.now() + row.expiresInMs).toISOString();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO graph_subscriptions
       (id, resource, change_type, notification_url, expiration_at,
        client_state_hash, last_renewed_at, created_at)
     VALUES (?, ?, 'created,updated', ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.resource,
      NOTIFY_URL,
      exp,
      row.clientStateHash ?? "seed-hash",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}

async function seedUser(aadId: string, lastSeenAt: string): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO users (aad_id, tenant_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(aad_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(aadId, testEnv.GRAPH_TENANT_ID, lastSeenAt)
    .run();
}

async function subRow(
  id: string,
): Promise<{ id: string; expiration_at: string } | null> {
  return testEnv.ARCADIA_DB.prepare(
    `SELECT id, expiration_at FROM graph_subscriptions WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; expiration_at: string }>();
}

async function subForResource(
  resource: string,
): Promise<{ id: string } | null> {
  return testEnv.ARCADIA_DB.prepare(
    `SELECT id FROM graph_subscriptions WHERE resource = ? LIMIT 1`,
  )
    .bind(resource)
    .first<{ id: string }>();
}

// ===========================================================================
// ensureSubscriptions
// ===========================================================================

describe("ensureSubscriptions", () => {
  it("creates missing subscriptions with the right notificationUrl/clientState + D1 rows", async () => {
    await clearSubs(["/teams/getAllMessages", "/chats/getAllMessages"]);
    await seedUser("subs-user-a", "2099-01-01T00:00:00.000Z");

    const { deps, calls } = graphSeam();
    const result = await ensureSubscriptions(envHost, log, {
      deps,
      force: true,
    });

    // getAllMessages POST body.
    const teamsPost = calls.find(
      (c) =>
        c.method === "POST" &&
        postBodyOf(c).resource === "/teams/getAllMessages",
    );
    expect(teamsPost).toBeDefined();
    const body = postBodyOf(teamsPost);
    expect(body.notificationUrl).toBe(NOTIFY_URL);
    expect(body.lifecycleNotificationUrl).toBe(NOTIFY_URL);
    expect(body.clientState).toBe(
      await deriveClientState(envHost, "/teams/getAllMessages"),
    );

    // D1 row persisted for the requested resource.
    expect(await subForResource("/teams/getAllMessages")).not.toBeNull();
    expect(await subForResource("/chats/getAllMessages")).not.toBeNull();

    // Per-user mail + calendar subs created for the seeded active user.
    const mailPost = calls.find(
      (c) => postBodyOf(c).resource === "/users/subs-user-a/messages",
    );
    const eventsPost = calls.find(
      (c) => postBodyOf(c).resource === "/users/subs-user-a/events",
    );
    expect(mailPost).toBeDefined();
    expect(eventsPost).toBeDefined();
    expect(result.created).toBeGreaterThanOrEqual(2);
  });

  it("renews a subscription expiring within 12h (PATCH + updated expiration)", async () => {
    await clearSubs(["/teams/getAllMessages", "/chats/getAllMessages"]);
    await seedSub({
      id: "exp-sub",
      resource: "/teams/getAllMessages",
      expiresInMs: 60 * 60 * 1000, // 1h → within the 12h renew window
    });
    const before = await subRow("exp-sub");

    const { deps, calls } = graphSeam();
    const result = await ensureSubscriptions(envHost, log, {
      deps,
      force: true,
    });

    const patch = calls.find(
      (c) => c.method === "PATCH" && c.path === "/subscriptions/exp-sub",
    );
    expect(patch).toBeDefined();
    expect(result.renewed).toBeGreaterThanOrEqual(1);

    const after = await subRow("exp-sub");
    expect(after?.expiration_at).not.toBe(before?.expiration_at);
  });

  it("drops the row and recreates when Graph returns 404 on renew", async () => {
    await clearSubs(["/teams/getAllMessages", "/chats/getAllMessages"]);
    await seedSub({
      id: "gone-sub",
      resource: "/teams/getAllMessages",
      expiresInMs: 30 * 60 * 1000,
    });

    // PATCH to the gone subscription 404s; POST (recreate) succeeds.
    const { deps, calls } = graphSeam((call) => {
      if (call.method === "PATCH" && call.path === "/subscriptions/gone-sub") {
        throw new GraphError(404, "not found");
      }
    });
    const result = await ensureSubscriptions(envHost, log, {
      deps,
      force: true,
    });

    expect(await subRow("gone-sub")).toBeNull();
    const recreated = await subForResource("/teams/getAllMessages");
    expect(recreated).not.toBeNull();
    expect(recreated?.id).not.toBe("gone-sub");
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          postBodyOf(c).resource === "/teams/getAllMessages",
      ),
    ).toBe(true);
    expect(result.recreated).toBeGreaterThanOrEqual(1);
  });

  it("leaves a subscription that expires >12h out untouched", async () => {
    await seedUser("subs-user-fresh", "2099-01-02T00:00:00.000Z");
    await clearSubs(["/users/subs-user-fresh/events"]);
    await seedSub({
      id: "fresh-events",
      resource: "/users/subs-user-fresh/events",
      expiresInMs: 2 * 24 * 60 * 60 * 1000, // 2 days out
    });

    const { deps, calls } = graphSeam();
    await ensureSubscriptions(envHost, log, { deps, force: true });

    // No renew/create call should touch the fresh events resource.
    const touchedEvents = calls.filter(
      (c) =>
        c.path === "/subscriptions/fresh-events" ||
        postBodyOf(c).resource === "/users/subs-user-fresh/events",
    );
    expect(touchedEvents).toHaveLength(0);
  });

  it("is a no-op (zeros) when PUBLIC_HOST is unset", async () => {
    const { deps, calls } = graphSeam();
    const result = await ensureSubscriptions(testEnv, log, {
      deps,
      force: true,
    });
    expect(result.noop).toBe(true);
    expect(result.created).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("honors the KV rate-limit (subs:last_ensure)", async () => {
    await testEnv.ARCADIA_CACHE.delete("subs:last_ensure");

    const first = graphSeam();
    const r1 = await ensureSubscriptions(envHost, log, { deps: first.deps });
    expect(r1.rateLimited).toBe(false);

    const second = graphSeam();
    const r2 = await ensureSubscriptions(envHost, log, { deps: second.deps });
    expect(r2.rateLimited).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  it("tolerates a 403 on getAllMessages (licensing) without failing the run", async () => {
    await clearSubs(["/teams/getAllMessages", "/chats/getAllMessages"]);

    const { deps } = graphSeam((call) => {
      const resource = postBodyOf(call).resource ?? "";
      if (call.method === "POST" && resource.includes("getAllMessages")) {
        throw new GraphError(403, "licensing required");
      }
    });
    const result = await ensureSubscriptions(envHost, log, {
      deps,
      force: true,
    });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(await subForResource("/teams/getAllMessages")).toBeNull();
  });
});

// ===========================================================================
// mapNotificationToIngest (pure)
// ===========================================================================

describe("mapNotificationToIngest", () => {
  it("maps a quoted channel-message resource", () => {
    expect(
      mapNotificationToIngest("teams('t1')/channels('c1')/messages('m1')"),
    ).toEqual<IngestMessage>({
      source: "teams_channel_message",
      resourceId: "m1",
      uri: "/teams/t1/channels/c1/messages/m1",
      scope: { resourceType: "channel", resourceId: "c1" },
    });
  });

  it("maps a slash-form channel-message resource", () => {
    expect(
      mapNotificationToIngest("teams/t1/channels/c1/messages/m9"),
    ).toEqual<IngestMessage>({
      source: "teams_channel_message",
      resourceId: "m9",
      uri: "/teams/t1/channels/c1/messages/m9",
      scope: { resourceType: "channel", resourceId: "c1" },
    });
  });

  it("maps a chat-message resource (colon ids preserved)", () => {
    expect(
      mapNotificationToIngest("chats('19:abc@thread.v2')/messages('m2')"),
    ).toEqual<IngestMessage>({
      source: "chat_message",
      resourceId: "m2",
      uri: "/chats/19:abc@thread.v2/messages/m2",
      scope: { resourceType: "chat", resourceId: "19:abc@thread.v2" },
    });
  });

  it("maps a mail resource with ownerAadId", () => {
    expect(
      mapNotificationToIngest("users/u1/messages/mailm"),
    ).toEqual<IngestMessage>({
      source: "mail_message",
      resourceId: "mailm",
      uri: "/users/u1/messages/mailm",
      ownerAadId: "u1",
      scope: { resourceType: "user", resourceId: "u1" },
    });
  });

  it("maps a calendar-event resource with ownerAadId", () => {
    expect(
      mapNotificationToIngest("users('u1')/events('evt1')"),
    ).toEqual<IngestMessage>({
      source: "calendar_event",
      resourceId: "evt1",
      uri: "/users/u1/events/evt1",
      ownerAadId: "u1",
      scope: { resourceType: "user", resourceId: "u1" },
    });
  });

  it("returns null for unknown resource shapes", () => {
    expect(mapNotificationToIngest("drives('d')/items('i')")).toBeNull();
  });
});

// ===========================================================================
// Webhook fan-out
// ===========================================================================

function notifyRequest(body: unknown): Request {
  return new Request("https://arcadia.test/api/graph/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleGraphNotification fan-out", () => {
  it("verifies clientState and enqueues a channel message", async () => {
    const resource = "/teams/getAllMessages";
    const hash = await deriveClientState(testEnv, resource);
    await seedSub({
      id: "fan-teams",
      resource,
      expiresInMs: 60 * 60 * 1000,
      clientStateHash: hash,
    });

    const captured: IngestMessage[] = [];
    const ctx = createExecutionContext();
    const res = await handleGraphNotification(
      notifyRequest({
        value: [
          {
            subscriptionId: "fan-teams",
            clientState: hash,
            changeType: "created",
            resource: "teams('t1')/channels('c1')/messages('m1')",
          },
        ],
      }),
      testEnv,
      ctx,
      log,
      {
        enqueue: async (_env, msgs) => {
          captured.push(...msgs);
        },
      },
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(captured).toEqual<IngestMessage[]>([
      {
        source: "teams_channel_message",
        resourceId: "m1",
        uri: "/teams/t1/channels/c1/messages/m1",
        scope: { resourceType: "channel", resourceId: "c1" },
      },
    ]);
  });

  it("enqueues a batch and skips unknown resources / clientState mismatches", async () => {
    const chatRes = "/chats/getAllMessages";
    const mailRes = "/users/u1/messages";
    const chatHash = await deriveClientState(testEnv, chatRes);
    const mailHash = await deriveClientState(testEnv, mailRes);
    await seedSub({
      id: "fan-chats",
      resource: chatRes,
      expiresInMs: 60 * 60 * 1000,
      clientStateHash: chatHash,
    });
    await seedSub({
      id: "fan-mail",
      resource: mailRes,
      expiresInMs: 3 * 24 * 60 * 60 * 1000,
      clientStateHash: mailHash,
    });

    const captured: IngestMessage[] = [];
    const ctx = createExecutionContext();
    await handleGraphNotification(
      notifyRequest({
        value: [
          {
            subscriptionId: "fan-chats",
            clientState: chatHash,
            changeType: "created",
            resource: "chats('19:xyz')/messages('cm1')",
          },
          {
            subscriptionId: "fan-mail",
            clientState: mailHash,
            changeType: "created",
            resource: "users/u1/messages/mm1",
          },
          {
            // Wrong clientState → skipped.
            subscriptionId: "fan-mail",
            clientState: "not-the-hash",
            changeType: "created",
            resource: "users/u1/messages/mm2",
          },
        ],
      }),
      testEnv,
      ctx,
      log,
      {
        enqueue: async (_env, msgs) => {
          captured.push(...msgs);
        },
      },
    );
    await waitOnExecutionContext(ctx);

    expect(captured).toHaveLength(2);
    expect(captured.map((m) => m.source).sort()).toEqual([
      "chat_message",
      "mail_message",
    ]);
    const mail = captured.find((m) => m.source === "mail_message");
    expect(mail?.ownerAadId).toBe("u1");
    expect(mail?.scope).toEqual({ resourceType: "user", resourceId: "u1" });
  });

  it("renews on a reauthorizationRequired lifecycle event (array shape)", async () => {
    await seedSub({
      id: "life-sub",
      resource: "/teams/getAllMessages",
      expiresInMs: 60 * 60 * 1000,
    });

    const { deps, calls } = graphSeam();
    const ctx = createExecutionContext();
    const res = await handleGraphNotification(
      notifyRequest({
        value: [
          {
            subscriptionId: "life-sub",
            lifecycleEvent: "reauthorizationRequired",
          },
        ],
      }),
      testEnv,
      ctx,
      log,
      { deps },
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.path === "/subscriptions/life-sub",
      ),
    ).toBe(true);
  });

  it("recreates on a subscriptionRemoved lifecycle event (top-level shape)", async () => {
    await clearSubs(["/teams/getAllMessages"]);
    await seedSub({
      id: "rm-sub",
      resource: "/teams/getAllMessages",
      expiresInMs: 60 * 60 * 1000,
    });

    const { deps, calls } = graphSeam();
    const ctx = createExecutionContext();
    await handleGraphNotification(
      notifyRequest({
        subscriptionId: "rm-sub",
        lifecycleEvent: "subscriptionRemoved",
      }),
      envHost,
      ctx,
      log,
      { deps },
    );
    await waitOnExecutionContext(ctx);

    expect(await subRow("rm-sub")).toBeNull();
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          postBodyOf(c).resource === "/teams/getAllMessages",
      ),
    ).toBe(true);
  });
});
