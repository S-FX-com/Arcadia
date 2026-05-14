// Vectorize integration for the memory store.
//
// Uses Cloudflare's @cf/baai/bge-base-en-v1.5 (768 dims) so the index
// configured in wrangler.toml matches without re-indexing.

import type { Env } from "../env";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function embed(env: Env, text: string): Promise<number[]> {
  const r = (await env.AI.run(EMBED_MODEL, { text: [text] })) as {
    data: number[][];
  };
  const first = r.data[0];
  if (!first) throw new Error("embed_returned_no_vector");
  return first;
}

export async function upsertVector(
  env: Env,
  id: string,
  vector: number[],
  metadata: Record<string, string | number>,
): Promise<void> {
  await env.ARCADIA_VECTORS.upsert([{ id, values: vector, metadata }]);
}

export async function deleteVector(env: Env, id: string): Promise<void> {
  await env.ARCADIA_VECTORS.deleteByIds([id]);
}

export interface VectorHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export async function queryVectors(
  env: Env,
  vector: number[],
  opts: { topK?: number; filter?: Record<string, string | number> } = {},
): Promise<VectorHit[]> {
  const result = await env.ARCADIA_VECTORS.query(vector, {
    topK: opts.topK ?? 20,
    ...(opts.filter ? { filter: opts.filter as never } : {}),
    returnMetadata: true,
  });
  return result.matches.map((m) => ({
    id: m.id,
    score: m.score,
    ...(m.metadata
      ? { metadata: m.metadata as unknown as Record<string, unknown> }
      : {}),
  }));
}
