import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import {
  consumeBatch,
  type ConsumeDeps,
} from "../../src/ingest/queue-consumer";
import type { IngestMessage } from "../../src/ingest/types";

// P6 item 4: end-to-end coverage for the queue consumer against the real
// migrated D1. Workers AI (embeddings), Vectorize (vector upsert), and live
// Graph are not simulatable under the test pool, so we inject the two seams
// the consumer exposes:
//   - indexChunks: a faithful stand-in that writes document_chunks rows the
//     same way the real embedder does, minus embed()/upsertVector().
//   - fetchBody: a stub that returns an inline body instead of calling Graph.
// Everything else — documents upsert, (source,resource_id) dedupe, chunk
// replacement, scope persistence (migration 0003), batch failure isolation —
// runs for real against D1.

const testEnv = env as unknown as Env;
const log = logger();

// Mirror the real indexChunks minus embed + Vectorize: write one
// document_chunks row per chunk so the assertions see real rows.
const fakeIndex: ConsumeDeps["indexChunks"] = async (e, input, _log) => {
  const out: { id: string; ordinal: number; embeddingId: string }[] = [];
  for (const c of input.chunks) {
    const id = crypto.randomUUID();
    const embeddingId = `doc:${id}`;
    await e.ARCADIA_DB.prepare(
      `INSERT INTO document_chunks
         (id, document_id, ordinal, text, embedding_id, sensitivity_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.documentId,
        c.ordinal,
        c.text,
        embeddingId,
        input.sensitivityLabel ?? null,
        new Date().toISOString(),
      )
      .run();
    out.push({ id, ordinal: c.ordinal, embeddingId });
  }
  return out;
};

interface TrackedMessage {
  acked: boolean;
  retried: boolean;
}

function makeBatch(bodies: IngestMessage[]): {
  batch: MessageBatch<IngestMessage>;
  tracked: TrackedMessage[];
} {
  const tracked: TrackedMessage[] = bodies.map(() => ({
    acked: false,
    retried: false,
  }));
  const messages = bodies.map((body, i) => ({
    id: `msg-${i}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => {
      tracked[i]!.acked = true;
    },
    retry: () => {
      tracked[i]!.retried = true;
    },
  }));
  const batch = {
    queue: "arcadia-ingest",
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<IngestMessage>;
  return { batch, tracked };
}

async function docRow(
  source: string,
  resourceId: string,
): Promise<
  | {
      id: string;
      scope_type: string | null;
      scope_id: string | null;
      title: string | null;
    }
  | null
> {
  return testEnv.ARCADIA_DB.prepare(
    `SELECT id, scope_type, scope_id, title FROM documents
      WHERE source = ? AND resource_id = ?`,
  )
    .bind(source, resourceId)
    .first();
}

