// Delegated (on-behalf-of) Graph lane — the "access plane" half of D1's
// two-plane identity model (EXECUTION-PLAN.md §2 D1, item P2.5).
//
// Two planes exist in this codebase:
//
//   Ingestion plane (app-only, src/graph/auth.ts::appToken)
//     Arcadia's own application identity, used continuously in the
//     background to walk the tenant (producers, registry sync, webhook
//     fan-out). No human is "looking" when these calls happen, so a
//     delegated token can't power them — there's no signed-in user to
//     delegate from.
//
//   Access plane (delegated OBO, this module)
//     Every *live*, staff-facing Graph operation that answers a
//     question for a specific signed-in human — Microsoft Search
//     queries, presence, on-demand file fetch — exchanges that user's
//     verified Entra token for a Graph token scoped to them via
//     On-Behalf-Of (src/webapp/auth.ts::getOboToken). Microsoft Graph
//     then enforces its own native security trimming against that
//     user's real memberships and permissions — a second, independent
//     authorization layer behind our own ACL (src/acl/resource-acl.ts).
//     Even if our ACL derivation has a gap, Graph will not hand back
//     content the user can't see.
//
// resolveDelegated() is the entry point handlers use to turn an inbound
// `x-graph-token` header into a verified identity + the raw token needed
// for the OBO exchange. It never trusts the header's claims without
// running them through verifyEntraToken (signature + issuer + audience +
// expiry + tenant), exactly like the session cookie flow in
// src/webapp/auth.ts and the MCP bearer flow in src/mcp/server.ts.

import type { JWTVerifyGetKey } from "jose";
import type { Env } from "../env";
import {
  EntraVerifyError,
  verifyEntraToken,
  type VerifyEntraOptions,
} from "../lib/entra-verify";
import { getOboToken } from "../webapp/auth";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

export class DelegatedAuthError extends Error {
  constructor(
    public readonly reason: string,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "DelegatedAuthError";
  }
}

export interface DelegatedIdentity {
  aadId: string;
  tenantId: string;
  /** The raw, verified user access token — passed on to the OBO exchange. */
  userToken: string;
}

export interface ResolveDelegatedOptions {
  /** Test seam: local key resolver instead of the remote tenant JWKS. */
  keyResolver?: JWTVerifyGetKey;
}

/**
 * Resolve the delegated caller identity from the `x-graph-token` request
 * header. The header carries a raw Entra v2.0 access token issued for
 * WEBAPP_CLIENT_ID (the same token shape accepted by
 * src/webapp/auth.ts::exchangeAndSeal) — it is fully verified here via
 * verifyEntraToken before anything downstream trusts its claims.
 *
 * Throws DelegatedAuthError on any failure:
 *   'missing_token'          — no x-graph-token header present
 *   <EntraVerifyError.reason> — verification failed (bad signature, wrong
 *                               issuer/audience/tenant, expired, etc.)
 */
export async function resolveDelegated(
  env: Env,
  request: Request,
  opts: ResolveDelegatedOptions = {},
): Promise<DelegatedIdentity> {
  const userToken = request.headers.get("x-graph-token");
  if (!userToken) {
    throw new DelegatedAuthError("missing_token");
  }

  const verifyOpts: VerifyEntraOptions = opts.keyResolver
    ? { keyResolver: opts.keyResolver }
    : {};

  try {
    const verified = await verifyEntraToken(env, userToken, verifyOpts);
    return {
      aadId: verified.aadId,
      tenantId: verified.tenantId,
      userToken,
    };
  } catch (e) {
    if (e instanceof EntraVerifyError) {
      throw new DelegatedAuthError(e.reason, e.message);
    }
    throw new DelegatedAuthError("verification_failed", String(e));
  }
}

/**
 * Exchange a verified user token for a Graph access token via On-Behalf-Of,
 * scoped to Graph's own default scope set. Thin wrapper over
 * src/webapp/auth.ts::getOboToken so callers in src/graph/* and
 * src/webapp/* share one call site (and one KV cache key scheme) for the
 * delegated Graph lane.
 */
export async function delegatedGraphToken(
  env: Env,
  userToken: string,
): Promise<string> {
  return getOboToken(env, userToken, GRAPH_DEFAULT_SCOPE);
}
