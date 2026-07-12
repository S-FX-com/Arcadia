import { env, createExecutionContext } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, type VectorSearchFn } from "../../src/memory/store";
import type { VectorHit } from "../../src/memory/vector";
import type { Env } from "../../src/env";
import { handleMcp } from "../../src/mcp/server";
import { handleDashboard } from "../../src/webapp/dashboard-api";
import { handleSearch, type SearchDeps } from "../../src/webapp/search-api";
import type { Session } from "../../src/webapp/auth";
import { logger } from "../../src/lib/logger";

// P2 red-team suite (EXECUTION-PLAN §Phase 2, exit criterion).
//
// One adversary probes every read surface for another user's data. This
// is the gate that must stay green before staff beyond the admin get
// access: if any assertion here flips, a staff member can see something
// they shouldn't.
//
//   VICTIM   alice  — has data in a private channel, a 1:1 chat, her
//                     mailbox (user scope), and an observation about her.
//   ATTACKER mallory — same tenant, member of NOTHING alice is in, not
//                      admin. Every probe below must come back empty/denied.
//   CONTROL  alice herself, and the admin, retrieve the same data to prove
//            the suite fails closed rather than denying universally.
//
// Vectorize + Workers AI aren't simulatable in miniflare, so recall paths
// inject a stub VectorSearchFn returning the victim's vectors as if the
// semantic match succeeded — the ACL layer is the only thing standing
// between the attacker and the content. D1 hydration + ACL run for real.

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = testEnv.GRAPH_TENANT_ID;
const ALICE = "rt-alice";
const MALLORY = "rt-mallory";
const ADMIN = testEnv.ADMIN_USER_AAD_ID;

// alice's private surfaces
const PRIV_CHANNEL = "rt-alice-channel";
const PRIV_CHAT = "rt-alice-chat";
const ALICE_GROUP = "rt-alice-group"; // backs the private channel

function storeReturning(hits: VectorHit[]): MemoryStore {
  return new MemoryStore(env, (async () => hits) as VectorSearchFn);
}
function memHit(id: string, score = 0.9): VectorHit {
  return { id: `mem:${id}`, score, metadata: {} };
}

