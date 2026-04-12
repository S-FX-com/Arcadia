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
