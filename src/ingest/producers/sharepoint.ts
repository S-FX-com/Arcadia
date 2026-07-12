// SharePoint pages producer.
//
// Enumerates from the first-class `sites` registry table (populated by
// src/graph/registry.ts) — NOT from json_extract over documents.uri. Each
// run processes a capped, KV-round-robin batch of sites.
//
// /sites/{siteId}/pages has no delta endpoint, so freshness rides a
// lastModifiedDateTime watermark stored in delta_state (resource
// 'sharepoint_pages', scope_key=siteId): each run enqueues pages newer
// than the stored watermark and advances it to the newest seen. The page
// body is fetched lazily by the queue consumer via the canvasLayout uri.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { loadDeltaToken, saveDeltaToken } from "../../graph/delta";
import type { IngestMessage } from "../types";
import {
  defaultProducerDeps,
  loadCursor,
  saveCursor,
  type ProducerDeps,
} from "./deps";

interface SitePage {
  id: string;
  name?: string;
  title?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdBy?: { user?: { id?: string } };
}

const RESOURCE = "sharepoint_pages";
const SITE_CAP = 25;
const SITE_CURSOR_KEY = "ingest:sharepoint_cursor";

export interface SharepointProducerResult {
  sites: number;
  enqueued: number;
  failures: number;
}

export async function produceSharepoint(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
  cap: number = SITE_CAP,
): Promise<SharepointProducerResult> {
  const cursor = await loadCursor(env, SITE_CURSOR_KEY);
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT site_id FROM sites WHERE site_id > ? ORDER BY site_id LIMIT ?`,
  )
    .bind(cursor, cap)
    .all<{ site_id: string }>();

  const result: SharepointProducerResult = {
    sites: rows.results.length,
    enqueued: 0,
    failures: 0,
  };

  for (const row of rows.results) {
    try {
      result.enqueued += await walkSite(env, row.site_id, log, deps);
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_site_failed", { siteId: row.site_id, error: String(e) });
    }
  }

  await saveCursor(
    env,
    SITE_CURSOR_KEY,
    rows.results.map((r) => r.site_id),
    cap,
  );

  log.info("ingest_produced_sharepoint", result);
  return result;
}

async function walkSite(
  env: Env,
  siteId: string,
  log: Logger,
  deps: ProducerDeps,
): Promise<number> {
  const watermark = await loadDeltaToken(env, RESOURCE, siteId);
  const { items } = await deps.graphAllPages<SitePage>(
    env,
    { path: `/sites/${siteId}/pages`, query: { $top: "50" } },
    { maxPages: 20 },
  );

  let count = 0;
  let newest = watermark ?? "";
  for (const p of items) {
    const lm = p.lastModifiedDateTime;
    if (watermark && lm && lm <= watermark) continue;
    if (lm && lm > newest) newest = lm;

    const msg: IngestMessage = {
      source: "sharepoint_page",
      resourceId: p.id,
      uri: `/sites/${siteId}/pages/${p.id}/microsoft.graph.sitePage/canvasLayout`,
      scope: { resourceType: "site", resourceId: siteId },
      ...(p.title ? { title: p.title } : {}),
      ...(lm ? { lastModifiedAt: lm } : {}),
      ...(p.createdBy?.user?.id ? { ownerAadId: p.createdBy.user.id } : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (newest && newest !== watermark) {
    await saveDeltaToken(env, RESOURCE, siteId, newest);
  }
  log.info("ingest_site_walked", { siteId, enqueued: count });
  return count;
}
