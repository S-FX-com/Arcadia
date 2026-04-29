// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Teams Updates Context Provider
//
// Fetches pending update requests sent to the authenticated user via the
// Microsoft Teams Updates app. The Graph resource is in beta; if the tenant
// does not have the Updates app provisioned the endpoint returns 404/403 and
// we degrade gracefully to an empty array.
// ─────────────────────────────────────────────────────────────────────────────

import type { TeamsUpdate } from "../types.js";

const GRAPH_BETA = "https://graph.microsoft.com/beta";

interface GraphSendRequest {
  id: string;
  title: string;
  description: string | null;
  createdBy: { user: { displayName: string } } | null;
  createdDateTime: string;
  lastModifiedDateTime: string | null;
  status: string;
  requestType: string;
}

interface GraphListResponse<T> {
  value: T[];
}

async function betaGraphGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${GRAPH_BETA}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[Arcadia Webapp] Teams Updates GET ${path} failed (${res.status}):`, err);
    throw new Error(`Teams Updates GET ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/**
 * Returns pending Teams Updates app requests awaiting the current user's
 * response. Degrades to an empty array when the Updates app is not
 * provisioned for the tenant or the scope is not granted.
 */
export async function getPendingUpdates(accessToken: string): Promise<TeamsUpdate[]> {
  try {
    const res = await betaGraphGet<GraphListResponse<GraphSendRequest>>(
      "/me/teamwork/sendRequests?$top=25&$orderby=createdDateTime desc",
      accessToken,
    );
    return res.value.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      requestedBy: r.createdBy?.user?.displayName ?? "Unknown",
      createdDateTime: r.createdDateTime,
      lastModifiedDateTime: r.lastModifiedDateTime ?? null,
      status: r.status,
      requestType: r.requestType,
    }));
  } catch {
    // Endpoint not available for this tenant — return empty
    return [];
  }
}
