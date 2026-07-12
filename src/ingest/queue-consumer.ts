// Cloudflare Queue consumer.
//
// Each message is an IngestMessage. The consumer:
//
//   1. Upserts a `documents` row keyed by (source, resource_id).
//   2. Fetches the body if the message didn't carry one inline.
//   3. Parses via the matching parser (HTML / plain / OneNote / PDF).
//   4. Chunks the parsed text.
//   5. Embeds + indexes chunks via src/ingest/embeddings.ts.
//
// Per-message failures call message.retry() so Cloudflare's queue
// re-delivers with backoff. The whole batch never aborts on one bad
// item.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { graph } from "../graph/client";
import { chunk } from "./chunker";
import { indexChunks } from "./embeddings";
import { parseHtml } from "./parsers/html";
import { parseOneNote } from "./parsers/onenote";
import { parsePdf } from "./parsers/pdf";
import { parsePlain } from "./parsers/plain";
import type { IngestMessage, ParsedDocument } from "./types";

export interface ConsumeResult {
  considered: number;
  indexed: number;
  skipped: number;
  failed: number;
}

/**
 * Injectable seams for the two steps miniflare cannot simulate: the embed +
 * Vectorize write (indexChunks) and the auth'd Graph body fetch (fetchBody).
 * Both default to the real implementations, so production call sites pass no
 * deps and are unaffected; integration tests inject stubs because Workers AI,
 * Vectorize, and live Graph are unavailable under the test pool.
 */
export interface ConsumeDeps {
  indexChunks: typeof indexChunks;
  fetchBody: typeof fetchBody;
}

const DEFAULT_DEPS: ConsumeDeps = { indexChunks, fetchBody };

export async function consumeBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  log: Logger,
  deps: Partial<ConsumeDeps> = {},
): Promise<ConsumeResult> {
  const d: ConsumeDeps = { ...DEFAULT_DEPS, ...deps };
  const result: ConsumeResult = {
    considered: batch.messages.length,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const message of batch.messages) {
    try {
      const outcome = await consumeOne(env, message.body, log, d);
      if (outcome === "indexed") result.indexed += 1;
      else result.skipped += 1;
      message.ack();
    } catch (e) {
      result.failed += 1;
      log.error("ingest_message_failed", {
        source: message.body.source,
        resourceId: message.body.resourceId,
        error: String(e),
      });
      message.retry();
    }
  }

  log.info("ingest_batch", result);
  return result;
}

type Outcome = "indexed" | "skipped";

async function consumeOne(
  env: Env,
  msg: IngestMessage,
  log: Logger,
  deps: ConsumeDeps,
): Promise<Outcome> {
  const scope = msg.scope ?? defaultScopeFor(msg);
  const documentId = await upsertDocument(env, msg, scope);

  let body = msg.body ?? null;
  if (!body && msg.uri) {
    body = await deps.fetchBody(env, msg, log);
  }
  if (!body) {
    log.info("ingest_no_body", {
      source: msg.source,
      resourceId: msg.resourceId,
    });
    return "skipped";
  }

  const parsed = await parse(env, body, msg);
  if (parsed.text.trim().length < 20) {
    log.info("ingest_empty_parse", {
      source: msg.source,
      resourceId: msg.resourceId,
    });
    return "skipped";
  }

  const chunks = chunk(parsed.text);
  if (chunks.length === 0) return "skipped";

  await deps.indexChunks(
    env,
    {
      documentId,
      chunks,
      scope,
      source: msg.source,
      ...(msg.sensitivityLabel ? { sensitivityLabel: msg.sensitivityLabel } : {}),
      ...(msg.ownerAadId ? { ownerAadId: msg.ownerAadId } : {}),
      ...(parsed.title ?? msg.title
        ? { title: parsed.title ?? msg.title }
        : {}),
    },
    log,
  );

  return "indexed";
}

async function upsertDocument(
  env: Env,
  msg: IngestMessage,
  scope: { resourceType: string; resourceId: string },
): Promise<string> {
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT id FROM documents WHERE source = ? AND resource_id = ?`,
  )
    .bind(msg.source, msg.resourceId)
    .first<{ id: string }>();

  if (existing) {
    await env.ARCADIA_DB.prepare(
      `UPDATE documents
          SET title = COALESCE(?, title),
              uri = COALESCE(?, uri),
              mime_type = COALESCE(?, mime_type),
              etag = COALESCE(?, etag),
              sensitivity_label = COALESCE(?, sensitivity_label),
              last_modified_at = COALESCE(?, last_modified_at),
              indexed_at = ?,
              owner_aad_id = COALESCE(?, owner_aad_id),
              scope_type = ?,
              scope_id = ?
        WHERE id = ?`,
    )
      .bind(
        msg.title ?? null,
        msg.uri ?? null,
        msg.mimeType ?? null,
        msg.etag ?? null,
        msg.sensitivityLabel ?? null,
        msg.lastModifiedAt ?? null,
        new Date().toISOString(),
        msg.ownerAadId ?? null,
        scope.resourceType,
        scope.resourceId,
        existing.id,
      )
      .run();
    // Drop old chunks so we re-index without dupes.
    await env.ARCADIA_DB.prepare(
      `DELETE FROM document_chunks WHERE document_id = ?`,
    )
      .bind(existing.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.ARCADIA_DB.prepare(
    `INSERT INTO documents
       (id, source, resource_id, owner_aad_id, title, uri, mime_type, etag,
        sensitivity_label, last_modified_at, indexed_at, scope_type, scope_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      msg.source,
      msg.resourceId,
      msg.ownerAadId ?? null,
      msg.title ?? null,
      msg.uri ?? null,
      msg.mimeType ?? null,
      msg.etag ?? null,
      msg.sensitivityLabel ?? null,
      msg.lastModifiedAt ?? null,
      new Date().toISOString(),
      scope.resourceType,
      scope.resourceId,
    )
    .run();
  return id;
}

