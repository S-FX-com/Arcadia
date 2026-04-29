// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp SharePoint Context Provider (Phase 7)
//
// Fetches SharePoint sites, files, and search results using user-delegated tokens.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet, userGraphPost } from "../graph-delegated.js";
import type { SharePointSite, SharePointDriveItem } from "../types.js";

interface GraphListResponse<T> {
  value: T[];
}

/**
 * Lists the SharePoint sites the user follows.
 */
export async function getFollowedSites(accessToken: string): Promise<SharePointSite[]> {
  const res = await userGraphGet<GraphListResponse<{
    id: string;
    displayName: string;
    webUrl: string;
    description?: string;
  }>>(
    "/me/followedSites?$select=id,displayName,webUrl,description&$top=25",
    accessToken
  );
  return res.value.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    webUrl: s.webUrl,
    description: s.description ?? null,
  }));
}

/**
 * Returns sites the user can access — merges followed sites with recently
 * visited sites from the Graph insights API. Many users follow nothing, so
 * relying solely on /me/followedSites returns an empty list.
 */
export async function getAccessibleSites(accessToken: string): Promise<SharePointSite[]> {
  const [followedResult, recentResult] = await Promise.allSettled([
    userGraphGet<GraphListResponse<{
      id: string;
      displayName: string;
      webUrl: string;
      description?: string;
    }>>("/me/followedSites?$select=id,displayName,webUrl,description&$top=20", accessToken),
    userGraphGet<GraphListResponse<{
      resourceReference: { id: string; webUrl: string; type: string };
      resourceVisualization: { title: string; containerDisplayName: string };
    }>>("/me/insights/used?$filter=ResourceVisualization/Type eq 'Web'&$top=20", accessToken),
  ]);

  const seen = new Set<string>();
  const sites: SharePointSite[] = [];

  if (followedResult.status === "fulfilled") {
    for (const s of followedResult.value.value) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        sites.push({ id: s.id, displayName: s.displayName, webUrl: s.webUrl, description: s.description ?? null });
      }
    }
  }

  if (recentResult.status === "fulfilled") {
    for (const item of recentResult.value.value) {
      const id = item.resourceReference.id;
      if (!id || seen.has(id)) continue;
      const title = item.resourceVisualization.containerDisplayName || item.resourceVisualization.title;
      if (!title) continue;
      seen.add(id);
      sites.push({ id, displayName: title, webUrl: item.resourceReference.webUrl, description: null });
    }
  }

  return sites.slice(0, 25);
}

/**
 * Lists files/folders in a site's default drive root.
 */
export async function getSiteFiles(
  siteId: string,
  accessToken: string,
  path = ""
): Promise<SharePointDriveItem[]> {
  const endpoint = path
    ? `/sites/${siteId}/drive/root:/${path}:/children`
    : `/sites/${siteId}/drive/root/children`;

  const res = await userGraphGet<GraphListResponse<{
    id: string;
    name: string;
    webUrl: string;
    size?: number;
    lastModifiedDateTime: string;
    folder?: unknown;
  }>>(
    `${endpoint}?$select=id,name,webUrl,size,lastModifiedDateTime,folder&$top=50`,
    accessToken
  );

  return res.value.map((item) => ({
    id: item.id,
    name: item.name,
    webUrl: item.webUrl,
    size: item.size ?? 0,
    lastModifiedDateTime: item.lastModifiedDateTime,
    isFolder: !!item.folder,
  }));
}

/**
 * Searches SharePoint for content matching a query.
 */
export async function searchSharePoint(
  query: string,
  accessToken: string
): Promise<Array<{ title: string; webUrl: string; summary: string }>> {
  try {
    const res = await userGraphPost<{
      value: Array<{
        hitsContainers: Array<{
          hits: Array<{
            resource: {
              name: string;
              webUrl: string;
            };
            summary?: string;
          }>;
        }>;
      }>;
    }>(
      "/search/query",
      {
        requests: [
          {
            entityTypes: ["driveItem", "listItem", "site"],
            query: { queryString: query },
            from: 0,
            size: 10,
          },
        ],
      },
      accessToken
    );

    const hits = res.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    return hits.map((h) => ({
      title: h.resource.name,
      webUrl: h.resource.webUrl,
      summary: h.summary ?? "",
    }));
  } catch (err) {
    console.error("[Arcadia Webapp] SharePoint search failed:", err);
    return [];
  }
}
