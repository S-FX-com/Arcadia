// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Authentication (Phase 7)
//
// Handles M365 SSO via Authorization Code Flow with PKCE.
// Server-side token exchange (confidential client) for longer-lived refresh tokens.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import type { WebappSession, WebappSessionRow, GraphMeProfile, UserGraphToken } from "./types.js";
import { encryptToken, decryptToken, signSessionId, verifySessionSignature } from "./crypto.js";

const SESSION_COOKIE_NAME = "arcadia_session";
const SESSION_MAX_AGE = 86400; // 24 hours

// ─── Token Exchange ──────────────────────────────────────────────────────────

interface TokenExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface MSTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/**
 * POST /api/webapp/auth/token
 * Exchanges an authorization code for tokens and creates a session.
 */
export async function handleTokenExchange(
  request: Request,
  env: Env
): Promise<Response> {
  let body: TokenExchangeRequest;
  try {
    body = await request.json() as TokenExchangeRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.code || !body.redirectUri) {
    return jsonResponse({ error: "Missing code or redirectUri" }, 400);
  }

  let accessToken: string;
  let refreshToken: string | null = null;
  let expiresIn: number;
  let scope: string;

  // Check if the 'code' is actually an access token (already exchanged by client)
  // Access tokens from MSAL are usually JWTs (start with eyJ) or at least very long.
  const isDirectToken = body.code.startsWith("eyJ") || body.code.length > 128;

  if (isDirectToken) {
    accessToken = body.code;
    expiresIn = 3600; // Assume 1h if not provided
    scope = "openid profile email User.Read Chat.Read ChannelMessage.Read.All Sites.Read.All Tasks.Read Group.Read.All Team.ReadBasic.All";
  } else {
    // Exchange code for tokens at Microsoft token endpoint
    const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.WEBAPP_CLIENT_ID,
      client_secret: env.WEBAPP_CLIENT_SECRET,
      code: body.code,
      redirect_uri: body.redirectUri,
      scope: "openid profile email User.Read Chat.Read ChannelMessage.Read.All Sites.Read.All Tasks.Read Group.Read.All Team.ReadBasic.All offline_access",
    });

    if (body.codeVerifier) {
      params.append("code_verifier", body.codeVerifier);
    }

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[Arcadia Webapp] Token exchange failed:", err);
      // Fallback: if exchange fails but code looks like a token, try using it directly
      if (body.code.length > 50) {
        accessToken = body.code;
        expiresIn = 3600;
        scope = "openid profile email";
      } else {
        return jsonResponse({ error: "Token exchange failed", details: err }, 401);
      }
    } else {
      const tokenData = await tokenRes.json() as MSTokenResponse;
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token ?? null;
      expiresIn = tokenData.expires_in;
      scope = tokenData.scope;
    }
  }

  // Fetch user profile from /me
  const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    console.error("[Arcadia Webapp] /me fetch failed:", await meRes.text());
    return jsonResponse({ error: "Failed to fetch user profile" }, 500);
  }

  const me = await meRes.json() as GraphMeProfile;

  // Create session
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const encAccessToken = await encryptToken(accessToken, env.WEBAPP_SESSION_SECRET);
  const encRefreshToken = refreshToken
    ? await encryptToken(refreshToken, env.WEBAPP_SESSION_SECRET)
    : null;

  await env.ARCADIA_DB.prepare(
    `INSERT INTO webapp_sessions (id, user_id, display_name, email, access_token, refresh_token, token_expiry, scopes, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      me.id,
      me.displayName,
      me.mail,
      encAccessToken,
      encRefreshToken,
      now + expiresIn,
      scope,
      now,
      now
    )
    .run();

  // Sign the session cookie
  const signature = await signSessionId(sessionId, env.WEBAPP_SESSION_SECRET);
  const cookieValue = `${sessionId}.${signature}`;

  // Determine cookie flags (Secure only if not localhost)
  const isLocal = new URL(request.url).hostname === "localhost";
  const cookieFlags = [
    `HttpOnly`,
    isLocal ? "" : "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
  ]
    .filter(Boolean)
    .join("; ");

  return jsonResponse(
    {
      userId: me.id,
      displayName: me.displayName,
      email: me.mail,
    },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE_NAME}=${cookieValue}; ${cookieFlags}`,
    }
  );
}

// ─── Logout ──────────────────────────────────────────────────────────────────

/**
 * POST /api/webapp/auth/logout
 * Deletes the session and clears the cookie.
 */
