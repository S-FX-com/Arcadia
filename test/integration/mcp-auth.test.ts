import { env, createExecutionContext } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { handleMcp } from "../../src/mcp/server";
import { logger } from "../../src/lib/logger";

// Cast the pool's ProvidedEnv to the worker's Env contract.
const testEnv = env as unknown as Env;
const log = logger();

// Local RSA keypair stands in for Microsoft's tenant JWKS. The key
// resolver is threaded into handleMcp options, which forwards it to
// verifyEntraToken — the suite never touches login.microsoftonline.com.
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
    .setIssuer(`https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`)
    .setAudience(testEnv.WEBAPP_CLIENT_ID)
    .sign(privateKey);
}

function mcpRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://arcadia.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("mcp auth", () => {
  it("returns 401 for an anonymous call (no cookie, no bearer)", async () => {
    const ctx = createExecutionContext();
    const res = await handleMcp(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("unauthorized");
  });

  it("accepts a verified bearer token and lists tools", async () => {
    const ctx = createExecutionContext();
    const token = await mintToken("user-nonadmin-1");
    const res = await handleMcp(
      mcpRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { authorization: `Bearer ${token}` },
      ),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    expect(Array.isArray(body.result?.tools)).toBe(true);
    expect(body.result?.tools?.some((t) => t.name === "recall_memory")).toBe(
      true,
    );
  });

  it("no longer advertises viewer_aad_id on recall_memory", async () => {
    const ctx = createExecutionContext();
    const token = await mintToken("user-nonadmin-1");
    const res = await handleMcp(
      mcpRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        { authorization: `Bearer ${token}` },
      ),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    const body = (await res.json()) as {
      result?: {
        tools?: {
          name: string;
          inputSchema: { properties?: Record<string, unknown> };
        }[];
      };
    };
    const recall = body.result?.tools?.find((t) => t.name === "recall_memory");
    expect(recall).toBeDefined();
    expect(recall?.inputSchema.properties).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        recall?.inputSchema.properties ?? {},
        "viewer_aad_id",
      ),
    ).toBe(false);
  });

  it("gates summarize_thread behind admin for non-admin callers", async () => {
    const ctx = createExecutionContext();
    const token = await mintToken("user-nonadmin-1");
    const res = await handleMcp(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "summarize_thread",
            arguments: {
              team_id: "t1",
              channel_id: "c1",
              message_id: "m1",
            },
          },
        },
        { authorization: `Bearer ${token}` },
      ),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("admin_required");
  });

  it("passes the admin gate for the admin caller (oid = ADMIN_USER_AAD_ID)", async () => {
    const ctx = createExecutionContext();
    // ADMIN_USER_AAD_ID is set in vitest.integration.config.ts.
    const token = await mintToken(testEnv.ADMIN_USER_AAD_ID);
    const res = await handleMcp(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "summarize_thread",
            arguments: {
              team_id: "t1",
              channel_id: "c1",
              message_id: "m1",
            },
          },
        },
        { authorization: `Bearer ${token}` },
      ),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    // Admin clears the auth gate. The tool then reaches out to Graph and
    // will fail there (no live Graph in the harness) — a stub-level
    // assertion is enough: it must NOT be blocked with admin_required.
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("admin_required");
  });
});