async function chunkCount(documentId: string): Promise<number> {
  const r = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?`,
  )
    .bind(documentId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe("queue-consumer — inline body ingest", () => {
  it("indexes a teams_channel_message with an inline body and persists channel scope", async () => {
    const resourceId = "qc-teams-1";
    const body: IngestMessage = {
      source: "teams_channel_message",
      resourceId,
      title: "Standup notes",
      body: {
        content:
          "The migration finished overnight and all shards are healthy now. Ship the release once QA signs off tomorrow.",
        contentType: "text",
      },
    };
    const { batch, tracked } = makeBatch([body]);

    const result = await consumeBatch(batch, testEnv, log, {
      indexChunks: fakeIndex,
    });

    expect(result).toMatchObject({ considered: 1, indexed: 1, failed: 0 });
    expect(tracked[0]!.acked).toBe(true);

    const doc = await docRow("teams_channel_message", resourceId);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("Standup notes");
    // Migration 0003 scope columns: teams_channel_message → channel:<resourceId>.
    expect(doc!.scope_type).toBe("channel");
    expect(doc!.scope_id).toBe(resourceId);
    expect(await chunkCount(doc!.id)).toBeGreaterThanOrEqual(1);
  });
});

describe("queue-consumer — fetched body ingest (mail)", () => {
  it("fetches a mail body via the injected seam and persists user scope", async () => {
    const resourceId = "qc-mail-1";
    let fetchCalls = 0;
    const fetchBody: ConsumeDeps["fetchBody"] = async () => {
      fetchCalls += 1;
      return {
        content:
          "<html><body><p>Please review the attached quarterly numbers and flag anything unusual before the board call.</p></body></html>",
        contentType: "html",
      };
    };

    const body: IngestMessage = {
      source: "mail_message",
      resourceId,
      uri: "/users/owner-1/messages/qc-mail-1",
      ownerAadId: "owner-1",
      title: "Q3 numbers",
    };
    const { batch } = makeBatch([body]);

    const result = await consumeBatch(batch, testEnv, log, {
      indexChunks: fakeIndex,
      fetchBody,
    });

    expect(fetchCalls).toBe(1);
    expect(result).toMatchObject({ considered: 1, indexed: 1, failed: 0 });

    const doc = await docRow("mail_message", resourceId);
    expect(doc).not.toBeNull();
    // mail_message → user:<ownerAadId>.
    expect(doc!.scope_type).toBe("user");
    expect(doc!.scope_id).toBe("owner-1");
    expect(await chunkCount(doc!.id)).toBeGreaterThanOrEqual(1);
  });
});

describe("queue-consumer — re-ingest replaces chunks without dupes", () => {
  it("re-indexing the same (source,resource_id) reuses the document row and drops old chunks", async () => {
    const resourceId = "qc-reingest-1";
    const mk = (content: string): IngestMessage => ({
      source: "teams_channel_message",
      resourceId,
      body: { content, contentType: "text" },
    });

    await consumeBatch(makeBatch([mk("First body about the initial plan for the launch window.")]).batch, testEnv, log, { indexChunks: fakeIndex });

    const first = await docRow("teams_channel_message", resourceId);
    expect(first).not.toBeNull();
    const firstId = first!.id;
    const firstChunks = await chunkCount(firstId);
    expect(firstChunks).toBeGreaterThanOrEqual(1);

    await consumeBatch(makeBatch([mk("Second body: the plan changed and the launch slipped a week.")]).batch, testEnv, log, { indexChunks: fakeIndex });

    const second = await docRow("teams_channel_message", resourceId);
    // Same document row (upsert, not insert).
    expect(second!.id).toBe(firstId);
    // Old chunks dropped, only the re-index's chunks remain — no accumulation.
    expect(await chunkCount(firstId)).toBe(firstChunks);
  });
});

describe("queue-consumer — batch failure isolation", () => {
  it("one throwing message is retried while the rest of the batch is acked", async () => {
    const good1: IngestMessage = {
      source: "teams_channel_message",
      resourceId: "qc-iso-good-1",
      body: {
        content: "A perfectly good message body that should index cleanly here.",
        contentType: "text",
      },
    };
    const bad: IngestMessage = {
      source: "teams_channel_message",
      resourceId: "qc-iso-bad",
      body: {
        content: "This one blows up inside indexing and must not sink the batch.",
        contentType: "text",
      },
    };
    const good2: IngestMessage = {
      source: "teams_channel_message",
      resourceId: "qc-iso-good-2",
      body: {
        content: "Another good body that should index after the bad one fails.",
        contentType: "text",
      },
    };

    const throwingIndex: ConsumeDeps["indexChunks"] = async (e, input, l) => {
      // Fail only for the bad document; index the rest normally.
      const doc = await e.ARCADIA_DB.prepare(
        `SELECT resource_id FROM documents WHERE id = ?`,
      )
        .bind(input.documentId)
        .first<{ resource_id: string }>();
      if (doc?.resource_id === "qc-iso-bad") {
        throw new Error("boom: simulated embed failure");
      }
      return fakeIndex(e, input, l);
    };

    const { batch, tracked } = makeBatch([good1, bad, good2]);
    const result = await consumeBatch(batch, testEnv, log, {
      indexChunks: throwingIndex,
    });

    expect(result.considered).toBe(3);
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(1);
    expect(tracked[0]!.acked).toBe(true);
    expect(tracked[1]!.retried).toBe(true);
    expect(tracked[1]!.acked).toBe(false);
    expect(tracked[2]!.acked).toBe(true);

    // The two good docs indexed; the bad one wrote a documents row (upsert
    // happens before indexing) but no chunks.
    const badDoc = await docRow("teams_channel_message", "qc-iso-bad");
    expect(badDoc).not.toBeNull();
    expect(await chunkCount(badDoc!.id)).toBe(0);
    const goodDoc = await docRow("teams_channel_message", "qc-iso-good-2");
    expect(await chunkCount(goodDoc!.id)).toBeGreaterThanOrEqual(1);
  });
});