export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  const session = await validateSession(request, env);
  if (session) {
    await env.ARCADIA_DB.prepare("DELETE FROM webapp_sessions WHERE id = ?")
      .bind(session.id)
      .run();
  }

  const isLocal = new URL(request.url).hostname === "localhost";
  const cookieFlags = [
    `HttpOnly`,
    isLocal ? "" : "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");

  return jsonResponse(
    { ok: true },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE_NAME}=; ${cookieFlags}`,
    }
  );
}

// ─── Get Current User ────────────────────────────────────────────────────────

/**
 * GET /api/webapp/auth/me
 * Returns the current authenticated user's info.
 */
export async function handleGetMe(
  request: Request,
  env: Env
): Promise<Response> {
  const session = await validateSession(request, env);
  if (!session) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }

  return jsonResponse({
    userId: session.userId,
    displayName: session.displayName,
    email: session.email,
  });
}

// ─── Session Validation ──────────────────────────────────────────────────────

/**
 * Validates the session cookie and returns the session if valid.
 * Automatically refreshes expired tokens when a refresh token is available.
 */
export async function validateSession(
  request: Request,
  env: Env
): Promise<WebappSession | null> {
  const cookie = parseCookie(request.headers.get("Cookie") ?? "", SESSION_COOKIE_NAME);
  if (!cookie) return null;

  // Cookie format: {sessionId}.{hmacSignature}
  const dotIndex = cookie.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const sessionId = cookie.slice(0, dotIndex);
  const signature = cookie.slice(dotIndex + 1);

  // Verify HMAC signature
  const valid = await verifySessionSignature(sessionId, signature, env.WEBAPP_SESSION_SECRET);
  if (!valid) return null;

  // Load session from D1
  const row = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_sessions WHERE id = ?"
  )
    .bind(sessionId)
    .first<WebappSessionRow>();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);

  // Check if access token is expired (with 60s buffer)
  if (row.token_expiry < now + 60) {
    // Attempt refresh
    if (row.refresh_token) {
      const refreshed = await refreshUserToken(row, env);
      if (refreshed) {
        // Update session with new tokens
        const encAccess = await encryptToken(refreshed.accessToken, env.WEBAPP_SESSION_SECRET);
        const encRefresh = refreshed.refreshToken
          ? await encryptToken(refreshed.refreshToken, env.WEBAPP_SESSION_SECRET)
          : row.refresh_token;

        await env.ARCADIA_DB.prepare(
          `UPDATE webapp_sessions SET access_token = ?, refresh_token = ?, token_expiry = ?, scopes = ?, last_active = ? WHERE id = ?`
        )
          .bind(encAccess, encRefresh, refreshed.expiresAt, refreshed.scopes, now, sessionId)
          .run();

        return {
          id: sessionId,
          userId: row.user_id,
          displayName: row.display_name,
          email: row.email,
          accessToken: encAccess,
          refreshToken: encRefresh,
          tokenExpiry: refreshed.expiresAt,
          scopes: refreshed.scopes,
          createdAt: row.created_at,
          lastActive: now,
        };
      }
      // Refresh failed — session is dead
      return null;
    }
    // No refresh token and access token expired
    return null;
  }

  // Update last_active timestamp
  await env.ARCADIA_DB.prepare(
    "UPDATE webapp_sessions SET last_active = ? WHERE id = ?"
  )
    .bind(now, sessionId)
    .run();

  return {
    id: sessionId,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiry: row.token_expiry,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastActive: now,
  };
}

/**
 * Decrypts and returns the user's Graph access token from a validated session.
 */
export async function getSessionAccessToken(
  session: WebappSession,
  env: Env
): Promise<string> {
  return decryptToken(session.accessToken, env.WEBAPP_SESSION_SECRET);
}

// ─── Token Refresh ───────────────────────────────────────────────────────────

async function refreshUserToken(
  session: WebappSessionRow,
  env: Env
): Promise<UserGraphToken | null> {
  if (!session.refresh_token) return null;

  let refreshToken: string;
  try {
    refreshToken = await decryptToken(session.refresh_token, env.WEBAPP_SESSION_SECRET);
  } catch {
    console.error("[Arcadia Webapp] Failed to decrypt refresh token");
    return null;
  }

  const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.WEBAPP_CLIENT_ID,
    client_secret: env.WEBAPP_CLIENT_SECRET,
    refresh_token: refreshToken,
    scope: session.scopes || "openid profile email User.Read Chat.Read ChannelMessage.Read.All Sites.Read.All Tasks.Read Group.Read.All Team.ReadBasic.All offline_access",
  });

  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      console.error("[Arcadia Webapp] Token refresh failed:", await res.text());
      return null;
    }

    const data = await res.json() as MSTokenResponse;
    const now = Math.floor(Date.now() / 1000);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: now + data.expires_in,
      scopes: data.scope,
    };
  } catch (err) {
    console.error("[Arcadia Webapp] Token refresh error:", err);
    return null;
  }
}

// ─── Session Cleanup ─────────────────────────────────────────────────────────

/**
 * Prune expired sessions from D1. Called from daily cron.
 */
export async function pruneExpiredSessions(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - SESSION_MAX_AGE; // 24h inactive

  const result = await env.ARCADIA_DB.prepare(
    "DELETE FROM webapp_sessions WHERE last_active < ? OR (token_expiry < ? AND refresh_token IS NULL)"
  )
    .bind(staleThreshold, now)
    .run();

  return result.meta?.changes ?? 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match && match[1] !== undefined ? decodeURIComponent(match[1]) : null;
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
