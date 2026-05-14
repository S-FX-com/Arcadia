// Cloudflare Queues consumer for the ingest pipeline.
//
// Producers (under src/ingest/producers/) walk delta_state per resource
// and enqueue change envelopes. This consumer drains the queue, parses
// the source content, chunks it, embeds it, and writes documents +
// document_chunks rows with sensitivity-label-aware ACL tagging.
//
// Real implementation lands in the Ingest commit. Today the consumer
// acks every message so the queue does not back up while we build.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function handleIngestBatch(
  batch: MessageBatch<unknown>,
  _env: Env,
  _ctx: ExecutionContext,
  log: Logger,
): Promise<void> {
  log.warn("ingest_consumer_unimplemented", { size: batch.messages.length });
  for (const m of batch.messages) {
    m.ack();
  }
}
