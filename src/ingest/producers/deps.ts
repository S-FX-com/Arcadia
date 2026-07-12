// Injectable Graph + queue seam for the ingest producers.
//
// Mirrors the RegistryDeps pattern in src/graph/registry.ts: every
// producer takes a `deps` argument defaulting to defaultProducerDeps, so
// integration tests can substitute a stubbed Graph seam and a collector
// for the queue without touching a live Graph or the real INGEST_QUEUE.
//
// `graphText` is the raw-body counterpart to `graph<T>()` — it does NOT
// JSON-parse the response, which is required for meeting transcripts
// (text/vtt) and any other non-JSON Graph payload.

import type { Env } from "../../env";
import { appToken } from "../../graph/auth";
import {
  buildUrl,
  graph,
  graphAllPages,
  GraphError,
  type GraphAllPagesOptions,
  type GraphRequest,
} from "../../graph/client";
import type { IngestMessage } from "../types";

export { GraphError };

export interface ProducerDeps {
  graphAllPages: <T = unknown>(
    env: Env,
    req: GraphRequest,
    opts?: GraphAllPagesOptions,
  ) => Promise<{ items: T[]; deltaLink?: string }>;
  graph: <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;
  /** Fetch a raw (non-JSON) Graph body — used for text/vtt transcripts. */
  graphText: (env: Env, req: GraphRequest) => Promise<string>;
  /** Enqueue an ingest message (INGEST_QUEUE.send in production). */
  send: (env: Env, msg: IngestMessage) => Promise<void>;
  /** Injectable clock so watermark/window math is deterministic in tests. */
  now: () => Date;
}

async function graphTextDefault(env: Env, req: GraphRequest): Promise<string> {
  const token = req.token ?? (await appToken(env));
  const res = await fetch(buildUrl(req), {
    method: req.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(req.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new GraphError(res.status, text);
  return text;
}

export const defaultProducerDeps: ProducerDeps = {
  graphAllPages,
  graph,
  graphText: graphTextDefault,
  send: async (env, msg) => {
    await env.INGEST_QUEUE.send(msg);
  },
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// KV round-robin cursor helpers
// ---------------------------------------------------------------------------
//
// Producers that cap the number of scopes (drives/sites/users) per run walk
// the backing table in primary-key order, remembering the last id in KV so
// successive runs rotate through the whole set. When a batch returns fewer
// rows than the cap the sweep is complete and the cursor resets to the start.

export async function loadCursor(env: Env, key: string): Promise<string> {
  return (await env.ARCADIA_CACHE.get(key)) ?? "";
}

export async function saveCursor(
  env: Env,
  key: string,
  ids: string[],
  cap: number,
): Promise<void> {
  const last = ids.at(-1);
  const next = ids.length < cap || last === undefined ? "" : last;
  await env.ARCADIA_CACHE.put(key, next);
}
