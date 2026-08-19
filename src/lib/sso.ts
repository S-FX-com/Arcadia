// Microsoft SSO — OIDC authorization-code flow with PKCE, run entirely in the
// Worker. This replaces Cloudflare Access as the authentication front door;
// src/lib/rbac.ts still authorizes every mutation server-side.
//
// The dashboard is server-rendered, so the browser never handles a token: it
// is redirected to Entra, comes back with a code, and leaves holding only a
// signed session cookie. No token is exposed to page scripts.
//
// Three guards ride the round trip, all sealed into a short-lived cookie
// rather than KV so the callback needs no shared storage:
//   state     — CSRF: the callback must belong to a login this browser began
//   nonce     — replay: the id_token must belong to that same login
//   verifier  — PKCE S256: the code cannot be redeemed by an interceptor

import { verifyIdToken, type VerifyIdTokenOptions } from "./entra-verify";
import { resolveUser, type Identity } from "./rbac";
import {
  clearCookie,
  randomToken,
  readCookie,
  s256Challenge,
  seal,
  setCookie,
  unseal,
} from "./session";
import { GRAPH_USER_SCOPES, writeUserGraphTokens } from "../integrations/graph-user";

export const SESSION_COOKIE = "arcadia_session";
const LOGIN_COOKIE = "arcadia_login";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;

export class SsoError extends Error {
  constructor(
    public reason: string,
    detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SsoError";
  }
}

export interface SsoConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

/**
 * Fails closed and by name. An unconfigured deployment must refuse to serve
 * rather than fall open — the dashboard exposes approvals, doctrine, and
 * person-level certification data (§5.7).
 */
export function ssoConfig(env: Env): SsoConfig {
  // One Entra app registration serves both sign-in and Graph, so the
  // credentials carry the GRAPH_ names everywhere (§9.5). Only the cookie
  // signing key is SSO's own.
  const missing = [
    env.GRAPH_TENANT_ID ? null : "GRAPH_TENANT_ID",
    env.GRAPH_CLIENT_ID ? null : "GRAPH_CLIENT_ID",
    env.GRAPH_CLIENT_SECRET ? null : "GRAPH_CLIENT_SECRET",
    env.SSO_SESSION_SECRET ? null : "SSO_SESSION_SECRET",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new SsoError("sso_not_configured", `unset: ${missing.join(", ")}`);
  }
  return {
    tenantId: env.GRAPH_TENANT_ID as string,
    clientId: env.GRAPH_CLIENT_ID as string,
    clientSecret: env.GRAPH_CLIENT_SECRET as string,
    sessionSecret: env.SSO_SESSION_SECRET as string,
  };
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
  purpose?: "login" | "graph";
}

interface SessionPayload {
  email: string;
  aadId: string;
  name?: string;
  exp: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Only same-origin paths. "//evil.com" and "/\\evil.com" are browser-relative
 * protocol URLs, so a bare leading-slash check is not enough to stop an open
 * redirect off the login endpoint.
 */
function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export function redirectUri(env: Env, request: Request): string {
  if (env.SSO_REDIRECT_URI) return env.SSO_REDIRECT_URI;
  return new URL("/auth/callback", request.url).toString();
}

export async function beginLogin(env: Env, request: Request): Promise<Response> {
  return beginAuthorize(env, request, "login", "openid profile email");
}

/**
 * Incremental consent for the signed-in Specialist's own mailbox / chats /
 * calendar / Planner. Login stays openid-only so an un-consented Graph
 * permission cannot lock staff out of Arcadia.
 */
export async function beginGraphConnect(env: Env, request: Request): Promise<Response> {
  return beginAuthorize(env, request, "graph", GRAPH_USER_SCOPES);
}

async function beginAuthorize(
  env: Env,
  request: Request,
  purpose: "login" | "graph",
  scope: string
): Promise<Response> {
  const cfg = ssoConfig(env);
  const pending: PendingLogin = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    returnTo: purpose === "graph" ? "/" : safeReturnTo(new URL(request.url).searchParams.get("returnTo")),
    exp: nowSeconds() + LOGIN_TTL_SECONDS,
    purpose,
  };

