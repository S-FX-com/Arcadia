// OneDrive / SharePoint document-library producer.
//
// Enumerates from the first-class `drives` registry table (populated by
// src/graph/registry.ts) — NOT from json_extract over documents.uri,
// which never matched and is why drive/SharePoint ingestion never ran.
//
// Each run processes a capped, KV-round-robin batch of drives so a large
// tenant rotates through every drive over successive ticks. For each drive
// we walk /drives/{driveId}/root/delta via graphAllPages, persisting the
// returned @odata.deltaLink verbatim in delta_state so the next run only
// sees changes. Files become drive_item IngestMessages (folders and
// unsupported mime types are skipped); the consumer fetches the body via
// the /content uri.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { loadDeltaToken, saveDeltaToken } from "../../graph/delta";
import type { GraphRequest } from "../../graph/client";
import type { IngestMessage } from "../types";
import {
  defaultProducerDeps,
  loadCursor,
  saveCursor,
  type ProducerDeps,
} from "./deps";

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  lastModifiedDateTime?: string;
  createdBy?: { user?: { id?: string } };
  sensitivityLabel?: { id?: string; displayName?: string };
  "@removed"?: unknown;
}

interface DriveRow {
  drive_id: string;
  owner_type: "user" | "site" | "group";
  owner_id: string | null;
}

const RESOURCE = "drive";
const DRIVE_CAP = 25;
const DRIVE_CURSOR_KEY = "ingest:drive_cursor";

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
  deps: ProducerDeps = defaultProducerDeps,
  cap: number = DRIVE_CAP,
): Promise<DriveProducerResult> {
  const cursor = await loadCursor(env, DRIVE_CURSOR_KEY);
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT drive_id, owner_type, owner_id FROM drives
      WHERE drive_id > ? ORDER BY drive_id LIMIT ?`,
  )
    .bind(cursor, cap)
    .all<DriveRow>();

  const result: DriveProducerResult = {
    drives: rows.results.length,
    enqueued: 0,
    failures: 0,
  };

  for (const row of rows.results) {
    try {
      result.enqueued += await walkDrive(env, row, log, deps);
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_drive_failed", {
        driveId: row.drive_id,
        error: String(e),
      });
    }
  }

  await saveCursor(
    env,
    DRIVE_CURSOR_KEY,
    rows.results.map((r) => r.drive_id),
    cap,
  );

  log.info("ingest_produced_drives", result);
  return result;
}

async function walkDrive(
  env: Env,
  row: DriveRow,
  log: Logger,
  deps: ProducerDeps,
): Promise<number> {
  const stored = await loadDeltaToken(env, RESOURCE, row.drive_id);
  const req: GraphRequest = stored
    ? { path: stored }
    : { path: `/drives/${row.drive_id}/root/delta` };

  const { items, deltaLink } = await deps.graphAllPages<DriveItem>(env, req, {
    maxPages: 50,
  });

  const scope =
    row.owner_type === "site"
      ? { resourceType: "site", resourceId: row.owner_id ?? row.drive_id }
      : row.owner_type === "user"
        ? { resourceType: "user", resourceId: row.owner_id ?? row.drive_id }
        : { resourceType: "document", resourceId: row.drive_id };

  let count = 0;
  for (const item of items) {
    if (item["@removed"] !== undefined) continue;
    if (item.folder) continue;
    const mime = item.file?.mimeType;
    if (!mime || !SUPPORTED_MIMES.has(mime)) continue;

    const ownerAadId =
      row.owner_type === "user" && row.owner_id
        ? row.owner_id
        : item.createdBy?.user?.id;

    const msg: IngestMessage = {
      source: "drive_item",
      resourceId: item.id,
      uri: `/drives/${row.drive_id}/items/${item.id}/content`,
      mimeType: mime,
      scope,
      ...(item.name ? { title: item.name } : {}),
      ...(item.eTag ? { etag: item.eTag } : {}),
      ...(ownerAadId ? { ownerAadId } : {}),
      ...(item.lastModifiedDateTime
        ? { lastModifiedAt: item.lastModifiedDateTime }
        : {}),
      ...(item.sensitivityLabel?.displayName
        ? { sensitivityLabel: item.sensitivityLabel.displayName }
        : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (deltaLink) await saveDeltaToken(env, RESOURCE, row.drive_id, deltaLink);
  log.info("ingest_drive_walked", { driveId: row.drive_id, enqueued: count });
  return count;
}
