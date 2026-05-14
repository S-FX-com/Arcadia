// Embedding pipeline.
//
// Generates a Vectorize vector for each chunk and writes a
// document_chunks row holding the chunk text + the embedding id. The
// embedder is shared with src/memory/vector.ts so memory and ingest
// vectors share the same 768-dim BGE base index — recall can pull
// across both surfaces in one query.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { embed, upsertVector } from "../memory/vector";
import type { Chunk } from "./types";

export interface IndexedChunk {
  id: string;
  ordinal: number;
  embeddingId: string;
}

export interface IndexDocumentInput {
  documentId: string;
  chunks: Chunk[];
  scope: { resourceType: string; resourceId: string };
  sensitivityLabel?: string;
  source: string;
  ownerAadId?: string;
  title?: string;
}

export async function indexChunks(
  env: Env,
  input: IndexDocumentInput,
  log: Logger,
): Promise<IndexedChunk[]> {
  const indexed: IndexedChunk[] = [];

  for (const chunk of input.chunks) {
    const id = crypto.randomUUID();
    const embeddingId = `doc:${id}`;
    try {
      const vector = await embed(env, chunk.text);
      await upsertVector(env, embeddingId, vector, {
        document_id: input.documentId,
        chunk_id: id,
        scope_type: input.scope.resourceType,
        scope_id: input.scope.resourceId,
        source: input.source,
        ...(input.ownerAadId ? { owner_aad_id: input.ownerAadId } : {}),
        ...(input.sensitivityLabel
          ? { sensitivity_label: input.sensitivityLabel }
          : {}),
      });

      await env.ARCADIA_DB.prepare(
        `INSERT INTO document_chunks
           (id, document_id, ordinal, text, embedding_id, sensitivity_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          input.documentId,
          chunk.ordinal,
          chunk.text,
          embeddingId,
          input.sensitivityLabel ?? null,
          new Date().toISOString(),
        )
        .run();

      indexed.push({ id, ordinal: chunk.ordinal, embeddingId });
    } catch (e) {
      log.warn("embed_failed", {
        documentId: input.documentId,
        ordinal: chunk.ordinal,
        error: String(e),
      });
    }
  }

  return indexed;
}
