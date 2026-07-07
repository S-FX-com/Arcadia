// Webapp auth — session cookie + On-Behalf-Of token exchange.
//
// The web frontend (web/, SvelteKit) authenticates the user via either
// NAA (Nested App Auth inside Teams) or standard MSAL.js (browser).
// In either case the frontend obtains an access token issued for
// WEBAPP_CLIENT_ID. It POSTs that token to /api/webapp/auth/exchange.
//
// This module:
//
//   exchangeAndSeal(env, accessToken)  Validate the inbound token,
//                                       extract aad object id / tenant
//                                       / upn, seal into a session
//                                       cookie keyed by
//                                       WEBAPP_SESSION_SECRET.
//
//   readSession(env, request)           Return the unsealed Session for
//                                       a cookie-bearing request, or
//                                       null.
//
//   getOboToken(env, userToken, scope)  Exchange the user token for a
//                                       Graph token via OBO. KV-cached
//                                       per (aad_id, scope).
//
// Cookie format: Base64URL(payload).Base64URL(hmacSha256(payload)).
// payload = JSON.stringify({ aadId, tenantId, upn, name, exp }).

import type { Env } from "../env";
import { decodeJwt, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { verifyEntraToken, type VerifyEntraOptions } from "../lib/entra-verify";

export interface Session {
  aadId: string;
  tenantId: string;
  upn?: string;
  name?: string;
  exp: number;
  /**
   * Active Client this session is scoped to, if any. Populated on
   * read from users.active_client_id by webapp/routes.ts so handlers
   * downstream see a fresh value without re-issuing the cookie when
   * the user switches Client.
   */
  activeClientId?: string;
  /** Cached users.is_admin flag — read by admin endpoints. */
  isAdmin?: boolean;
}

const COOKIE_NAME = "arcadia_session";
const SESSION_TTL_SECONDS = 8 * 3600;
const ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function exchangeAndSeal(
  env: Env,
  accessToken: string,
  opts?: { keyResolver?: JWTVerifyGetKey },
): Promise<{ session: Session; cookie: string }> {
  // Full cryptographic verification against the tenant JWKS — signature,
  // issuer, audience, expiry, and tenant binding. See lib/entra-verify.ts.
  const verifyOpts: VerifyEntraOptions = opts?.keyResolver
    ? { keyResolver: opts.keyResolver }
    : {};
  const verified = await verifyEntraToken(env, accessToken, verifyOpts);

  const session: Session = {
    aadId: verified.aadId,
    tenantId: verified.tenantId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    ...(verified.upn ? { upn: verified.upn } : {}),
    ...(verified.name ? { name: verified.name } : {}),
  };

  const cookie = await sealCookie(env, session);
  return { session, cookie };
}

export async function readSession(
  env: Env,
  request: Request,
): Promise<Session | null> {
  const cookie = getCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!cookie) return null;
  try {
    return await unsealCookie(env, cookie);
  } catch {
    return null;
  }
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function sealCookie(env: Env, session: Session): Promise<string> {
  const payload = JSON.stringify(session);
  const sig = await hmac(env, payload);
  const cookie =
    `${COOKIE_NAME}=${b64u(payload)}.${b64u(sig)};` +
    ` Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
  return cookie;
}

async function unsealCookie(env: Env, raw: string): Promise<Session | null> {
  const [payloadB64, sigB64] = raw.split(".");
  if (!payloadB64 || !sigB64) return null;
  const payload = b64uDecode(payloadB64);
  const sig = await hmac(env, payload);
  if (b64u(sig) !== sigB64) return null;
  const session = JSON.parse(payload) as Session;
  if (typeof session.exp !== "number") return null;
  if (session.exp < Math.floor(Date.now() / 1000)) return null;
  return session;
}

function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return trimmed.slice(name.length + 1);
  }
  return null;
}

async function hmac(env: Env, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(env.WEBAPP_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, ENCODER.encode(message));
}

function b64u(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string"
      ? ENCODER.encode(input)
      : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64uDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padding));
}

// ---------------------------------------------------------------------------
// On-Behalf-Of token exchange
// ---------------------------------------------------------------------------

interface OboCacheEntry {
  token: string;
  exp: number;
}

export async function getOboToken(
  env: Env,
  userToken: string,
  scope: string,
): Promise<string> {
  let payload: JWTPayload;
  try {
    payload = decodeJwt(userToken);
  } catch (e) {
    throw new Error(`obo_bad_token: ${String(e)}`);
  }
  const aadId =
    (payload.oid as string | undefined) ?? (payload.sub as string | undefined);
  if (!aadId) throw new Error("obo_token_missing_oid");

  const key = `obo:${aadId}:${scope}`;
  const cached = await env.ARCADIA_CACHE.get(key, { type: "json" });
  if (cached && typeof cached === "object") {
    const entry = cached as OboCacheEntry;
    if (entry.exp - 60 > Math.floor(Date.now() / 1000)) {
      return entry.token;
    }
  }

  const tenantId = (payload.tid as string | undefined) ?? "common";
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: env.WEBAPP_CLIENT_ID,
    client_secret: env.WEBAPP_CLIENT_SECRET,
    assertion: userToken,
    scope,
    requested_token_use: "on_behalf_of",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`obo_${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const exp = Math.floor(Date.now() / 1000) + json.expires_in;
  await env.ARCADIA_CACHE.put(
    key,
    JSON.stringify({ token: json.access_token, exp }),
    { expirationTtl: Math.max(60, json.expires_in - 60) },
  );
  return json.access_token;
}