  const authorize = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri(env, request));
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", pending.state);
  authorize.searchParams.set("nonce", pending.nonce);
  authorize.searchParams.set("code_challenge", await s256Challenge(pending.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  if (purpose === "graph") authorize.searchParams.set("prompt", "consent");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": setCookie(LOGIN_COOKIE, await seal(cfg.sessionSecret, pending), LOGIN_TTL_SECONDS),
    },
  });
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function completeLogin(
  env: Env,
  request: Request,
  opts: VerifyIdTokenOptions = {}
): Promise<Response> {
  const cfg = ssoConfig(env);
  const url = new URL(request.url);

  const idpError = url.searchParams.get("error");
  if (idpError) {
    throw new SsoError("idp_error", `${idpError}: ${url.searchParams.get("error_description") ?? ""}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new SsoError("callback_missing_params");

  const pending = await unseal<PendingLogin>(cfg.sessionSecret, readCookie(request, LOGIN_COOKIE));
  if (!pending) throw new SsoError("login_state_missing", "start again at /auth/login");
  if (pending.exp < nowSeconds()) throw new SsoError("login_state_expired");
  if (pending.state !== state) throw new SsoError("login_state_mismatch");

  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env, request),
      code_verifier: pending.verifier,
      scope: pending.purpose === "graph" ? GRAPH_USER_SCOPES : "openid profile email",
    }),
  });
  const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !tokens.id_token) {
    throw new SsoError(
      "token_exchange_failed",
      `${res.status} ${tokens.error ?? ""} ${tokens.error_description ?? ""}`.trim()
    );
  }

  const verified = await verifyIdToken(cfg, tokens.id_token, pending.nonce, opts);

  // §12.2: deactivated staff are refused at session mint, not merely hidden
  // from the surfaces they would otherwise reach.
  const user = await resolveUser(env, { email: verified.email });
  if (!user.active) throw new SsoError("account_deactivated", verified.email);

  if (pending.purpose === "graph") {
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new SsoError("graph_tokens_missing", "Entra returned no delegated refresh token");
    }
    await writeUserGraphTokens(env, verified.aadId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      exp: nowSeconds() + (tokens.expires_in ?? 3600),
      scope: tokens.scope ?? GRAPH_USER_SCOPES,
    });
  }

  const session: SessionPayload = {
    email: verified.email,
    aadId: verified.aadId,
    ...(verified.name ? { name: verified.name } : {}),
    exp: nowSeconds() + SESSION_TTL_SECONDS,
  };
  const headers = new Headers({ Location: pending.returnTo });
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, await seal(cfg.sessionSecret, session), SESSION_TTL_SECONDS));
  headers.append("Set-Cookie", clearCookie(LOGIN_COOKIE));
  return new Response(null, { status: 302, headers });
}

/**
 * Local-development bypass. Deliberately also requires a loopback host, so
 * DEV_MODE reaching production vars by accident still cannot open
 * arcadia.s-fx.com — the flag alone is not enough.
 */
function devIdentity(env: Env, request: Request): Identity | null {
  if (env.DEV_MODE !== "true") return null;
  const host = new URL(request.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return null;
  return { email: "dev@localhost" };
}

/** The signed cookie, or null. Never throws — an absent session is not an error. */
export async function readIdentity(env: Env, request: Request): Promise<Identity | null> {
  const dev = devIdentity(env, request);
  if (dev) return dev;

  let cfg: SsoConfig;
  try {
    cfg = ssoConfig(env);
  } catch {
    return null;
  }
  const session = await unseal<SessionPayload>(cfg.sessionSecret, readCookie(request, SESSION_COOKIE));
  if (!session || typeof session.email !== "string") return null;
  if (typeof session.exp !== "number" || session.exp < nowSeconds()) return null;
  return {
    email: session.email,
    ...(session.aadId ? { aadId: session.aadId } : {}),
    ...(session.name ? { name: session.name } : {}),
  };
}

/** Clears the session locally and at the IdP, so the next login re-prompts. */
export function logout(env: Env, request: Request): Response {
  const headers = new Headers({ "Set-Cookie": clearCookie(SESSION_COOKIE) });
  try {
    const cfg = ssoConfig(env);
    const done = new URL("/", request.url).toString();
    headers.set(
      "Location",
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(done)}`
    );
  } catch {
    headers.set("Location", "/");
  }
  return new Response(null, { status: 302, headers });
}

/** Send an unauthenticated browser through the IdP, preserving where it was going. */
export function redirectToLogin(request: Request): Response {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: { Location: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` },
  });
}
