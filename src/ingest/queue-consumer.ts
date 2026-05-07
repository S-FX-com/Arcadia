// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Ingest queue consumer (Phase 3)
//
// Consumes messages from the `arcadia-ingest` queue. Each message describes
// one M365 artifact to ingest:
//
//   { kind: 'upsert',  resourceType, resourceId, accessToken, contentUri,
//     mime, principals?, sensitivityLabel? }
//   { kind: 'remove',  resourceType, resourceId }
//
// The consumer fetches the body, picks a parser, chunks the text, embeds
// each chunk, and writes to documents + document_chunks + Vectorize.
// Removes flip documents.deleted_at and delete the chunks' Vectorize
// entries so semanticRecall stops surfacing them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ResourceType, AclPrincipal } from "../types.js";
import { parseContent } from "./parsers/index.js";
import { chunkText } from "../index/chunker.js";
import { generateEmbedding } from "../memory/vectors.js";
import { recordResourceAcl } from "../graph/acl.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "ingest-consumer" });

export type IngestMessage =
	| {
			kind: "upsert";
			resourceType: ResourceType;
			resourceId: string;
			contentUri: string;
			accessToken: string;
			mime: string | null;
			title?: string;
			principals?: AclPrincipal[];
			sensitivityLabel?: string;
		}
	| {
			kind: "remove";
			resourceType: ResourceType;
			resourceId: string;
		};

export async function handleIngestBatch(
	batch: { messages: Array<{ body: IngestMessage; ack: () => void; retry: () => void }> },
	env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		try {
			await processOne(msg.body, env);
			msg.ack();
		} catch (err) {
			log.error("ingest_message_failed", { kind: msg.body.kind, resourceType: msg.body.resourceType, resourceId: msg.body.resourceId }, err);
			msg.retry();
		}
	}
}

async function processOne(msg: IngestMessage, env: Env): Promise<void> {
	if (msg.kind === "remove") {
		return await handleRemove(msg, env);
	}
	return await handleUpsert(msg, env);
}

async function handleRemove(msg: { resourceType: ResourceType; resourceId: string }, env: Env): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	// Soft-delete documents.
	await env.ARCADIA_DB.prepare(
		`UPDATE documents SET deleted_at = ? WHERE source_resource_type = ? AND source_resource_id = ? AND deleted_at IS NULL`,
	)
		.bind(now, msg.resourceType, msg.resourceId)
		.run();

	// Find chunks to remove from Vectorize (so search stops surfacing them).
	const chunks = await env.ARCADIA_DB.prepare(
		`SELECT c.id FROM document_chunks c
		   JOIN documents d ON d.id = c.document_id
		  WHERE d.source_resource_type = ? AND d.source_resource_id = ?`,
	)
		.bind(msg.resourceType, msg.resourceId)
		.all<{ id: string }>();

	const ids = chunks.results.map((r) => r.id);
	if (ids.length > 0 && env.ARCADIA_VECTORS) {
		await env.ARCADIA_VECTORS.deleteByIds(ids).catch(swallow(log, "vectorize_delete_failed", undefined, { count: ids.length }));
	}

	log.info("ingest_remove", { resourceType: msg.resourceType, resourceId: msg.resourceId, chunks: ids.length });
}

async function handleUpsert(
	msg: Extract<IngestMessage, { kind: "upsert" }>,
	env: Env,
): Promise<void> {
	const res = await fetch(msg.contentUri, { headers: { Authorization: `Bearer ${msg.accessToken}` } });
	if (!res.ok) {
		throw new Error(`fetch ${msg.contentUri} failed (${res.status})`);
	}
	const buf = await res.arrayBuffer();
	const parsed = await parseContent(buf, msg.mime);
	if (!parsed.text) {
		log.warn("ingest_empty_text", { resourceType: msg.resourceType, resourceId: msg.resourceId, mime: msg.mime });
		return;
	}

	// SHA-256 of the parsed text for dedup on re-ingest.
	const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parsed.text));
	const shaHex = Array.from(new Uint8Array(sha)).map((b) => b.toString(16).padStart(2, "0")).join("");

	const now = Math.floor(Date.now() / 1000);
	const docId = crypto.randomUUID();

	// Skip if an alive document already exists with the same hash.
	const existing = await env.ARCADIA_DB.prepare(
		`SELECT id FROM documents WHERE source_resource_type = ? AND source_resource_id = ? AND content_sha256 = ? AND deleted_at IS NULL LIMIT 1`,
	)
		.bind(msg.resourceType, msg.resourceId, shaHex)
		.first<{ id: string }>();
	if (existing) {
		log.info("ingest_dedup", { resourceType: msg.resourceType, resourceId: msg.resourceId, sha: shaHex });
		return;
	}

	// Soft-delete any prior alive version of this resource so search stops
	// returning the old chunks the moment new ones land.
	await env.ARCADIA_DB.prepare(
		`UPDATE documents SET deleted_at = ? WHERE source_resource_type = ? AND source_resource_id = ? AND deleted_at IS NULL`,
	)
		.bind(now, msg.resourceType, msg.resourceId)
		.run();

	await env.ARCADIA_DB.prepare(
		`INSERT INTO documents (id, source_resource_type, source_resource_id, title, uri, mime_type, size_bytes, content_sha256, created_at, updated_at, sensitivity_label)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(docId, msg.resourceType, msg.resourceId, parsed.title ?? msg.title ?? null, msg.contentUri, msg.mime ?? null, buf.byteLength, shaHex, now, now, msg.sensitivityLabel ?? null)
		.run();

	// Persist ACL once.
	if (msg.principals && msg.principals.length > 0) {
		await recordResourceAcl(msg.resourceType, msg.resourceId, msg.principals, env)
			.catch(swallow(log, "ingest_acl_write_failed", undefined, { resourceType: msg.resourceType, resourceId: msg.resourceId }));
	}

	const chunks = chunkText(parsed.text);
	if (chunks.length === 0) return;

	for (const c of chunks) {
		const chunkId = crypto.randomUUID();
		await env.ARCADIA_DB.prepare(
			`INSERT INTO document_chunks (id, document_id, ordinal, content, token_estimate, created_at, embedding_status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
		)
			.bind(chunkId, docId, c.ordinal, c.content, c.tokenEstimate, now)
			.run();

		if (env.ARCADIA_VECTORS) {
			try {
				const vec = await generateEmbedding(c.content, env);
				await env.ARCADIA_VECTORS.upsert([{
					id: chunkId,
					values: vec,
					metadata: {
						source_resource_type: msg.resourceType,
						source_resource_id: msg.resourceId,
						document_id: docId,
						ordinal: c.ordinal,
					},
				}]);
				await env.ARCADIA_DB.prepare(
					`UPDATE document_chunks SET embedding_status = 'indexed' WHERE id = ?`,
				).bind(chunkId).run();
			} catch (err) {
				log.warn("chunk_embedding_failed", { chunkId, documentId: docId }, err);
				await env.ARCADIA_DB.prepare(
					`UPDATE document_chunks SET embedding_status = 'failed' WHERE id = ?`,
				).bind(chunkId).run();
			}
		}
	}

	log.info("ingest_complete", { resourceType: msg.resourceType, resourceId: msg.resourceId, chunks: chunks.length });
}
