import { env, createExecutionContext } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, type VectorSearchFn } from "../../src/memory/store";
import type { VectorHit } from "../../src/memory/vector";
import type { Env } from "../../src/env";
import { handleMcp } from "../../src/mcp/server";
import { handleDashboard } from "../../src/webapp/dashboard-api";
import type { Session } from "../../src/webapp/auth";
import { logger } from "../../src/lib/logger";

// P2 (EXECUTION-PLAN §2 items 2 + 4): the ACL default is now DENY, not
// tenant-open. These tests pin the new semantics end-to-end:
//   - empty-ACL non-user/non-tenant scope → denied to non-admins
//   - 'user' scope → owner-only (identity is the grant, no rows)
//   - 'tenant' scope → open to any in-tenant viewer
//   - group grants → member allowed, non-member denied
//   - observation subject-privacy → third-party observations dropped, other
//     kinds from the same accessible scope kept
//   - MCP summarize_thread → per-channel ACL check
//   - dashboard digests → only ACL-accessible channels
//
// Vectorize + Workers AI are not simulatable under miniflare, so recall paths
// inject a stub VectorSearchFn; D1 hydration + ACL run against the real
// migrated binding.

const testEnv = env as unknown as Env;
const log = logger();

function storeReturning(hits: VectorHit[]): MemoryStore {
  const search: VectorSearchFn = async () => hits;
  return new MemoryStore(env, search);
}

function memHit(id: string, score: number): VectorHit {
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
    `INSERT INTO memories (id, kind, scope_type, scope_id, subject_aad_id, content, confidence)
     VALUES (?, ?, ?, ?, ?, ?, 1.0)`,
  )
    .bind(
      o.id,
      o.kind,
      o.scopeType,
      o.scopeId,
      o.subject ?? null,
      o.content ?? "fact",
    )
    .run();
}

async function grant(
  resourceType: string,
  resourceId: string,
  principalType: string,
  principalId: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO resource_acl
       (resource_type, resource_id, principal_type, principal_id)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(resourceType, resourceId, principalType, principalId)
    .run();
}

