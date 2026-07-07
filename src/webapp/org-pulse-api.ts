// GET /api/webapp/org-pulse — the admin's tenant-wide "what is happening
// right now" synthesis (EXECUTION-PLAN §Phase 3 item 1).
//
//   GET /api/webapp/org-pulse
//     200: OrgPulse  { generatedAt, summary, sections[], counts }
//     403: { error: 'forbidden' }         — non-admin caller
//     405: { error: 'method_not_allowed' }
//
// Admin-only at the data layer: generateOrgPulse aggregates the whole tenant
// with no per-viewer ACL trimming, so exposing it to a non-admin would leak
// cross-user signal. session.isAdmin is set fresh per request by
// enrichSession() in routes.ts (D1 is_admin flag or ADMIN_USER_AAD_ID env).

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import {
  generateOrgPulse,
  type OrgPulseDeps,
} from "../intelligence/org-pulse";
import type { Session } from "./auth";

export async function handleOrgPulse(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
  deps?: Partial<OrgPulseDeps>,
): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  if (!session.isAdmin) {
    log.warn("webapp_org_pulse_forbidden", { aadId: session.aadId });
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const pulse = await generateOrgPulse(
    env,
    { tenantId: session.tenantId },
    deps,
  );
  return Response.json(pulse);
}
