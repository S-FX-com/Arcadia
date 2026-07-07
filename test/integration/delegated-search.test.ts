// Integration tests for P2 item 5 of EXECUTION-PLAN.md: the delegated
// (on-behalf-of) Graph lane — src/graph/delegated.ts::resolveDelegated and
// its first real call site, src/webapp/search-api.ts.
//
// A locally-generated RSA keypair stands in for Microsoft's tenant JWKS
// (the keyResolver test seam threaded through verifyEntraToken), exactly
// like test/integration/webapp-auth.test.ts and sources-api.test.ts.
// Session cookies are minted via the real exchangeAndSeal(); the search
// handler's Graph calls are stubbed via its injectable SearchDeps seam so
// no live Entra tenant or Graph endpoint is touched.
import { createExecutionContext, env } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import {
  DelegatedAuthError,
  resolveDelegated,
} from "../../src/graph/delegated";
import { logger } from "../../src/lib/logger";
import { exchangeAndSeal, type Session } from "../../src/webapp/auth";
import { handleWebapp } from "../../src/webapp/routes";
import {
  handleSearch,
  type SearchDeps,
} from "../../src/webapp/search-api";

const testEnv = env as unknown as Env;
const log = logger();

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

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
    .setIssuer(`https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`)
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
}

async function mintCookie(oid: string): Promise<{ cookie: string; session: Session }> {
  const token = await mintToken(oid);
  const { session, cookie } = await exchangeAndSeal(testEnv, token, {
    keyResolver,
  });
  return { cookie: cookie.split(";")[0] ?? "", session };
}

const CANNED_SEARCH_RESPONSE = {
  value: [
    {
      hitsContainers: [
        {
          hits: [
            {
              hitId: "hit-1",
              summary: "A quarterly plan document",
              resource: {
                "@odata.type": "#microsoft.graph.driveItem",
                id: "drive-item-1",
                name: "Q3 Plan.docx",
                webUrl: "https://contoso.sharepoint.com/Q3Plan.docx",
                lastModifiedDateTime: "2026-06-01T12:00:00Z",
              },
            },
            {
              hitId: "hit-2",
              summary: "Re: budget approval",
              resource: {
                "@odata.type": "#microsoft.graph.message",
                id: "message-1",
                subject: "Re: budget approval",
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("resolveDelegated", () => {
  it("resolves a verified identity from x-graph-token", async () => {
    const token = await mintToken("delegated-user-1");
    const request = new Request("https://arcadia.test/api/webapp/search", {
      headers: { "x-graph-token": token },
    });

    const identity = await resolveDelegated(testEnv, request, { keyResolver });

    expect(identity.aadId).toBe("delegated-user-1");
    expect(identity.tenantId).toBe(testEnv.GRAPH_TENANT_ID);
    expect(identity.userToken).toBe(token);
  });

  it("throws missing_token when the header is absent", async () => {
    const request = new Request("https://arcadia.test/api/webapp/search");

    await expect(resolveDelegated(testEnv, request, { keyResolver })).rejects.toMatchObject(
      { reason: "missing_token" },
    );
    await expect(
      resolveDelegated(testEnv, request, { keyResolver }),
    ).rejects.toBeInstanceOf(DelegatedAuthError);
  });

  it("throws a verification error for a garbage token", async () => {
    const request = new Request("https://arcadia.test/api/webapp/search", {
      headers: { "x-graph-token": "not.a.valid.jwt" },
    });

    let caught: unknown;
    try {
      await resolveDelegated(testEnv, request, { keyResolver });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DelegatedAuthError);
    expect((caught as DelegatedAuthError).reason).not.toBe("missing_token");
  });
});

function searchRequest(graphToken: string, body: unknown, cookie?: string): Request {
  return new Request("https://arcadia.test/api/webapp/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-graph-token": graphToken,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("handleSearch (direct, with injected OBO/graph seams)", () => {
  it("exchanges via OBO and maps the /search/query response, using the OBO token on the Graph call", async () => {
    const { session } = await mintCookie("delegated-search-user-1");
    const graphToken = await mintToken("delegated-search-user-1");

    const passedTokens: (string | undefined)[] = [];
    let requestedUserToken: string | undefined;
    const OBO_TOKEN = "fake-obo-graph-token";

    const deps: SearchDeps = {
      resolveDelegated,
      delegatedGraphToken: async (_env, userToken) => {
        requestedUserToken = userToken;
        return OBO_TOKEN;
      },
      graph: async (_env, req) => {
        passedTokens.push(req.token);
        return CANNED_SEARCH_RESPONSE as never;
      },
    };

    const res = await handleSearch(
      searchRequest(graphToken, { query: "quarterly plan" }),
      testEnv,
      session,
      log,
      deps,
      { keyResolver },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: {
        type: string;
        id: string;
        title: string | null;
        summary: string | null;
      }[];
    };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      type: "driveItem",
      id: "drive-item-1",
      title: "Q3 Plan.docx",
      summary: "A quarterly plan document",
    });
    expect(body.results[1]).toMatchObject({
      type: "message",
      id: "message-1",
      title: "Re: budget approval",
    });

    // The Graph call used the OBO-exchanged token, not any app-only token.
    expect(passedTokens).toEqual([OBO_TOKEN]);
    // The OBO exchange itself received the verified user's raw token.
    expect(requestedUserToken).toBe(graphToken);
  });

  it("returns 403 identity_mismatch when the x-graph-token oid differs from the session", async () => {
    const { session } = await mintCookie("delegated-search-user-A");
    const otherUsersToken = await mintToken("delegated-search-user-B");

    const deps: SearchDeps = {
      resolveDelegated,
      delegatedGraphToken: async () => {
        throw new Error("should not be reached");
      },
      graph: async () => {
        throw new Error("should not be reached");
      },
    };

    const res = await handleSearch(
      searchRequest(otherUsersToken, { query: "anything" }),
      testEnv,
      session,
      log,
      deps,
      { keyResolver },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("identity_mismatch");
  });

  it("returns 502 obo_failed when the OBO exchange throws", async () => {
    const { session } = await mintCookie("delegated-search-user-2");
    const graphToken = await mintToken("delegated-search-user-2");

    const deps: SearchDeps = {
      resolveDelegated,
      delegatedGraphToken: async () => {
        throw new Error("AADSTS65001: consent required");
      },
      graph: async () => {
        throw new Error("should not be reached");
      },
    };

    const res = await handleSearch(
      searchRequest(graphToken, { query: "anything" }),
      testEnv,
      session,
      log,
      deps,
      { keyResolver },
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("obo_failed");
  });
});

describe("POST /api/webapp/search — routed via handleWebapp", () => {
  it("returns 401 with no session cookie at all", async () => {
    const graphToken = await mintToken("delegated-search-user-3");
    const ctx = createExecutionContext();
    const res = await handleWebapp(
      searchRequest(graphToken, { query: "anything" }),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});
