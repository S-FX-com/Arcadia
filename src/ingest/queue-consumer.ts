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

export async function consumeBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
  log: Logger,
): Promise<ConsumeResult> {
  const result: ConsumeResult = {
    considered: batch.messages.length,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const message of batch.messages) {
    try {
      const outcome = await consumeOne(env, message.body, log);
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
): Promise<Outcome> {
  const documentId = await upsertDocument(env, msg);

  let body = msg.body ?? null;
  if (!body && msg.uri) {
    body = await fetchBody(env, msg, log);
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

  await indexChunks(
    env,
    {
      documentId,
      chunks,
      scope: msg.scope ?? defaultScopeFor(msg),
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

async function upsertDocument(env: Env, msg: IngestMessage): Promise<string> {
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
              owner_aad_id = COALESCE(?, owner_aad_id)
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
        sensitivity_label, last_modified_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // OneNote pages return HTML; Drive items return raw bytes via /content.
      if (msg.source === "onenote_page") {
        const html = await graph<string>(env, {
          path,
          headers: { accept: "text/html" },
        });
        return { content: html, contentType: "onenote" };
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
      return { resourceType: "user", resourceId: msg.ownerAadId ?? "tenant" };
    case "manual":
    default:
      return { resourceType: "tenant", resourceId: "tenant" };
  }
}
