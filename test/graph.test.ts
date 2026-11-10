// src/integrations/graph.ts against a stubbed fetch, a fake CONTROL KV and a
// fake D1. Ported from the v5 Schedule-session and createShift tests, plus the
// core: retries, paging, and the audit row before and after every write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShift,
  createTimeOffRequest,
  deleteShift,
  GraphError,
  listMemberUsers,
  listSchedulingGroups,
  listShifts,
  listTeams,
  listTimeOffReasons,
  listTimeOffRequests,
  listTimesOff,
  userDisplayName,
} from "../src/integrations/graph";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Ordered trace of fetches and audit inserts, so "before" and "after" are checkable. */
let events: string[];
let calls: Call[];
let audits: Array<{ actor: string; action: string; subject: string | null; detail: string | null }>;
let replies: Array<(call: Call) => Response>;
/** When set, an audit insert whose action matches throws, as a failed D1 write would. */
let failAudit: ((action: string) => boolean) | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async run() {
          if (sql.includes("INSERT INTO audit_log")) {
            const [actor, action, subject, detail] = args as [string, string, string | null, string | null];
            if (failAudit?.(action)) throw new Error("D1 unavailable");
            audits.push({ actor, action, subject, detail });
            events.push(`audit:${action}`);
          }
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function makeEnv(over: Record<string, unknown> = {}, kv = fakeKv({ "graph:app_token": "cached-token" })): Env {
  return {
    GRAPH_TENANT_ID: "tenant-1",
    GRAPH_CLIENT_ID: "client-1",
    GRAPH_CLIENT_SECRET: "secret",
    CONTROL: kv.kv,
    DB: fakeDb(),
    ...over,
  } as Env;
}

/** Queue the next responses; once the queue is empty every call gets {value: []}. */
function reply(...next: Array<(call: Call) => Response>) {
  replies.push(...next);
}

beforeEach(() => {
  events = [];
  calls = [];
  audits = [];
  replies = [];
  failAudit = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const raw = init.body;
      const body = typeof raw === "string" ? JSON.parse(raw) : raw;
      const call = { method, url: String(input), body };
      calls.push(call);
      events.push(`fetch:${method} ${call.url}`);
      const next = replies.shift();
      return next ? next(call) : json({ value: [] });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const graphCalls = () => calls.filter((c) => c.url.startsWith("https://graph.microsoft.com/"));

describe("credentials", () => {
  it("refuses every call until Graph credentials exist, without calling out", async () => {
    const env = makeEnv({ GRAPH_CLIENT_SECRET: undefined });
    await expect(listShifts(env, "team-1")).rejects.toMatchObject({ status: 401 });
    await expect(
      createShift(
        env,
        "team-1",
        { userId: "u", schedulingGroupId: "g", startDateTime: "2026-09-28T09:00:00Z", endDateTime: "2026-09-28T17:00:00Z" },
        "shane@s-fx.com"
      )
    ).rejects.toBeInstanceOf(GraphError);
    expect(calls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("fetches a client-credentials token once and caches it in KV", async () => {
    const kv = fakeKv();
    const env = makeEnv({}, kv);
    reply(() => json({ access_token: "fresh-token", expires_in: 3600 }));
    await listShifts(env, "team-1");
    await listShifts(env, "team-1");
    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(calls.filter((c) => c.url.includes("login.microsoftonline.com"))).toHaveLength(1);
    expect(kv.store.get("graph:app_token")).toBe("fresh-token");
  });
});

describe("Schedule reads", () => {
  it("scopes every read to the team it is given", async () => {
    const env = makeEnv();
    await listShifts(env, "team-1");
    await listTimesOff(env, "team-1");
    await listTimeOffReasons(env, "team-1");
    await listTimeOffRequests(env, "team-1");
    await listSchedulingGroups(env, "team-1");
    expect(graphCalls().map((c) => c.url)).toEqual([
      "https://graph.microsoft.com/v1.0/teams/team-1/schedule/shifts",
      "https://graph.microsoft.com/v1.0/teams/team-1/schedule/timesOff",
      "https://graph.microsoft.com/v1.0/teams/team-1/schedule/timeOffReasons",
      "https://graph.microsoft.com/v1.0/teams/team-1/schedule/timeOffRequests",
      "https://graph.microsoft.com/v1.0/teams/team-1/schedule/schedulingGroups",
    ]);
  });

  it("parses a shift's published (sharedShift) time over an unpublished draft one", async () => {
    reply(() =>
      json({
        value: [
          {
            id: "s1",
            userId: "u1",
            sharedShift: { displayName: "Morning", startDateTime: "2026-08-24T09:00:00Z", endDateTime: "2026-08-24T17:00:00Z" },
            draftShift: { displayName: "Draft", startDateTime: "2026-08-24T06:00:00Z", endDateTime: "2026-08-24T07:00:00Z" },
          },
        ],
      })
    );
    expect(await listShifts(makeEnv(), "team-1")).toEqual([
      { id: "s1", userId: "u1", displayName: "Morning", startDateTime: "2026-08-24T09:00:00Z", endDateTime: "2026-08-24T17:00:00Z" },
    ]);
  });

  it("reads time-off request state verbatim", async () => {
    reply(() => json({ value: [{ id: "r1", senderUserId: "u1", state: "approved", startDateTime: "a", endDateTime: "b" }] }));
    expect(await listTimeOffRequests(makeEnv(), "team-1")).toEqual([
      { id: "r1", senderUserId: "u1", state: "approved", startDateTime: "a", endDateTime: "b" },
    ]);
  });

  it("does not write an audit row for a read", async () => {
    await listShifts(makeEnv(), "team-1");
    expect(audits).toHaveLength(0);
  });
});

describe("paging", () => {
  it("follows @odata.nextLink, stripping the v1.0 root", async () => {
    reply(
      () =>
        json({
          value: [{ id: "u1" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=abc",
        }),
      () => json({ value: [{ id: "u2" }] })
    );
    const users = await listMemberUsers(makeEnv());
    expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(graphCalls()[0]?.url).toContain("/v1.0/users?$select=id,displayName,mail");
    expect(graphCalls()[1]?.url).toBe("https://graph.microsoft.com/v1.0/users?$skiptoken=abc");
  });

  it("stops at the page cap and throws instead of returning a partial collection", async () => {
    const env = makeEnv();
    for (let i = 0; i < 20; i++) {
      reply(() => json({ value: [{ id: `u${i}` }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?next" }));
    }
    await expect(listMemberUsers(env)).rejects.toThrow(/more than 10 pages/);
    expect(graphCalls()).toHaveLength(10);
  });

  it("refuses a partial time-off read, so nothing is posted over unseen time off", async () => {
    for (let i = 0; i < 10; i++) {
      reply(() =>
        json({
          value: [{ id: `t${i}` }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/team-1/schedule/timesOff?next",
        })
      );
    }
    await expect(listTimesOff(makeEnv(), "team-1")).rejects.toBeInstanceOf(GraphError);
  });
});

describe("retries", () => {
  it("retries a throttled GET after Retry-After", async () => {
    reply(
      () => json({ error: { code: "TooManyRequests" } }, { status: 429, headers: { "Retry-After": "0" } }),
      () => json({ value: [{ id: "s1" }] })
    );
    expect(await listShifts(makeEnv(), "team-1")).toEqual([{ id: "s1" }]);
    expect(graphCalls()).toHaveLength(2);
  });

  it("fails at once, without retrying early, when Retry-After is longer than it will wait", async () => {
    reply(() => json({}, { status: 429, headers: { "Retry-After": "30" } }));
    await expect(listShifts(makeEnv(), "team-1")).rejects.toMatchObject({ status: 429 });
    expect(graphCalls()).toHaveLength(1);
  });

  it("retries a GET on 503 and gives up after three attempts", async () => {
    for (let i = 0; i < 3; i++) {
      reply(() => json({}, { status: 503, headers: { "Retry-After": "0" } }));
    }
    await expect(listShifts(makeEnv(), "team-1")).rejects.toMatchObject({ status: 503 });
    expect(graphCalls()).toHaveLength(3);
  });

  it("does not retry other errors", async () => {
    reply(() => json({}, { status: 500 }));
    await expect(listShifts(makeEnv(), "team-1")).rejects.toMatchObject({ status: 500 });
    expect(graphCalls()).toHaveLength(1);
  });

  it("retries a POST only on 429, never on 503, so a write is not sent twice", async () => {
    reply(
      () => json({}, { status: 429, headers: { "Retry-After": "0" } }),
      () => json({ id: "req-1" }, { status: 201 })
    );
    const input = { senderUserId: "u1", startDateTime: "2026-09-01T00:00:00Z", endDateTime: "2026-09-02T23:59:59Z" };
    expect(await createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).toEqual({ graphId: "req-1" });
    expect(graphCalls()).toHaveLength(2);

    calls = [];
    reply(() => json({}, { status: 503, headers: { "Retry-After": "0" } }));
    await expect(createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).rejects.toMatchObject({
      status: 503,
    });
    expect(graphCalls()).toHaveLength(1);
  });

  it("does not retry a DELETE on 503, so a delete that landed is not sent again", async () => {
    reply(() => json({}, { status: 503, headers: { "Retry-After": "0" } }));
    await expect(deleteShift(makeEnv(), "team-1", "s1", "shane@s-fx.com")).rejects.toMatchObject({ status: 503 });
    expect(graphCalls()).toHaveLength(1);
  });
});

describe("audit rows after a write", () => {
  const input = { senderUserId: "u1", startDateTime: "2026-09-01T00:00:00Z", endDateTime: "2026-09-02T23:59:59Z" };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a write that landed even when the success row cannot be written", async () => {
    failAudit = (action) => action.endsWith("_succeeded");
    reply(() => json({ id: "req-1" }, { status: 201 }));
    expect(await createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).toEqual({ graphId: "req-1" });
    expect(audits.map((a) => a.action)).toEqual(["graph_create_time_off_request_started"]);
  });

  it("keeps Graph's error when the failure row cannot be written", async () => {
    failAudit = (action) => action.endsWith("_failed");
    reply(() => json({}, { status: 403 }));
    await expect(createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("does not call Graph when the before row cannot be written", async () => {
    failAudit = (action) => action.endsWith("_started");
    await expect(createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).rejects.toThrow(/D1 unavailable/);
    expect(graphCalls()).toHaveLength(0);
  });
});

describe("createTimeOffRequest", () => {
  const input = { senderUserId: "u1", startDateTime: "2026-09-01T00:00:00Z", endDateTime: "2026-09-02T23:59:59Z" };

  it("files the request and audits before and after the call", async () => {
    reply(() => json({ id: "graph-generated-id" }, { status: 201 }));
    const result = await createTimeOffRequest(makeEnv(), "team-1", { ...input, timeOffReasonId: "r1" }, "ada@s-fx.com");
    expect(result.graphId).toBe("graph-generated-id");
    const post = graphCalls()[0]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe("https://graph.microsoft.com/v1.0/teams/team-1/schedule/timeOffRequests");
    expect(post.body).toEqual({ ...input, timeOffReasonId: "r1" });
    expect(events).toEqual([
      "audit:graph_create_time_off_request_started",
      "fetch:POST https://graph.microsoft.com/v1.0/teams/team-1/schedule/timeOffRequests",
      "audit:graph_create_time_off_request_succeeded",
    ]);
    expect(audits.every((a) => a.actor === "ada@s-fx.com")).toBe(true);
    expect(audits[1]?.detail).toContain("graph-generated-id");
  });

  it("treats an empty 202 as filed with an unconfirmed id", async () => {
    reply(() => new Response(null, { status: 202 }));
    expect(await createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).toEqual({});
  });

  it("audits the failure, and still throws, when Graph rejects the filing", async () => {
    reply(() => json({ error: { message: "invalid senderUserId" } }, { status: 400 }));
    await expect(createTimeOffRequest(makeEnv(), "team-1", input, "ada@s-fx.com")).rejects.toThrow(
      /invalid senderUserId/
    );
    expect(audits.map((a) => a.action)).toEqual([
      "graph_create_time_off_request_started",
      "graph_create_time_off_request_failed",
    ]);
    expect(audits[1]?.detail).toContain("invalid senderUserId");
  });
});

describe("createShift", () => {
  const shift = {
    userId: "ada",
    schedulingGroupId: "group-1",
    startDateTime: "2026-09-28T09:00:00.000Z",
    endDateTime: "2026-09-28T17:00:00.000Z",
    displayName: "Day",
  };

  it("refuses a shift longer than 24 hours before any call or audit row", async () => {
    await expect(
      createShift(makeEnv(), "team-1", { ...shift, endDateTime: "2026-09-30T09:00:00.000Z" }, "shane@s-fx.com")
    ).rejects.toThrow(/24 hours/);
    await expect(
      createShift(makeEnv(), "team-1", { ...shift, endDateTime: shift.startDateTime }, "shane@s-fx.com")
    ).rejects.toThrow(/1 minute/);
    expect(calls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("posts sharedShift, never draftShift, and audits before and after", async () => {
    reply(() => json({ id: "shift-1" }, { status: 201 }));
    const created = await createShift(makeEnv(), "team-1", shift, "arcadia", "pattern p1, enabled by shane@s-fx.com");
    expect(created.graphId).toBe("shift-1");
    const post = graphCalls()[0]!;
    expect(post.url).toBe("https://graph.microsoft.com/v1.0/teams/team-1/schedule/shifts");
    expect(post.body).toMatchObject({
      userId: "ada",
      schedulingGroupId: "group-1",
      sharedShift: { displayName: "Day", startDateTime: "2026-09-28T09:00:00.000Z" },
    });
    expect(post.body).not.toHaveProperty("draftShift");
    expect(events).toEqual([
      "audit:graph_create_shift_started",
      "fetch:POST https://graph.microsoft.com/v1.0/teams/team-1/schedule/shifts",
      "audit:graph_create_shift_succeeded",
    ]);
    expect(audits[0]?.detail).toContain("pattern p1");
  });

  it("audits a failed post", async () => {
    reply(() => json({}, { status: 403 }));
    await expect(createShift(makeEnv(), "team-1", shift, "arcadia")).rejects.toMatchObject({ status: 403 });
    expect(audits.map((a) => a.action)).toEqual(["graph_create_shift_started", "graph_create_shift_failed"]);
  });
});

describe("deleteShift", () => {
  it("deletes one named shift and audits before and after", async () => {
    reply(() => new Response(null, { status: 204 }));
    await deleteShift(makeEnv(), "team-1", "shift/1", "shane@s-fx.com");
    expect(graphCalls()[0]).toMatchObject({
      method: "DELETE",
      url: "https://graph.microsoft.com/v1.0/teams/team-1/schedule/shifts/shift%2F1",
    });
    expect(events.filter((e) => e.startsWith("audit:"))).toEqual([
      "audit:graph_delete_shift_started",
      "audit:graph_delete_shift_succeeded",
    ]);
    expect(audits[0]?.subject).toBe("shift/1");
  });

  it("audits a failed delete and throws", async () => {
    reply(() => json({}, { status: 404 }));
    await expect(deleteShift(makeEnv(), "team-1", "s1", "shane@s-fx.com")).rejects.toMatchObject({ status: 404 });
    expect(audits.map((a) => a.action)).toEqual(["graph_delete_shift_started", "graph_delete_shift_failed"]);
  });
});

describe("listTeams", () => {
  it("lists Teams by id and name", async () => {
    reply(() => json({ value: [{ id: "t1", displayName: "Ops" }, { displayName: "no id" }, { id: "t2" }] }));
    expect(await listTeams(makeEnv())).toEqual([
      { id: "t1", displayName: "Ops" },
      { id: "t2", displayName: "t2" },
    ]);
  });

  it("degrades to an empty list on any failure", async () => {
    reply(() => json({}, { status: 403 }));
    expect(await listTeams(makeEnv())).toEqual([]);
    expect(await listTeams(makeEnv({ GRAPH_TENANT_ID: undefined }))).toEqual([]);
  });
});

describe("userDisplayName", () => {
  it("caches a departed user's 404 as no name", async () => {
    const kv = fakeKv({ "graph:app_token": "cached-token" });
    const env = makeEnv({}, kv);
    reply(() => json({}, { status: 404 }));
    expect(await userDisplayName(env, "gone")).toBeUndefined();
    expect(kv.store.get("graph:username:gone")).toBe("");
    expect(await userDisplayName(env, "gone")).toBeUndefined();
    expect(graphCalls()).toHaveLength(1);
  });
});
