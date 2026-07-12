// Integration tests for src/webapp/sources-api.ts (P1.7 — ingest
// observability surface) via the real route table in src/webapp/routes.ts.
//
// Sessions are minted the same way test/integration/webapp-auth.test.ts
// does: a locally-generated RSA keypair stands in for Microsoft's tenant
// JWKS (keyResolver seam), a real access token is signed against it, and
// exchangeAndSeal() produces the same sealed session cookie the real
// /api/webapp/auth/exchange endpoint would issue. handleWebapp() is then
// exercised end to end, exactly like production traffic.
//
// ingest_runs.source values used here ('mail', 'consumer') are deliberately
// distinct from 'registry', which src/graph/registry.ts (exercised by
// test/integration/registry.test.ts) writes real rows for in the same
// shared D1 — this avoids cross-test interference on the aggregate/latest
// assertions below.
import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { exchangeAndSeal } from "../../src/webapp/auth";
import { handleWebapp } from "../../src/webapp/routes";

const testEnv = env as unknown as Env;
const log = logger();

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
});

async function mintCookie(oid: string): Promise<string> {
  const token = await new SignJWT({ tid: testEnv.GRAPH_TENANT_ID, oid })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(`https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`)
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
  const { cookie } = await exchangeAndSeal(testEnv, token, { keyResolver });
  return cookie.split(";")[0] ?? "";
}

function sourcesRequest(cookie: string, suffix = ""): Request {
  return new Request(`https://arcadia.test/api/webapp/sources${suffix}`, {
    headers: { cookie },
  });
}

function deleteRequest(cookie: string, id: string): Request {
  return new Request(`https://arcadia.test/api/webapp/sources/${id}`, {
    method: "DELETE",
    headers: { cookie },
  });
}

async function insertDocument(doc: {
  id: string;
  source: string;
  resourceId: string;
  ownerAadId: string | null;
  indexedAt: string;
}): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO documents (id, source, resource_id, owner_aad_id, title, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      doc.id,
      doc.source,
      doc.resourceId,
      doc.ownerAadId,
      `Doc ${doc.id}`,
      doc.indexedAt,
    )
    .run();
}

async function insertIngestRun(run: {
  id: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  enqueued: number;
  processed: number;
  failures: number;
}): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO ingest_runs
       (id, source, started_at, finished_at, enqueued, processed, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      run.id,
      run.source,
      run.startedAt,
      run.finishedAt,
      run.enqueued,
      run.processed,
      run.failures,
    )
    .run();
}

