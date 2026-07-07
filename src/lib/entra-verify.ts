// Entra ID access-token verification.
//
// Every inbound user identity — webapp session exchange, MCP bearer
// auth — must pass through verifyEntraToken. It performs full
// cryptographic validation against the tenant JWKS: signature, issuer,
// audience, expiry, and tenant binding. Structural decoding alone
// (jose decodeJwt) is never sufficient to establish identity.
//
// Only v2.0 Entra tokens are accepted. v1.0 tokens carry an
// sts.windows.net issuer and fail the issuer check by construction.
//
// Tests inject a local key resolver via VerifyEntraOptions.keyResolver
// so the suite never depends on Microsoft's JWKS endpoint.

import type { Env } from "../env";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface VerifiedEntraToken {
  aadId: string;
  tenantId: string;
  upn?: string;
  name?: string;
  payload: JWTPayload;
}

export interface VerifyEntraOptions {
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
    new URL(
      `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    ),
  );
  jwksCache.set(tenantId, jwks);
  return jwks;
}

export class EntraVerifyError extends Error {
  constructor(public reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "EntraVerifyError";
  }
}

/**
 * Fully verify an Entra v2.0 access token issued for the webapp
 * (delegated) app registration. Throws EntraVerifyError on any failure.
 */
export async function verifyEntraToken(
  env: Env,
  token: string,
  opts: VerifyEntraOptions = {},
): Promise<VerifiedEntraToken> {
  const tenantId = env.GRAPH_TENANT_ID;
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const audiences = [env.WEBAPP_CLIENT_ID, `api://${env.WEBAPP_CLIENT_ID}`];
  const getKey = opts.keyResolver ?? tenantJwks(tenantId);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getKey, {
      issuer,
      audience: audiences,
      // exp/nbf enforced by jose; small skew for clock drift.
      clockTolerance: 60,
    });
    payload = result.payload;
  } catch (e) {
    throw new EntraVerifyError("token_verification_failed", String(e));
  }

  const tid = payload.tid as string | undefined;
  if (tid !== tenantId) {
    throw new EntraVerifyError("token_wrong_tenant");
  }
  const aadId = payload.oid as string | undefined;
  if (!aadId) {
    // Access tokens for our own API always carry oid; a sub-only token
    // is not acceptable as a directory identity.
    throw new EntraVerifyError("token_missing_oid");
  }

  return {
    aadId,
    tenantId: tid,
    ...(payload.upn ? { upn: String(payload.upn) } : {}),
    ...(payload.name ? { name: String(payload.name) } : {}),
    payload,
  };
}
