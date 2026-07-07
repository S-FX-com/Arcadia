// Per-user mail producer.
//
// Users come from the `users` registry table, processed in a capped,
// KV-round-robin batch (cursor `ingest:mail_cursor`) so the whole
// directory rotates through over successive runs. Each mailbox is walked
// via /users/{aadId}/messages/delta ($select trims the payload — the full
// body is fetched later by the consumer via the message uri), with the
// @odata.deltaLink persisted verbatim in delta_state (resource 'mail').
//
// A 403/404 on a mailbox is expected and skipped silently: the mailbox may
// be unlicensed or outside the Exchange application access policy.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { loadDeltaToken, saveDeltaToken } from "../../graph/delta";
import type { GraphRequest } from "../../graph/client";
import type { IngestMessage } from "../types";
import {
  defaultProducerDeps,
  GraphError,
  loadCursor,
  saveCursor,
  type ProducerDeps,
} from "./deps";

interface GraphMailMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
  "@removed"?: unknown;
}

const RESOURCE = "mail";
const MAIL_CAP = 25;
const MAIL_CURSOR_KEY = "ingest:mail_cursor";

export interface MailProducerResult {
  users: number;
  enqueued: number;
  failures: number;
}

export async function produceMail(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
  cap: number = MAIL_CAP,
): Promise<MailProducerResult> {
  const cursor = await loadCursor(env, MAIL_CURSOR_KEY);
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users WHERE aad_id > ? ORDER BY aad_id LIMIT ?`,
  )
    .bind(cursor, cap)
    .all<{ aad_id: string }>();

  const result: MailProducerResult = {
    users: rows.results.length,
    enqueued: 0,
    failures: 0,
  };

  for (const row of rows.results) {
    try {
      result.enqueued += await walkMailbox(env, row.aad_id, log, deps);
    } catch (e) {
      if (e instanceof GraphError && (e.status === 403 || e.status === 404)) {
        log.debug("ingest_mail_skipped", {
          aadId: row.aad_id,
          status: e.status,
        });
        continue;
      }
      result.failures += 1;
      log.warn("ingest_mail_failed", {
        aadId: row.aad_id,
        error: String(e),
      });
    }
  }

  await saveCursor(
    env,
    MAIL_CURSOR_KEY,
    rows.results.map((r) => r.aad_id),
    cap,
  );

  log.info("ingest_produced_mail", result);
  return result;
}

async function walkMailbox(
  env: Env,
  aadId: string,
  log: Logger,
  deps: ProducerDeps,
): Promise<number> {
  const stored = await loadDeltaToken(env, RESOURCE, aadId);
  const req: GraphRequest = stored
    ? { path: stored }
    : {
        path: `/users/${aadId}/messages/delta`,
        query: {
          $select: "id,subject,bodyPreview,receivedDateTime,from,hasAttachments",
        },
      };

  const { items, deltaLink } = await deps.graphAllPages<GraphMailMessage>(
    env,
    req,
    { maxPages: 50 },
  );

  let count = 0;
  for (const m of items) {
    if (m["@removed"] !== undefined) continue;
    const msg: IngestMessage = {
      source: "mail_message",
      resourceId: m.id,
      uri: `/users/${aadId}/messages/${m.id}`,
      ownerAadId: aadId,
      scope: { resourceType: "user", resourceId: aadId },
      ...(m.subject ? { title: m.subject } : {}),
      ...(m.receivedDateTime ? { lastModifiedAt: m.receivedDateTime } : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (deltaLink) await saveDeltaToken(env, RESOURCE, aadId, deltaLink);
  log.info("ingest_mailbox_walked", { aadId, enqueued: count });
  return count;
}
