// Integration tests for src/webapp/proposals-api.ts (the operator review
// queue, EXECUTION-PLAN §Phase 4) via the real route table in routes.ts.
//
// Sessions are minted the same way sources-api.test.ts does: a locally
// generated RSA keypair stands in for Microsoft's tenant JWKS (keyResolver
// seam), a real access token is signed against it, and exchangeAndSeal()
// produces the same sealed session cookie the /auth/exchange endpoint would.

import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { CharterStore } from "../../src/charter/store";
import { ProposalStore } from "../../src/learning/proposals";
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

function getReq(cookie: string, suffix = ""): Request {
  return new Request(`https://arcadia.test/api/webapp/proposals${suffix}`, {
    headers: { cookie },
  });
}

function postReq(cookie: string, suffix: string): Request {
  return new Request(`https://arcadia.test/api/webapp/proposals${suffix}`, {
    method: "POST",
    headers: { cookie },
  });
}

interface ProposalBody {
  id: string;
  kind: string;
  status: string;
}
interface ListBody {
  proposals: ProposalBody[];
}

describe("GET /api/webapp/proposals", () => {
  it("admin lists pending proposals", async () => {
    const store = new ProposalStore(testEnv);
    const seeded = await store.create({
      kind: "charter_amendment",
      origin: "eval",
      title: "prop-list-seed",
      payload: { suggestedClause: "Test clause.", failingTag: "prop-list-tag" },
    });

    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const ctx = createExecutionContext();
    const res = await handleWebapp(getReq(cookie, "?status=pending"), testEnv, ctx, log);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.proposals.map((p) => p.id)).toContain(seeded);
  });

  it("returns 403 for a non-admin", async () => {
    const cookie = await mintCookie("proposals-nonadmin-1");
    const ctx = createExecutionContext();
    const res = await handleWebapp(getReq(cookie), testEnv, ctx, log);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/webapp/proposals/:id/approve", () => {
  it("charter_amendment → publishes a new charter version and marks applied", async () => {
    const charter = new CharterStore(testEnv);
    const before = await charter.active();
    const beforeVersion = before?.version ?? 0;

    const clause = `Aegis is Arcadia's flagship product (${crypto.randomUUID()}).`;
    const store = new ProposalStore(testEnv);
    const id = await store.create({
      kind: "charter_amendment",
      origin: "eval",
      title: "prop-approve-charter",
      payload: { suggestedClause: clause, failingTag: "prop-approve-tag" },
    });

    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const ctx = createExecutionContext();
    const res = await handleWebapp(postReq(cookie, `/${id}/approve`), testEnv, ctx, log);
    expect(res.status).toBe(200);

    // A new charter version is published and carries the clause.
    const after = await charter.active();
    expect(after?.version).toBe(beforeVersion + 1);
    expect(after?.body).toContain(clause);

    // The proposal is now applied.
    const applied = await store.byId(id);
    expect(applied?.status).toBe("applied");
    expect(applied?.resolvedBy).toBe(testEnv.ADMIN_USER_AAD_ID);
  });

  it("returns 409 when the proposal is not pending", async () => {
    const store = new ProposalStore(testEnv);
    const id = await store.create({
      kind: "charter_amendment",
      origin: "eval",
      title: "prop-double-approve",
      payload: { suggestedClause: "Once only.", failingTag: "prop-double-tag" },
    });
    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);

    const first = await handleWebapp(
      postReq(cookie, `/${id}/approve`),
      testEnv,
      createExecutionContext(),
      log,
    );
    expect(first.status).toBe(200);

    const second = await handleWebapp(
      postReq(cookie, `/${id}/approve`),
      testEnv,
      createExecutionContext(),
      log,
    );
    expect(second.status).toBe(409);
  });
});

describe("POST /api/webapp/proposals/:id/reject", () => {
  it("marks the proposal rejected without applying it", async () => {
    const store = new ProposalStore(testEnv);
    const id = await store.create({
      kind: "memory_correction",
      origin: "eval",
      title: "prop-reject-seed",
      payload: { targetMemoryId: "does-not-matter" },
    });

    const cookie = await mintCookie(testEnv.ADMIN_USER_AAD_ID);
    const ctx = createExecutionContext();
    const res = await handleWebapp(postReq(cookie, `/${id}/reject`), testEnv, ctx, log);
    expect(res.status).toBe(200);

    const rejected = await store.byId(id);
    expect(rejected?.status).toBe("rejected");
  });

  it("returns 403 for a non-admin approving", async () => {
    const store = new ProposalStore(testEnv);
    const id = await store.create({
      kind: "charter_amendment",
      origin: "eval",
      title: "prop-nonadmin-approve",
      payload: { suggestedClause: "nope", failingTag: "prop-nonadmin-tag" },
    });
    const cookie = await mintCookie("proposals-nonadmin-2");
    const ctx = createExecutionContext();
    const res = await handleWebapp(postReq(cookie, `/${id}/approve`), testEnv, ctx, log);
    expect(res.status).toBe(403);
  });
});
