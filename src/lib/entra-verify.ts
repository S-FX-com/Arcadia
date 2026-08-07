// Entra ID (Microsoft Entra / Azure AD) id_token verification.
//
// This is the only place a user identity enters Arcadia. It performs full
// cryptographic validation against the tenant JWKS: signature, issuer,
// audience, expiry, nonce, and tenant binding. Structural decoding alone
// (jose decodeJwt) never establishes identity.
//
// Only v2.0 tokens are accepted. v1.0 tokens carry an sts.windows.net issuer
// and fail the issuer check by construction.
//
// Tests inject a local key resolver via keyResolver so the suite never
// depends on Microsoft's JWKS endpoint.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface VerifiedIdToken {
  /** Entra object id — stable across email changes, unlike the address. */
  aadId: string;
  tenantId: string;
  email: string;
  name?: string;
}

export interface VerifyIdTokenOptions {
  /** Test seam: local key resolver instead of the remote tenant JWKS. */
  keyResolver?: JWTVerifyGetKey;
}

// One remote JWKS per tenant per isolate. jose caches fetched keys and
// re-fetches on unknown-kid, so cold starts cost one request.
const jwksCache = new Map<string, JWTVerifyGetKey>();

function tenantJwks(tenantId: string): JWTVerifyGetKey {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
  );
  jwksCache.set(tenantId, jwks);
  return jwks;
}

export class EntraVerifyError extends Error {
  constructor(
    public reason: string,
    detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "EntraVerifyError";
  }
}

/**
 * The address staff are known by everywhere else in Arcadia — the users
 * table, kill-switch allowlist, escalation email, person memory — is the
 * mail address, so an id_token that carries no usable address is refused
 * rather than admitted under a synthetic identity.
 */
function extractEmail(payload: JWTPayload): string | undefined {
  for (const claim of ["preferred_username", "email", "upn"] as const) {
    const value = payload[claim];
    if (typeof value === "string" && value.includes("@")) return value.toLowerCase();
  }
  return undefined;
}

export async function verifyIdToken(
  cfg: { tenantId: string; clientId: string },
  token: string,
  expectedNonce: string,
  opts: VerifyIdTokenOptions = {}
): Promise<VerifiedIdToken> {
  const issuer = `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`;
  const getKey = opts.keyResolver ?? tenantJwks(cfg.tenantId);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getKey, {
      issuer,
      audience: cfg.clientId,
      // exp/nbf enforced by jose; small skew for clock drift.
      clockTolerance: 60,
    });
    payload = result.payload;
  } catch (err) {
    throw new EntraVerifyError("token_verification_failed", String(err));
  }

  // Replay protection: this token must belong to the login we started.
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
    throw new EntraVerifyError("token_nonce_mismatch");
  }

  // The issuer check already pins the tenant, but a guest or cross-tenant
  // principal would still satisfy it — tid is what keeps this to S-FX staff.
  if (payload.tid !== cfg.tenantId) {
    throw new EntraVerifyError("token_wrong_tenant");
  }

  const aadId = typeof payload.oid === "string" ? payload.oid : undefined;
  if (!aadId) {
    throw new EntraVerifyError("token_missing_oid");
  }

  const email = extractEmail(payload);
  if (!email) {
    throw new EntraVerifyError("token_missing_email");
  }

  return {
    aadId,
    tenantId: cfg.tenantId,
    email,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
  };
}
