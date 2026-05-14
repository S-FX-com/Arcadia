// SharePoint pages producer.
//
// Walks /sites/{siteId}/pages for each tracked site, enqueues each
// page as a `sharepoint_page` IngestMessage. The page body is
// fetched lazily by the queue consumer via the canonical page id
// path; here we just enqueue the lightweight metadata.
//
// Site ids come from documents.uri (json with siteId) — same pattern
// as the drive producer.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { graph } from "../../graph/client";
import type { IngestMessage } from "../types";

interface SitePage {
  id: string;
  name?: string;
  title?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdBy?: { user?: { id?: string } };
}

interface SitePagesPage {
  value: SitePage[];
  "@odata.nextLink"?: string;
}

export interface SharepointProducerResult {
  sites: number;
  enqueued: number;
  failures: number;
}

export async function produceSharepoint(
  env: Env,
  log: Logger,
): Promise<SharepointProducerResult> {
  const siteIds = await knownSiteIds(env);
  const result: SharepointProducerResult = {
    sites: siteIds.length,
    enqueued: 0,
    failures: 0,
  };

  for (const siteId of siteIds) {
    try {
      const enqueued = await walkSite(env, siteId, log);
      result.enqueued += enqueued;
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_site_failed", { siteId, error: String(e) });
    }
  }

  log.info("ingest_produced_sharepoint", result);
  return result;
}

async function knownSiteIds(env: Env): Promise<string[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT json_extract(uri, '$.siteId') AS site_id
       FROM documents
      WHERE source = 'sharepoint_page' AND uri IS NOT NULL`,
  ).all<{ site_id: string | null }>();
  const out = new Set<string>();
  for (const r of rows.results) {
    if (r.site_id) out.add(r.site_id);
  }
  return [...out];
}

async function walkSite(
  env: Env,
  siteId: string,
  log: Logger,
): Promise<number> {
  let url: string | undefined;
  let count = 0;
  do {
    const page: SitePagesPage = url
      ? await graph<SitePagesPage>(env, { path: url })
      : await graph<SitePagesPage>(env, {
          path: `/sites/${siteId}/pages`,
          query: { $top: 50 },
        });

    for (const p of page.value) {
      const msg: IngestMessage = {
        source: "sharepoint_page",
        resourceId: p.id,
        uri: `/sites/${siteId}/pages/${p.id}/microsoft.graph.sitePage/canvasLayout`,
        scope: { resourceType: "document", resourceId: p.id },
        ...(p.title ? { title: p.title } : {}),
        ...(p.lastModifiedDateTime
          ? { lastModifiedAt: p.lastModifiedDateTime }
          : {}),
        ...(p.createdBy?.user?.id
          ? { ownerAadId: p.createdBy.user.id }
          : {}),
      };
      await env.INGEST_QUEUE.send(msg);
      count += 1;
    }
    url = page["@odata.nextLink"];
  } while (url);

  log.info("ingest_site_walked", { siteId, enqueued: count });
  return count;
}