async function addMember(groupId: string, memberAadId: string): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR IGNORE INTO group_membership (group_id, member_aad_id) VALUES (?, ?)`,
  )
    .bind(groupId, memberAadId)
    .run();
}

describe("default-deny — recall ACL", () => {
  it("empty-ACL channel scope is denied to a non-admin viewer", async () => {
    await seedMemory({
      id: "dd-empty",
      kind: "semantic",
      scopeType: "channel",
      scopeId: "dd-chan-empty",
    });
    const store = storeReturning([memHit("dd-empty", 0.9)]);
    const hits = await store.recall("x", {
      viewer: "dd-viewer",
      tenantId: "dd-tenant",
    });
    expect(hits).toHaveLength(0);
  });

  it("'user' scope is owner-only regardless of ACL rows", async () => {
    await seedMemory({
      id: "dd-user",
      kind: "semantic",
      scopeType: "user",
      scopeId: "dd-owner",
      subject: null,
    });
    const store = storeReturning([memHit("dd-user", 0.9)]);

    const owner = await store.recall("x", {
      viewer: "dd-owner",
      tenantId: "dd-tenant",
    });
    expect(owner).toHaveLength(1);

    const other = await store.recall("x", {
      viewer: "dd-someone-else",
      tenantId: "dd-tenant",
    });
    expect(other).toHaveLength(0);
  });

  it("'tenant' scope is open to any viewer in the same tenant", async () => {
    await seedMemory({
      id: "dd-tenant-mem",
      kind: "semantic",
      scopeType: "tenant",
      scopeId: "dd-tenant-A",
    });
    const store = storeReturning([memHit("dd-tenant-mem", 0.9)]);

    const inTenant = await store.recall("x", {
      viewer: "dd-anyone",
      tenantId: "dd-tenant-A",
    });
    expect(inTenant).toHaveLength(1);

    const crossTenant = await store.recall("x", {
      viewer: "dd-anyone",
      tenantId: "dd-tenant-B",
    });
    expect(crossTenant).toHaveLength(0);
  });

  it("group grant allows a member and denies a non-member", async () => {
    await seedMemory({
      id: "dd-grp",
      kind: "semantic",
      scopeType: "channel",
      scopeId: "dd-chan-grp",
    });
    await grant("channel", "dd-chan-grp", "group", "dd-group");
    await addMember("dd-group", "dd-member");

    const store = storeReturning([memHit("dd-grp", 0.9)]);

    const member = await store.recall("x", {
      viewer: "dd-member",
      tenantId: "dd-tenant",
    });
    expect(member).toHaveLength(1);

    const nonMember = await store.recall("x", {
      viewer: "dd-outsider",
      tenantId: "dd-tenant",
    });
    expect(nonMember).toHaveLength(0);
  });

  it("subject-privacy drops a third-party observation but keeps a semantic from the same scope", async () => {
    // Same accessible channel scope (group-granted to the viewer), two hits:
    // an observation about a third party (must be dropped) and a semantic
    // (must survive).
    await seedMemory({
      id: "dd-obs",
      kind: "observation",
      scopeType: "channel",
      scopeId: "dd-chan-priv",
      subject: "dd-third-party",
      content: "third party tends to reply late",
    });
    await seedMemory({
      id: "dd-sem",
      kind: "semantic",
      scopeType: "channel",
      scopeId: "dd-chan-priv",
      subject: "dd-third-party",
      content: "the project ships in Q4",
    });
    await grant("channel", "dd-chan-priv", "group", "dd-group-priv");
    await addMember("dd-group-priv", "dd-priv-viewer");

    const store = storeReturning([
      memHit("dd-obs", 0.95),
      memHit("dd-sem", 0.9),
    ]);
    const hits = await store.recall("x", {
      viewer: "dd-priv-viewer",
      tenantId: "dd-tenant",
    });
    expect(hits.map((h) => h.memory.kind)).toEqual(["semantic"]);
    expect(hits[0]!.memory.id).toBe("dd-sem");
  });
});

// --- MCP summarize_thread per-channel ACL ------------------------------------

describe("default-deny — MCP summarize_thread", () => {
  let keyResolver: JWTVerifyGetKey;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
  });

  async function mintToken(oid: string): Promise<string> {
    return new SignJWT({ tid: testEnv.GRAPH_TENANT_ID, oid })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(
        `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`,
      )
      .setAudience(testEnv.WEBAPP_CLIENT_ID)
      .sign(privateKey);
  }

  async function callSummarize(oid: string, channelId: string) {
    const ctx = createExecutionContext();
    const token = await mintToken(oid);
    const res = await handleMcp(
      new Request("https://arcadia.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "summarize_thread",
            arguments: {
              team_id: "dd-team",
              channel_id: channelId,
              message_id: "dd-msg",
            },
          },
        }),
      }),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    return body.result?.content?.[0]?.text ?? "";
  }

  it("denies a non-admin without a channel ACL grant", async () => {
    const text = await callSummarize("dd-mcp-outsider", "dd-mcp-nogrant");
    expect(text).toContain("access_denied");
  });

  it("clears the ACL gate for a non-admin with a channel group grant", async () => {
    await grant("channel", "dd-mcp-granted", "group", "dd-mcp-group");
    await addMember("dd-mcp-group", "dd-mcp-member");
    const text = await callSummarize("dd-mcp-member", "dd-mcp-granted");
    // Passes the ACL gate, then fails downstream at Graph (no live Graph in
    // the harness). The key assertion: it is NOT blocked by access_denied.
    expect(text).not.toContain("access_denied");
  });
});

// --- Dashboard digests scoped by ACL -----------------------------------------

describe("default-deny — dashboard digests", () => {
  async function seedChannelWithDigest(
    channelId: string,
    tenantId: string,
  ): Promise<void> {
    await env.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO channels
         (channel_id, team_id, tenant_id, service_url, display_name)
       VALUES (?, 'dd-team', ?, 'https://svc', ?)`,
    )
      .bind(channelId, tenantId, channelId)
      .run();
    await env.ARCADIA_DB.prepare(
      `INSERT INTO digests (id, channel_id, body, posted_at)
       VALUES (?, ?, 'digest body', ?)`,
    )
      .bind(`digest-${channelId}`, channelId, new Date().toISOString())
      .run();
  }

  it("returns digests only for channels the non-admin viewer can access", async () => {
    await seedChannelWithDigest("dd-dash-allowed", "dd-dash-tenant");
    await seedChannelWithDigest("dd-dash-denied", "dd-dash-tenant");
    await grant("channel", "dd-dash-allowed", "user", "dd-dash-viewer");

    const session: Session = {
      aadId: "dd-dash-viewer",
      tenantId: "dd-dash-tenant",
      exp: Math.floor(Date.now() / 1000) + 3600,
      isAdmin: false,
    };
    const res = await handleDashboard(
      new Request("https://arcadia.test/api/webapp/dashboard"),
      testEnv,
      session,
    );
    const body = (await res.json()) as {
      recentDigests: { channelId: string }[];
    };
    const ids = body.recentDigests.map((d) => d.channelId);
    expect(ids).toContain("dd-dash-allowed");
    expect(ids).not.toContain("dd-dash-denied");
  });
});