async function insertDeltaState(row: {
  resource: string;
  scopeKey: string;
  lastRunAt: string;
}): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO delta_state (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, 'tok', ?)`,
  )
    .bind(row.resource, row.scopeKey, row.lastRunAt)
    .run();
}

interface IngestSourceStatusBody {
  source: string;
  latest: {
    startedAt: string;
    finishedAt: string | null;
    enqueued: number;
    processed: number;
    failures: number;
  } | null;
  last24h: {
    enqueued: number;
    processed: number;
    failures: number;
    runs: number;
  };
}

interface SourcesResponseBody {
  sources: {
    id: string;
    resourceType: string;
    resourceId: string;
    updatedAt: number;
  }[];
  ingest: IngestSourceStatusBody[];
  freshness: { source: string; count: number; latestIndexedAt: string | null }[];
  deltaState: { resource: string; count: number; lastRunAt: string | null }[];
}

describe("GET /api/webapp/sources — admin", () => {
  it("sees all documents, every known ingest source, and delta_state", async () => {
    const ownerA = "sources-admin-owner-a";
    const ownerB = "sources-admin-owner-b";
    await insertDocument({
      id: "sources-doc-admin-a",
      source: "sharepoint_page",
      resourceId: "res-a",
      ownerAadId: ownerA,
      indexedAt: new Date().toISOString(),
    });
    await insertDocument({
      id: "sources-doc-admin-b",
      source: "drive_item",
      resourceId: "res-b",
      ownerAadId: ownerB,
      indexedAt: new Date().toISOString(),
    });

    await insertDeltaState({
      resource: "sources-admin-resource",
      scopeKey: "scope-1",
      lastRunAt: "2026-01-01T00:00:00.000Z",
    });
    await insertDeltaState({
      resource: "sources-admin-resource",
      scopeKey: "scope-2",
      lastRunAt: "2026-02-02T00:00:00.000Z",
    });

    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      sourcesRequest(cookie),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SourcesResponseBody;

    // Sees both owners' documents.
    const ids = body.sources.map((s) => s.id);
    expect(ids).toContain("sources-doc-admin-a");
    expect(ids).toContain("sources-doc-admin-b");

    // Every known ingest source is represented, even ones with no rows.
    expect(body.ingest.map((s) => s.source).sort()).toEqual(
      [
        "calendar",
        "consumer",
        "drives",
        "mail",
        "meetings",
        "messages",
        "registry",
        "sharepoint",
      ].sort(),
    );

    // delta_state aggregated per resource, not per scope_key.
    const resourceRow = body.deltaState.find(
      (r) => r.resource === "sources-admin-resource",
    );
    expect(resourceRow?.count).toBe(2);
    expect(resourceRow?.lastRunAt).toBe("2026-02-02T00:00:00.000Z");

    // Freshness reflects both owners' documents for this source.
    const freshRow = body.freshness.find((f) => f.source === "sharepoint_page");
    expect(freshRow?.count).toBeGreaterThanOrEqual(1);
  });

  it("computes latest run + rolling 24h aggregate correctly, excluding runs older than 24h", async () => {
    const now = Date.now();
    const recentStart = new Date(now - 10 * 60 * 1000).toISOString(); // 10 min ago
    const recentFinish = new Date(now - 9 * 60 * 1000).toISOString();
    const staleStart = new Date(now - 30 * 3600 * 1000).toISOString(); // 30h ago
    const staleFinish = new Date(now - 29 * 3600 * 1000).toISOString();

    // Stale run — outside the 24h window, and older than the recent run,
    // so it must not affect `latest` or `last24h`.
    await insertIngestRun({
      id: "sources-mail-run-stale",
      source: "mail",
      startedAt: staleStart,
      finishedAt: staleFinish,
      enqueued: 100,
      processed: 100,
      failures: 100,
    });
    // Recent run — inside the 24h window.
    await insertIngestRun({
      id: "sources-mail-run-recent",
      source: "mail",
      startedAt: recentStart,
      finishedAt: recentFinish,
      enqueued: 7,
      processed: 5,
      failures: 2,
    });

    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      sourcesRequest(cookie),
      testEnv,
      ctx,
      log,
    );
    const body = (await res.json()) as SourcesResponseBody;

    const mail = body.ingest.find((s) => s.source === "mail");
    expect(mail?.latest?.startedAt).toBe(recentStart);
    expect(mail?.latest?.enqueued).toBe(7);
    expect(mail?.last24h).toEqual({
      enqueued: 7,
      processed: 5,
      failures: 2,
      runs: 1,
    });
  });
});

describe("GET /api/webapp/sources — non-admin", () => {
  it("gets ingest: [] and deltaState: [], and only its own documents/freshness", async () => {
    const viewer = "sources-nonadmin-viewer-1";
    const other = "sources-nonadmin-other-1";

    await insertDocument({
      id: "sources-doc-nonadmin-mine",
      source: "chat_message",
      resourceId: "res-mine",
      ownerAadId: viewer,
      indexedAt: new Date().toISOString(),
    });
    await insertDocument({
      id: "sources-doc-nonadmin-other",
      source: "chat_message",
      resourceId: "res-other",
      ownerAadId: other,
      indexedAt: new Date().toISOString(),
    });
    // Give the ingest cycle machinery some rows so we can prove a
    // non-admin still gets `[]` rather than a filtered view of them.
    await insertIngestRun({
      id: "sources-nonadmin-consumer-run",
      source: "consumer",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      enqueued: 3,
      processed: 3,
      failures: 0,
    });

    const cookie = await mintCookie(viewer);
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      sourcesRequest(cookie),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SourcesResponseBody;

    expect(body.ingest).toEqual([]);
    expect(body.deltaState).toEqual([]);

    const ids = body.sources.map((s) => s.id);
    expect(ids).toContain("sources-doc-nonadmin-mine");
    expect(ids).not.toContain("sources-doc-nonadmin-other");

    // Freshness is scoped to the viewer's own documents only: the count
    // for 'chat_message' must reflect exactly the viewer's one document,
    // not both owners' combined total.
    const freshRow = body.freshness.find((f) => f.source === "chat_message");
    expect(freshRow?.count).toBe(1);
  });
});

describe("DELETE /api/webapp/sources/:id — forget", () => {
  it("lets the owner forget their own document", async () => {
    const owner = "sources-forget-owner-1";
    await insertDocument({
      id: "sources-doc-forget-owner",
      source: "drive_item",
      resourceId: "res-forget-1",
      ownerAadId: owner,
      indexedAt: new Date().toISOString(),
    });

    const cookie = await mintCookie(owner);
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      deleteRequest(cookie, "sources-doc-forget-owner"),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(204);

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT id FROM documents WHERE id = ?`,
    )
      .bind("sources-doc-forget-owner")
      .first();
    expect(row).toBeNull();
  });

  it("forbids a non-owner, non-admin from forgetting someone else's document", async () => {
    const owner = "sources-forget-owner-2";
    const intruder = "sources-forget-intruder-1";
    await insertDocument({
      id: "sources-doc-forget-protected",
      source: "drive_item",
      resourceId: "res-forget-2",
      ownerAadId: owner,
      indexedAt: new Date().toISOString(),
    });

    const cookie = await mintCookie(intruder);
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      deleteRequest(cookie, "sources-doc-forget-protected"),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(403);

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT id FROM documents WHERE id = ?`,
    )
      .bind("sources-doc-forget-protected")
      .first();
    expect(row).not.toBeNull();
  });

  it("returns 404 for an unknown document id", async () => {
    const cookie = await mintCookie("sources-forget-viewer-404");
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      deleteRequest(cookie, "sources-doc-does-not-exist"),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(404);
  });
});