async function seedMemory(o: {
  id: string;
  kind: string;
  scopeType: string;
  scopeId: string;
  subject?: string | null;
  content?: string;
}): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO memories
       (id, kind, scope_type, scope_id, subject_aad_id, content, confidence)
     VALUES (?, ?, ?, ?, ?, ?, 1.0)`,
  )
    .bind(o.id, o.kind, o.scopeType, o.scopeId, o.subject ?? null, o.content ?? "secret")
    .run();
}
async function grant(rt: string, rid: string, pt: string, pid: string) {
  await env.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO resource_acl
       (resource_type, resource_id, principal_type, principal_id)
     VALUES (?, ?, ?, ?)`,
  ).bind(rt, rid, pt, pid).run();
}
async function addMember(groupId: string, aadId: string) {
  await env.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO group_membership (group_id, member_aad_id) VALUES (?, ?)`,
  ).bind(groupId, aadId).run();
}

beforeAll(async () => {
  // alice's private channel, backed by a group she is the sole member of
  await grant("channel", PRIV_CHANNEL, "group", ALICE_GROUP);
  await addMember(ALICE_GROUP, ALICE);
  // alice's 1:1 chat, granted directly to her (as chat member reconciliation does)
  await grant("chat", PRIV_CHAT, "user", ALICE);

  await seedMemory({
    id: "rt-chan-secret",
    kind: "semantic",
    scopeType: "channel",
    scopeId: PRIV_CHANNEL,
    content: "alice channel secret",
  });
  await seedMemory({
    id: "rt-chat-secret",
    kind: "episodic",
    scopeType: "chat",
    scopeId: PRIV_CHAT,
    content: "alice chat secret",
  });
  await seedMemory({
    id: "rt-mail-secret",
    kind: "semantic",
    scopeType: "user",
    scopeId: ALICE,
    subject: ALICE,
    content: "alice mailbox secret",
  });
  await seedMemory({
    id: "rt-obs-secret",
    kind: "observation",
    scopeType: "channel",
    scopeId: PRIV_CHANNEL,
    subject: ALICE,
    content: "alice goes quiet when overloaded",
  });
});

function recallAll(viewer: string, tenantId = TENANT) {
  // No kinds filter → every scope's hits are candidates; ACL is the gate.
  const store = storeReturning([
    memHit("rt-chan-secret"),
    memHit("rt-chat-secret"),
    memHit("rt-mail-secret"),
    memHit("rt-obs-secret"),
  ]);
  return store.recall("secret", { viewer, tenantId });
}

describe("red-team — memory recall", () => {
  it("attacker retrieves NONE of the victim's memories across all scopes", async () => {
    const hits = await recallAll(MALLORY);
    expect(hits).toHaveLength(0);
  });

  it("attacker in a DIFFERENT tenant also gets nothing", async () => {
    const hits = await recallAll(MALLORY, "rt-other-tenant");
    expect(hits).toHaveLength(0);
  });

  it("victim retrieves her own channel + chat + mail; her observation is self-visible", async () => {
    const ids = (await recallAll(ALICE)).map((h) => h.memory.id).sort();
    expect(ids).toEqual(
      ["rt-chan-secret", "rt-chat-secret", "rt-mail-secret", "rt-obs-secret"].sort(),
    );
  });

  it("even a same-channel member cannot see a third party's observation", async () => {
    // bob shares alice's channel but the observation is ABOUT alice.
    await addMember(ALICE_GROUP, "rt-bob");
    const store = storeReturning([memHit("rt-obs-secret"), memHit("rt-chan-secret")]);
    const hits = await store.recall("secret", { viewer: "rt-bob", tenantId: TENANT });
    // bob sees the shared channel semantic, never the personal observation.
    expect(hits.map((h) => h.memory.id)).toEqual(["rt-chan-secret"]);
  });
});

// --- MCP surface -------------------------------------------------------------

describe("red-team — MCP tools", () => {
  let keyResolver: JWTVerifyGetKey;
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
  });
  async function token(oid: string) {
    return new SignJWT({ tid: TENANT, oid })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
      .setAudience(testEnv.WEBAPP_CLIENT_ID)
      .sign(privateKey);
  }
  async function call(oid: string, name: string, args: Record<string, unknown>) {
    const res = await handleMcp(
      new Request("https://arcadia.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await token(oid)}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      testEnv,
      createExecutionContext(),
      log,
      { keyResolver },
    );
    return (await res.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
  }

  it("anonymous MCP call is rejected outright", async () => {
    const res = await handleMcp(
      new Request("https://arcadia.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      testEnv,
      createExecutionContext(),
      log,
    );
    expect(res.status).toBe(401);
  });

  it("recall_memory no longer accepts a caller-supplied viewer, and returns nothing for the attacker", async () => {
    const body = await call(MALLORY, "recall_memory", {
      query: "secret",
      // attacker tries the old escalation vector — impersonate alice.
      viewer_aad_id: ALICE,
    });
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("alice channel secret");
    expect(text).not.toContain("alice mailbox secret");
  });

  it("summarize_thread on the victim's channel is access_denied for the attacker", async () => {
    const body = await call(MALLORY, "summarize_thread", {
      team_id: "rt-team",
      channel_id: PRIV_CHANNEL,
      message_id: "rt-msg",
    });
    expect(body.result?.content?.[0]?.text ?? "").toContain("access_denied");
  });

  it("find_owner does not leak raw memory rationale to a non-admin", async () => {
    await seedMemory({
      id: "rt-owner-mem",
      kind: "semantic",
      scopeType: "tenant",
      scopeId: TENANT,
      content: "SENSITIVE-RATIONALE-STRING alice owns billing",
    });
    // find_owner recalls tenant-scoped (visible in-tenant), but rationale is
    // admin-only — the sensitive content string must not appear for mallory.
    const body = await call(MALLORY, "find_owner", { topic: "billing" });
    expect(body.result?.content?.[0]?.text ?? "").not.toContain(
      "SENSITIVE-RATIONALE-STRING",
    );
  });
});

// --- Dashboard + Search surfaces ---------------------------------------------

describe("red-team — dashboard + search", () => {
  function session(aadId: string, isAdmin = false): Session {
    return {
      aadId,
      tenantId: TENANT,
      exp: Math.floor(Date.now() / 1000) + 3600,
      isAdmin,
    };
  }

  it("attacker's dashboard shows no digest from the victim's private channel", async () => {
    await env.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO channels
         (channel_id, team_id, tenant_id, service_url, display_name)
       VALUES (?, 'rt-team', ?, 'https://svc', 'alice-private')`,
    ).bind(PRIV_CHANNEL, TENANT).run();
    await env.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO digests (id, channel_id, body, posted_at)
       VALUES ('rt-digest', ?, 'private digest', ?)`,
    ).bind(PRIV_CHANNEL, new Date().toISOString()).run();

    const res = await handleDashboard(
      new Request("https://arcadia.test/api/webapp/dashboard"),
      testEnv,
      session(MALLORY),
    );
    const body = (await res.json()) as { recentDigests: { channelId: string }[] };
    expect(body.recentDigests.map((d) => d.channelId)).not.toContain(PRIV_CHANNEL);
  });

  it("search runs strictly as the caller — attacker identity cannot be spoofed via session", async () => {
    // The delegated lane requires the graph token's identity to equal the
    // session identity. A stub deps proves the OBO token used is the
    // caller's, and an identity mismatch is refused.
    const usedTokens: string[] = [];
    const deps: SearchDeps = {
      resolveDelegated: async () => ({
        aadId: MALLORY,
        tenantId: TENANT,
        userToken: "mallory-user-token",
      }),
      delegatedGraphToken: async (_e, userToken) => {
        usedTokens.push(userToken);
        return "obo-for-mallory";
      },
      graph: async () => ({ value: [{ hitsContainers: [] }] }),
    };
    const res = await handleSearch(
      new Request("https://arcadia.test/api/webapp/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-graph-token": "t" },
        body: JSON.stringify({ query: "alice secrets" }),
      }),
      testEnv,
      session(MALLORY),
      log,
      deps,
    );
    expect(res.status).toBe(200);
    // The exchange used mallory's own token — never alice's identity.
    expect(usedTokens).toEqual(["mallory-user-token"]);
  });

  it("search refuses when the graph token identity != session identity", async () => {
    const deps: SearchDeps = {
      resolveDelegated: async () => ({
        aadId: ALICE, // token says alice...
        tenantId: TENANT,
        userToken: "alice-token",
      }),
      delegatedGraphToken: async () => "should-not-be-called",
      graph: async () => ({ value: [] }),
    };
    const res = await handleSearch(
      new Request("https://arcadia.test/api/webapp/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-graph-token": "t" },
        body: JSON.stringify({ query: "x" }),
      }),
      testEnv,
      session(MALLORY), // ...but session is mallory
      log,
      deps,
    );
    expect(res.status).toBe(403);
  });
});

// --- Admin control: the suite fails closed, not universally ------------------

describe("red-team — admin control (proves deny is scoped, not blanket)", () => {
  it("admin recall sees the victim's cross-scope memories", async () => {
    // Admin path passes no viewer → unfiltered recall (SOUL.md: Shane sees
    // across the org). This asserts the deny above is ACL-scoped, not a bug
    // that hides everything.
    const store = storeReturning([memHit("rt-chan-secret"), memHit("rt-mail-secret")]);
    const hits = await store.recall("secret", {}); // admin/unfiltered
    expect(hits.length).toBeGreaterThanOrEqual(2);
    void ADMIN;
  });
});
