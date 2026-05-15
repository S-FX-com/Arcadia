// OneDrive / SharePoint document library producer.
//
// Walks /drives/{driveId}/root/delta for each tracked drive. The
// driveIds-of-interest list comes from the `documents` table's
// existing rows (we re-walk drives we've already indexed something
// from) plus any future explicit registration.
//
// Each driveItem becomes an IngestMessage with source='drive_item'
// and inline mimeType + uri so the consumer fetches the body via
// /content.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { graph } from "../../graph/client";
import type { IngestMessage } from "../types";

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  parentReference?: { driveId?: string };
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  createdBy?: { user?: { id?: string } };
  sensitivityLabel?: { id?: string; displayName?: string };
}

interface DriveDeltaPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const RESOURCE = "drive_items";

const SUPPORTED_MIMES = new Set([
  "text/plain",
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export interface DriveProducerResult {
  drives: number;
  enqueued: number;
  failures: number;
}

export async function produceDrives(
  env: Env,
  log: Logger,
): Promise<DriveProducerResult> {
  const driveIds = await knownDriveIds(env);
  const result: DriveProducerResult = {
    drives: driveIds.length,
    enqueued: 0,
    failures: 0,
  };

  for (const driveId of driveIds) {
    try {
      const enqueued = await walkDrive(env, driveId, log);
      result.enqueued += enqueued;
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_drive_failed", { driveId, error: String(e) });
    }
  }

  log.info("ingest_produced_drives", result);
  return result;
}

async function knownDriveIds(env: Env): Promise<string[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT json_extract(uri, '$.driveId') AS drive_id
       FROM documents
      WHERE source IN ('drive_item','sharepoint_page')
        AND uri IS NOT NULL`,
  ).all<{ drive_id: string | null }>();
  const out = new Set<string>();
  for (const r of rows.results) {
    if (r.drive_id) out.add(r.drive_id);
  }
  return [...out];
}

async function walkDrive(
  env: Env,
  driveId: string,
  log: Logger,
): Promise<number> {
  const cursor = await readCursor(env, RESOURCE, driveId);
  let url: string | undefined;
  let count = 0;
  let lastLink: string | undefined;

  do {
    const page: DriveDeltaPage = url
      ? await graph<DriveDeltaPage>(env, { path: url })
      : await graph<DriveDeltaPage>(env, {
          path: `/drives/${driveId}/root/delta`,
          query: cursor ? { token: cursor } : {},
        });

    for (const item of page.value) {
      if (item.folder) continue;
      const mime = item.file?.mimeType;
      if (!mime || !SUPPORTED_MIMES.has(mime)) continue;

      const msg: IngestMessage = {
        source: "drive_item",
        resourceId: item.id,
        uri: `/drives/${driveId}/items/${item.id}/content`,
        mimeType: mime,
        scope: { resourceType: "document", resourceId: item.id },
        ...(item.name ? { title: item.name } : {}),
        ...(item.eTag ? { etag: item.eTag } : {}),
        ...(item.createdBy?.user?.id
          ? { ownerAadId: item.createdBy.user.id }
          : {}),
        ...(item.lastModifiedDateTime
          ? { lastModifiedAt: item.lastModifiedDateTime }
          : {}),
        ...(item.sensitivityLabel?.displayName
          ? { sensitivityLabel: item.sensitivityLabel.displayName }
          : {}),
      };
      await env.INGEST_QUEUE.send(msg);
      count += 1;
    }

    url = page["@odata.nextLink"];
    if (page["@odata.deltaLink"]) lastLink = page["@odata.deltaLink"];
  } while (url);

  if (lastLink) {
    const tok = extractToken(lastLink);
    if (tok) await writeCursor(env, RESOURCE, driveId, tok);
  }
  log.info("ingest_drive_walked", { driveId, enqueued: count });
  return count;
}

async function readCursor(
  env: Env,
  resource: string,
  scopeKey: string,
): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(resource, scopeKey)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

async function writeCursor(
  env: Env,
  resource: string,
  scopeKey: string,
  token: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state
       (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(resource, scopeKey, token, new Date().toISOString())
    .run();
}

function extractToken(link: string): string | null {
  const m = link.match(/[?&]token=([^&]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
