// Microsoft Copilot Connector transport.
//
// The item adapter in src/openapi/connector.ts turns Arcadia records
// into ExternalItem shapes. This module is the cron-driven walker
// that PUTs them into /external/connections/{connId}/items/{itemId}.
//
// Idempotency: each item carries a stable id like "task:<uuid>" /
// "digest:<uuid>" / etc. PUT is upsert, so the loop is safe to
// re-run. A delta cursor in delta_state (resource='connector_sync')
// tracks the last `updated_at` we synced per scheme, so subsequent
// runs only touch changed rows.
//
// The connection itself is provisioned out-of-band (Graph Connectors
// admin UI or a separate one-shot script). This module assumes
// env.COPILOT_CONNECTION_ID is set; if not, syncAll() is a no-op.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { graph } from "../graph/client";
import {
  buildDigestBatch,
  buildTaskBatch,
  type ExternalItem,
  type ItemBatch,
} from "./connector";

const RESOURCE = "connector_sync";

export interface ConnectorSyncResult {
  connection: string | null;
  itemsConsidered: number;
  itemsUpserted: number;
  failures: number;
}

export async function syncAll(
  env: Env,
  log: Logger,
): Promise<ConnectorSyncResult> {
  const connection = env.COPILOT_CONNECTION_ID ?? null;
  const result: ConnectorSyncResult = {
    connection,
    itemsConsidered: 0,
    itemsUpserted: 0,
    failures: 0,
  };
  if (!connection) {
    log.info("connector_sync_disabled");
    return result;
  }

  for (const scheme of ["task", "digest"] as const) {
    const since = await readCursor(env, scheme);
    const batch =
      scheme === "task"
        ? await buildTaskBatch(env, since ?? undefined)
        : await buildDigestBatch(env, since ?? undefined);
    result.itemsConsidered += batch.items.length;
    if (batch.items.length === 0) continue;
    const summary = await pushBatch(env, connection, batch, log);
    result.itemsUpserted += summary.upserted;
    result.failures += summary.failures;
    const lastUpdated = lastUpdatedOf(batch);
    if (lastUpdated) await writeCursor(env, scheme, lastUpdated);
  }

  log.info("connector_sync", result);
  return result;
}

async function pushBatch(
  env: Env,
  connectionId: string,
  batch: ItemBatch,
  log: Logger,
): Promise<{ upserted: number; failures: number }> {
  let upserted = 0;
  let failures = 0;
  for (const item of batch.items) {
    try {
      await graph(env, {
        method: "PUT",
        path: `/external/connections/${connectionId}/items/${encodeURIComponent(item.id)}`,
        body: itemBody(item),
      });
      upserted += 1;
    } catch (e) {
      failures += 1;
      log.warn("connector_item_failed", {
        scheme: batch.scheme,
        itemId: item.id,
        error: String(e),
      });
    }
  }
  return { upserted, failures };
}

function itemBody(item: ExternalItem): Record<string, unknown> {
  return {
    acl: item.acl,
    properties: item.properties,
    ...(item.content ? { content: item.content } : {}),
    ...(item.activities ? { activities: item.activities } : {}),
  };
}

function lastUpdatedOf(batch: ItemBatch): string | null {
  let max: string | null = null;
  for (const item of batch.items) {
    const v = item.properties.updatedAt ?? item.properties.postedAt;
    if (typeof v === "string" && (!max || v > max)) max = v;
  }
  return max;
}

async function readCursor(env: Env, scheme: string): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(RESOURCE, scheme)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

async function writeCursor(
  env: Env,
  scheme: string,
  cursor: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state
       (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(RESOURCE, scheme, cursor, new Date().toISOString())
    .run();
}
