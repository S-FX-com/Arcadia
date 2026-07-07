import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, type VectorSearchFn } from "../../src/memory/store";
import type { VectorHit } from "../../src/memory/vector";

// Unified recall (P1 item 6 / D3): MemoryStore.recall must federate memory
// hits AND document-chunk hits through one ACL gate. Vectorize + Workers AI
// are not simulatable under miniflare, so we inject a stub VectorSearchFn that
// returns pre-canned matches; everything downstream (D1 hydration + ACL) runs
// against the real migrated D1 binding.

// A store whose vector search returns a fixed match list (ignores text/filter).
function storeReturning(hits: VectorHit[]): MemoryStore {
  const search: VectorSearchFn = async () => hits;
  return new MemoryStore(env, search);
}

async function seedDocument(opts: {
  docId: string;
  chunkId: string;
  source: string;
  resourceId: string;
  text: string;
  title?: string | null;
  ownerAadId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  sensitivity?: string | null;
}): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO documents
       (id, source, resource_id, owner_aad_id, title, sensitivity_label,
        indexed_at, scope_type, scope_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.docId,
      opts.source,
      opts.resourceId,
      opts.ownerAadId ?? null,
      opts.title ?? null,
      opts.sensitivity ?? null,
      new Date().toISOString(),
      opts.scopeType ?? null,
      opts.scopeId ?? null,
    )
    .run();

  await env.ARCADIA_DB.prepare(
    `INSERT INTO document_chunks
       (id, document_id, ordinal, text, embedding_id, sensitivity_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.chunkId,
      opts.docId,
      0,
      opts.text,
      `doc:${opts.chunkId}`,
      opts.sensitivity ?? null,
      new Date().toISOString(),
    )
    .run();
}

function docHit(chunkId: string, score: number, metadata = {}): VectorHit {
  return { id: `doc:${chunkId}`, score, metadata };
}

beforeAll(async () => {
  // A memory row for the interleave test.
  await env.ARCADIA_DB.prepare(
    `INSERT INTO memories (id, kind, scope_type, scope_id, content, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind("mem-interleave-1", "semantic", "channel", "chan-mix", "a memory fact", 1.0)
    .run();
});

describe("unified recall — document hydration", () => {
  it("returns a document hit with title-prefixed content and mapped scope", async () => {
    await seedDocument({
      docId: "doc-basic",
      chunkId: "chunk-basic",
      source: "drive_item",
      resourceId: "res-basic",
      text: "quarterly revenue was up",
      title: "Q3 Report",
      ownerAadId: "owner-basic",
      scopeType: "channel",
      scopeId: "chan-basic",
    });

    const store = storeReturning([docHit("chunk-basic", 0.9)]);
    const hits = await store.recall("revenue"); // no viewer → admin/unfiltered

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.memory.kind).toBe("document");
    expect(hit.memory.content).toBe("«Q3 Report» quarterly revenue was up");
    expect(hit.memory.scopeType).toBe("channel");
    expect(hit.memory.scopeId).toBe("chan-basic");
    expect(hit.memory.subjectAadId).toBe("owner-basic");
    expect(hit.memory.sourceResourceType).toBe("document");
    expect(hit.memory.sourceResourceId).toBe("doc-basic");
  });

  it("falls back to vector-metadata scope when documents.scope_* is NULL", async () => {
    await seedDocument({
      docId: "doc-legacy-meta",
      chunkId: "chunk-legacy-meta",
      source: "drive_item",
      resourceId: "res-legacy-meta",
      text: "legacy chunk with metadata scope",
      ownerAadId: "owner-legacy",
      scopeType: null,
      scopeId: null,
    });

    const store = storeReturning([
      docHit("chunk-legacy-meta", 0.8, {
        scope_type: "channel",
        scope_id: "chan-from-meta",
      }),
    ]);
    const hits = await store.recall("legacy");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.scopeType).toBe("channel");
    expect(hits[0]!.memory.scopeId).toBe("chan-from-meta");
  });
});

