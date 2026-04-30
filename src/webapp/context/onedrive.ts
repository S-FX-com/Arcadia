// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — OneDrive Context Provider
//
// Fetches the authenticated user's personal OneDrive files using the
// delegated Files.Read scope. Surfaces recently modified files for context.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { OneDriveItem } from "../types.js";

interface GraphDriveItem {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  lastModifiedDateTime: string;
  folder?: unknown;
}

function normalizeItem(raw: GraphDriveItem): OneDriveItem {
  return {
    id: raw.id,
    name: raw.name,
    webUrl: raw.webUrl,
    size: raw.size ?? 0,
    lastModifiedDateTime: raw.lastModifiedDateTime,
    isFolder: !!raw.folder,
  };
}

/**
 * Returns the user's recently modified OneDrive files (non-folder items only),
 * ordered by last modified descending.
 * Requires Files.Read delegated scope.
 */
export async function getRecentDriveItems(
  accessToken: string,
  limit = 20,
): Promise<OneDriveItem[]> {
  const res = await userGraphGet<{ value: GraphDriveItem[] }>(
    `/me/drive/recent?$select=id,name,webUrl,size,lastModifiedDateTime,folder&$top=${Math.min(limit, 50)}`,
    accessToken,
  );
  return res.value
    .filter((item) => !item.folder)
    .map(normalizeItem);
}

/**
 * Returns the root-level children of the user's OneDrive.
 * Useful for browsing top-level folders to link as client sources.
 * Requires Files.Read delegated scope.
 */
export async function getDriveRootItems(accessToken: string): Promise<OneDriveItem[]> {
  const res = await userGraphGet<{ value: GraphDriveItem[] }>(
    "/me/drive/root/children?$select=id,name,webUrl,size,lastModifiedDateTime,folder&$top=50",
    accessToken,
  );
  return res.value.map(normalizeItem);
}
