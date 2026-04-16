// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Unified token manager
//
// Single entry point for OAuth2 client-credentials tokens. Both the MS Graph
// outbound client and the Bot Framework reply channel share the same flow
// (Azure AD /oauth2/v2.0/token) but use different client credentials and
// scopes. Tokens are cached in KV until `TOKEN_SAFETY_MARGIN_SECONDS` before
// expiry so concurrent requests reuse the same token and we avoid hammering
// Azure AD.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { BOT_FRAMEWORK, GRAPH, KV_KEYS } from "../constants.js";

export interface TokenProvider {
  getToken(): Promise<string>;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function fetchClientCredentialsToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string,
  label: string
): Promise<TokenResponse> {
  const res = await fetch(GRAPH.TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${label} token fetch failed (${res.status}): ${err}`);
  }

  return (await res.json()) as TokenResponse;
}

async function getCachedOrFetch(
  env: Env,
  cacheKey: string,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string,
  label: string
): Promise<string> {
  const cached = await env.ARCADIA_CACHE.get(cacheKey);
  if (cached) return cached;

  const data = await fetchClientCredentialsToken(
    tenantId,
    clientId,
    clientSecret,
    scope,
    label
  );

  const ttl = Math.max(0, data.expires_in - GRAPH.TOKEN_SAFETY_MARGIN_SECONDS);
  await env.ARCADIA_CACHE.put(cacheKey, data.access_token, {
    expirationTtl: ttl,
  });

  return data.access_token;
}

// ─── Graph token provider ────────────────────────────────────────────────────

export class GraphTokenProvider implements TokenProvider {
  constructor(private readonly env: Env) {}

  getToken(): Promise<string> {
    return getCachedOrFetch(
      this.env,
      KV_KEYS.TOKEN_GRAPH,
      this.env.GRAPH_TENANT_ID,
      this.env.GRAPH_CLIENT_ID,
      this.env.GRAPH_CLIENT_SECRET,
      GRAPH.SCOPE,
      "Graph"
    );
  }
}

// ─── Bot Framework token provider ────────────────────────────────────────────
//
// Used to authenticate outbound replies to the Teams channel
// (POST /v3/conversations/.../activities). Cached in KV to avoid re-requesting
// a fresh token on every incoming activity.

export class BotFrameworkTokenProvider implements TokenProvider {
  constructor(private readonly env: Env) {}

  getToken(): Promise<string> {
    return getCachedOrFetch(
      this.env,
      KV_KEYS.TOKEN_BOT,
      this.env.GRAPH_TENANT_ID,
      this.env.TEAMS_APP_ID,
      this.env.TEAMS_APP_PASSWORD,
      BOT_FRAMEWORK.SCOPE,
      "Bot Framework"
    );
  }
}
