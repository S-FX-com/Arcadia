// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot Framework JWT Authentication
//
// Verifies incoming webhook requests from Microsoft Teams using the Bot
// Framework's OpenID Connect metadata. Teams signs each activity with a JWT
// bearer token in the Authorization header.
// ─────────────────────────────────────────────────────────────────────────────

import { importJWK, jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "../types.js";
import { BOT_FRAMEWORK } from "../constants.js";

// Cache JWKS URL after first fetch — valid for the life of the Worker isolate
let jwksUri: string | null = null;

async function getBotFrameworkJWKS(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!jwksUri) {
    const res = await fetch(BOT_FRAMEWORK.OPENID_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch Bot Framework OpenID config: ${res.status}`);
    }
    const config = await res.json() as { jwks_uri: string };
    jwksUri = config.jwks_uri;
  }
  return createRemoteJWKSet(new URL(jwksUri));
}

/**
 * Verify the Bot Framework JWT in the Authorization header.
 * Returns true if valid, throws on failure.
 *
 * Teams sends: Authorization: Bearer <JWT>
 * The JWT audience must match the bot's app ID (TEAMS_APP_ID).
 */
export async function verifyBotToken(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or malformed Authorization header");
  }

  const token = authHeader.slice(7);
  const JWKS = await getBotFrameworkJWKS();

  await jwtVerify(token, JWKS, {
    audience: env.TEAMS_APP_ID,
    issuer: BOT_FRAMEWORK.ISSUER,
    algorithms: [BOT_FRAMEWORK.ALGORITHM],
  });

  return true;
}

/**
 * Emit a 401 response — used when auth fails.
 */
export function unauthorizedResponse(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
