// Integration tests for src/webapp/auth.ts exchangeAndSeal + readSession,
// exercising the real verifyEntraToken path (src/lib/entra-verify.ts)
// against a local JWKS via the keyResolver test seam — no network calls
// to Microsoft's tenant discovery endpoint.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import type { Env } from "../../src/env";
import { exchangeAndSeal, readSession } from "../../src/webapp/auth";

const testEnv = env as unknown as Env;

const ISSUER = `https://login.microsoftonline.com/${testEnv.GRAPH_TENANT_ID}/v2.0`;
const AUDIENCE = testEnv.WEBAPP_CLIENT_ID;
const TENANT_ID = testEnv.GRAPH_TENANT_ID;

async function makeKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key-1";
  const jwkWithKid: JWK = { ...publicJwk, kid, alg: "RS256", use: "sig" };
  const keyResolver: JWTVerifyGetKey = createLocalJWKSet({
    keys: [jwkWithKid],
  });
  return { privateKey, kid, keyResolver };
}

interface ClaimOverrides {
  iss?: string;
  aud?: string;
  tid?: string;
  oid?: string;
  exp?: number;
  kid?: string;
}

async function signToken(
  privateKey: KeyLike,
  kid: string,
  overrides: ClaimOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    tid: overrides.tid ?? TENANT_ID,
    oid: overrides.oid ?? "aad-oid-user-1",
    upn: "user1@example.com",
    name: "Test User",
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? kid })
    .setIssuedAt(now - 10)
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setExpirationTime(overrides.exp ?? now + 3600);
  return jwt.sign(privateKey);
}

describe("exchangeAndSeal (real Entra verification path)", () => {
  it("accepts a validly-signed v2.0 token and seals a session cookie", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      oid: "aad-oid-happy-path",
    });

    const { session, cookie } = await exchangeAndSeal(testEnv, token, {
      keyResolver,
    });

    expect(session.aadId).toBe("aad-oid-happy-path");
    expect(session.tenantId).toBe(TENANT_ID);
    expect(session.upn).toBe("user1@example.com");
    expect(cookie).toContain("arcadia_session=");
  });

  it("rejects an unsigned / garbage token", async () => {
    const { keyResolver } = await makeKeyPair();
    await expect(
      exchangeAndSeal(testEnv, "not.a.jwt", { keyResolver }),
    ).rejects.toThrow();
  });

  it("rejects a token signed by a different key than the resolver knows", async () => {
    const { keyResolver } = await makeKeyPair();
    const other = await makeKeyPair();
    // Signed with `other`'s private key + kid, but the resolver only knows
    // the first key pair's public key -- kid lookup miss / signature fail.
    const token = await signToken(other.privateKey, other.kid);

    await expect(
      exchangeAndSeal(testEnv, token, { keyResolver }),
    ).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      aud: "00000000-0000-0000-0000-000000000000",
    });

    await expect(
      exchangeAndSeal(testEnv, token, { keyResolver }),
    ).rejects.toThrow();
  });

  it("rejects a token with the wrong tenant id", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      tid: "99999999-9999-9999-9999-999999999999",
    });

    await expect(
      exchangeAndSeal(testEnv, token, { keyResolver }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const now = Math.floor(Date.now() / 1000);
    // Well beyond the 60s clock-skew tolerance in verifyEntraToken.
    const token = await signToken(privateKey, kid, { exp: now - 3600 });

    await expect(
      exchangeAndSeal(testEnv, token, { keyResolver }),
    ).rejects.toThrow();
  });

  it("rejects a v1.0-style issuer (sts.windows.net)", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      iss: `https://sts.windows.net/${TENANT_ID}/`,
    });

    await expect(
      exchangeAndSeal(testEnv, token, { keyResolver }),
    ).rejects.toThrow();
  });
});

describe("readSession round-trip", () => {
  it("reads back the session sealed by exchangeAndSeal", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      oid: "aad-oid-roundtrip",
    });

    const { cookie } = await exchangeAndSeal(testEnv, token, { keyResolver });
    // cookie is a full Set-Cookie header string; extract the
    // "name=value" pair for the Cookie request header.
    const cookiePair = cookie.split(";")[0];

    const request = new Request("https://example.com/api/webapp/me", {
      headers: { cookie: cookiePair ?? "" },
    });
    const session = await readSession(testEnv, request);

    expect(session).not.toBeNull();
    expect(session?.aadId).toBe("aad-oid-roundtrip");
  });

  it("returns null for a tampered cookie", async () => {
    const { privateKey, kid, keyResolver } = await makeKeyPair();
    const token = await signToken(privateKey, kid, {
      oid: "aad-oid-tamper",
    });

    const { cookie } = await exchangeAndSeal(testEnv, token, { keyResolver });
    const cookiePair = cookie.split(";")[0] ?? "";
    const [name, value] = cookiePair.split("=");
    const [payloadB64, sigB64] = (value ?? "").split(".");
    // Flip a character in the payload segment to invalidate the signature.
    const tamperedPayload =
      payloadB64 && payloadB64.length > 0
        ? payloadB64.slice(0, -1) + (payloadB64.at(-1) === "A" ? "B" : "A")
        : "tampered";
    const tamperedCookie = `${name}=${tamperedPayload}.${sigB64}`;

    const request = new Request("https://example.com/api/webapp/me", {
      headers: { cookie: tamperedCookie },
    });
    const session = await readSession(testEnv, request);

    expect(session).toBeNull();
  });
});
