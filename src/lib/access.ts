// Cloudflare Access verification for staff-facing routes. The Access policy
// itself is configured in the dashboard (§9.5); this verifies the JWT that
// Access injects so a misconfigured route can't silently expose the approval
// surface, and so we can attribute every decision to a named human.

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessEnv {
  /** e.g. "sfx" for sfx.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application AUD tag from the Access application. */
  ACCESS_AUD?: string;
  /** "true" only in local dev — bypasses verification with a fake identity. */
  DEV_MODE?: string;
}

export interface Identity {
  email: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export async function verifyAccess(request: Request, env: AccessEnv): Promise<Identity> {
  if (env.DEV_MODE === "true") {
    return { email: "dev@localhost" };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AccessDeniedError("Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD unset) — refusing to serve");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new AccessDeniedError("missing Cf-Access-Jwt-Assertion header");
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: env.ACCESS_AUD,
  });
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) {
    throw new AccessDeniedError("Access JWT carries no email claim");
  }
  return { email };
}

/** Kill switch is reachable by a named set of humans only (§4). */
export function canOperateKillSwitch(email: string, allowlist?: string): boolean {
  if (!allowlist) return false;
  return allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