describe("unified recall — ACL gate over documents", () => {
  it("empty-ACL doc scope is tenant-open by default (current behavior)", async () => {
    await seedDocument({
      docId: "doc-open",
      chunkId: "chunk-open",
      source: "drive_item",
      resourceId: "res-open",
      text: "open document",
      ownerAadId: "someone-else",
      scopeType: "channel",
      scopeId: "chan-open-noacl",
    });

    const store = storeReturning([docHit("chunk-open", 0.9)]);
    const hits = await store.recall("open", {
      viewer: "viewer-open",
      tenantId: "tenant-1",
    });
    // NOTE: P2 flips this default to deny-with-admin-exception; this assertion
    // documents the current tenant-open behavior so that flip has a test to
    // change.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.scopeId).toBe("chan-open-noacl");
  });

  it("group-granted doc: filtered out for non-member, returned for member", async () => {
    await seedDocument({
      docId: "doc-grp",
      chunkId: "chunk-grp",
      source: "drive_item",
      resourceId: "res-grp",
      text: "group-restricted document",
      ownerAadId: "some-owner",
      scopeType: "channel",
      scopeId: "chan-grp",
    });
    await env.ARCADIA_DB.prepare(
      `INSERT INTO resource_acl
         (resource_type, resource_id, principal_type, principal_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind("channel", "chan-grp", "group", "group-X")
      .run();
    await env.ARCADIA_DB.prepare(
      `INSERT INTO group_membership (group_id, member_aad_id) VALUES (?, ?)`,
    )
      .bind("group-X", "member-user")
      .run();

    const store = storeReturning([docHit("chunk-grp", 0.9)]);

    const nonMember = await store.recall("group", {
      viewer: "outsider-user",
      tenantId: "tenant-1",
    });
    expect(nonMember).toHaveLength(0);

    const member = await store.recall("group", {
      viewer: "member-user",
      tenantId: "tenant-1",
    });
    expect(member).toHaveLength(1);
    expect(member[0]!.memory.scopeId).toBe("chan-grp");
  });
});

describe("unified recall — kind filter + fail-closed + interleave", () => {
  it("kind filter excluding 'document' returns no document hits", async () => {
    await seedDocument({
      docId: "doc-kind",
      chunkId: "chunk-kind",
      source: "drive_item",
      resourceId: "res-kind",
      text: "should be excluded by kind filter",
      scopeType: "channel",
      scopeId: "chan-kind",
    });

    const store = storeReturning([docHit("chunk-kind", 0.9)]);
    const excluded = await store.recall("x", { kind: ["semantic", "episodic"] });
    expect(excluded).toHaveLength(0);

    const included = await store.recall("x", {
      kind: ["semantic", "document"],
    });
    expect(included).toHaveLength(1);
    expect(included[0]!.memory.kind).toBe("document");
  });

  it("legacy doc with NULL scope and no metadata scope is dropped (fail closed)", async () => {
    await seedDocument({
      docId: "doc-unscoped",
      chunkId: "chunk-unscoped",
      source: "manual",
      resourceId: "res-unscoped",
      text: "no scope anywhere and no owner",
      ownerAadId: null,
      scopeType: null,
      scopeId: null,
    });

    const store = storeReturning([docHit("chunk-unscoped", 0.9)]);
    const hits = await store.recall("unscoped", {
      viewer: "viewer-x",
      tenantId: "tenant-1",
    });
    expect(hits).toHaveLength(0);
  });

  it("interleaves mem: and doc: hits by score", async () => {
    await seedDocument({
      docId: "doc-mix-hi",
      chunkId: "chunk-mix-hi",
      source: "drive_item",
      resourceId: "res-mix-hi",
      text: "high-score doc",
      scopeType: "channel",
      scopeId: "chan-mix",
    });
    await seedDocument({
      docId: "doc-mix-lo",
      chunkId: "chunk-mix-lo",
      source: "drive_item",
      resourceId: "res-mix-lo",
      text: "low-score doc",
      scopeType: "channel",
      scopeId: "chan-mix",
    });

    const store = storeReturning([
      docHit("chunk-mix-hi", 0.95),
      { id: "mem:mem-interleave-1", score: 0.9 },
      docHit("chunk-mix-lo", 0.5),
    ]);
    const hits = await store.recall("mix"); // no viewer → no ACL

    expect(hits.map((h) => h.memory.kind)).toEqual([
      "document",
      "semantic",
      "document",
    ]);
    expect(hits.map((h) => h.score)).toEqual([0.95, 0.9, 0.5]);
  });
});
