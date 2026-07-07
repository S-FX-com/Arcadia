import { env, createExecutionContext } from "cloudflare:test";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { handleGraphNotification } from "../../src/graph/subscriptions";
import { logger } from "../../src/lib/logger";

const testEnv = env as unknown as Env;
const log = logger();

// Local keypair stands in for Microsoft's common signing keys; threaded
// into handleGraphNotification via the keyResolver option seam.
let keyResolver: JWTVerifyGetKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  keyResolver = (() => pair.publicKey) as unknown as JWTVerifyGetKey;
});

async function mintValidationToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(
      `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`,
    )
    .setAudience(testEnv.GRAPH_CLIENT_ID)
    .sign(privateKey);
}

function postJson(body: unknown): Request {
  return new Request("https://arcadia.test/api/graph/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("graph webhook validation", () => {
  it("echoes the validationToken query param on the handshake", async () => {
    const ctx = createExecutionContext();
    const res = await handleGraphNotification(
      new Request(
        "https://arcadia.test/api/graph/notify?validationToken=xyz",
        { method: "POST" },
      ),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("xyz");
  });

  it("returns 202 for a basic notification with an unknown subscription", async () => {
    const ctx = createExecutionContext();
    const res = await handleGraphNotification(
      postJson({
        value: [
          {
            subscriptionId: "unknown-sub",
            clientState: "whatever",
            changeType: "created",
            resource: "teams/x/channels/y/messages/z",
          },
        ],
      }),
      testEnv,
      ctx,
      log,
    );
    // clientState does not match any stored subscription → skipped, but
    // the delivery is still acknowledged.
    expect(res.status).toBe(202);
  });

  it("rejects resource-data notifications that carry no validationTokens", async () => {
    const ctx = createExecutionContext();
    const res = await handleGraphNotification(
      postJson({
        value: [
          {
            subscriptionId: "s1",
            clientState: "whatever",
            changeType: "created",
            resource: "teams/x/channels/y/messages/z",
            encryptedContent: { data: "…", dataSignature: "…" },
          },
        ],
      }),
      testEnv,
      ctx,
      log,
    );
    expect(res.status).toBe(401);
  });

  it("accepts a notification whose validationTokens verify", async () => {
    const ctx = createExecutionContext();
    const token = await mintValidationToken();
    const res = await handleGraphNotification(
      postJson({
        value: [
          {
            subscriptionId: "s1",
            clientState: "whatever",
            changeType: "created",
            resource: "teams/x/channels/y/messages/z",
          },
        ],
        validationTokens: [token],
      }),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    // Token verifies → validation passes; the (unknown) subscription is
    // then skipped on clientState, and the delivery is acknowledged.
    expect(res.status).toBe(202);
  });

  it("rejects a notification whose validationTokens fail to verify", async () => {
    const ctx = createExecutionContext();
    // Sign with the correct key but a wrong audience so verification fails.
    const badToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(
        `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`,
      )
      .setAudience("some-other-audience")
      .sign(privateKey);
    const res = await handleGraphNotification(
      postJson({
        value: [
          {
            subscriptionId: "s1",
            clientState: "whatever",
            changeType: "created",
            resource: "teams/x/channels/y/messages/z",
          },
        ],
        validationTokens: [badToken],
      }),
      testEnv,
      ctx,
      log,
      { keyResolver },
    );
    expect(res.status).toBe(401);
  });
});