interface InlineBody {
  content: string;
  contentType: "text" | "html" | "pdf" | "onenote";
}

async function fetchBody(
  env: Env,
  msg: IngestMessage,
  log: Logger,
): Promise<InlineBody | null> {
  if (!msg.uri) return null;
  try {
    const path = msg.uri.startsWith("http") ? msg.uri : msg.uri;
    // Graph paths: route through the auth'd client.
    if (path.startsWith("/")) {
      // Mail: the producer stores /users/{id}/messages/{id}; index
      // body.content (HTML by default) rather than the /content endpoint,
      // which returns the raw MIME/EML representation.
      if (msg.source === "mail_message") {
        const mail = await graph<{
          body?: { content?: string; contentType?: "text" | "html" };
        }>(env, { path, query: { $select: "body" } });
        const content = mail.body?.content;
        if (!content) return null;
        return {
          content,
          contentType: mail.body?.contentType === "text" ? "text" : "html",
        };
      }
      // OneNote pages return HTML; Drive items return raw bytes via /content.
      if (msg.source === "onenote_page") {
        const html = await graph<string>(env, {
          path,
          headers: { accept: "text/html" },
        });
        return { content: html, contentType: "onenote" };
      }
      // Calendar events have no /content endpoint: notification-driven events
      // arrive with just a resource path, so fetch the event JSON and lift its
      // body (subject as fallback) into a parseable inline body.
      if (msg.source === "calendar_event") {
        const evt = await graph<{
          subject?: string;
          bodyPreview?: string;
          body?: { contentType?: string; content?: string };
        }>(env, { path });
        const content = evt.body?.content ?? evt.bodyPreview ?? evt.subject ?? "";
        const contentType = evt.body?.contentType === "text" ? "text" : "html";
        return { content, contentType };
      }
      const contentPath = path.endsWith("/content") ? path : `${path}/content`;
      const res = await fetchGraphRaw(env, contentPath);
      if (!res) return null;
      if (msg.mimeType?.startsWith("text/")) {
        return { content: await res.text(), contentType: "text" };
      }
      if (msg.mimeType === "application/pdf") {
        const buf = await res.arrayBuffer();
        const parsed = await parsePdf(env, buf, msg.title);
        return { content: parsed.text, contentType: "text" };
      }
      if (msg.mimeType === "text/html" || !msg.mimeType) {
        return { content: await res.text(), contentType: "html" };
      }
      return null;
    }
    const res = await fetch(path);
    if (!res.ok) return null;
    return { content: await res.text(), contentType: "html" };
  } catch (e) {
    log.warn("ingest_fetch_failed", {
      resourceId: msg.resourceId,
      error: String(e),
    });
    return null;
  }
}

async function fetchGraphRaw(
  env: Env,
  path: string,
): Promise<Response | null> {
  // graph<T>() JSON-parses; we use it for auth but bypass parsing here
  // by going through fetch + appToken directly.
  const { appToken } = await import("../graph/auth");
  const token = await appToken(env);
  const url = path.startsWith("http")
    ? path
    : `https://graph.microsoft.com/v1.0${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok ? res : null;
}

async function parse(
  env: Env,
  body: InlineBody,
  msg: IngestMessage,
): Promise<ParsedDocument> {
  switch (body.contentType) {
    case "html":
      return parseHtml(body.content);
    case "onenote":
      return parseOneNote(body.content);
    case "pdf": {
      // Body content is base64 for PDF inline bodies.
      const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)).buffer;
      return parsePdf(env, bytes, msg.title);
    }
    case "text":
    default:
      return parsePlain(body.content);
  }
}

function defaultScopeFor(
  msg: IngestMessage,
): { resourceType: string; resourceId: string } {
  switch (msg.source) {
    case "teams_channel_message":
    case "teams_message":
      return { resourceType: "channel", resourceId: msg.resourceId };
    case "chat_message":
      return { resourceType: "chat", resourceId: msg.resourceId };
    case "drive_item":
    case "sharepoint_page":
      return { resourceType: "document", resourceId: msg.resourceId };
    case "onenote_page":
      return { resourceType: "document", resourceId: msg.resourceId };
    case "calendar_event":
    case "mail_message":
    case "meeting_transcript":
      return { resourceType: "user", resourceId: msg.ownerAadId ?? "tenant" };
    case "manual":
    default:
      return { resourceType: "tenant", resourceId: "tenant" };
  }
}
