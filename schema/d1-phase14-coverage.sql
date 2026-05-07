-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 14 — Coverage: delta state, documents, ingest tombstones
--
-- Adds three things needed by the broader-coverage ingest pipeline:
--   1. delta_state — per-(user, resource) cursor for Graph delta queries
--                    (mail/drive/sites). Hourly cron walks this table and
--                    enqueues changes into the arcadia-ingest queue.
--   2. documents   — chunked, parsed text from M365 artifacts. Each row
--                    has a soft-delete column so a delta `@removed` event
--                    flips deleted_at without dropping the data.
--   3. document_chunks — split content (~800 tokens, 100 overlap) joined
--                    1:1 with Vectorize entries. Indexed by document_id
--                    so a deleted document cleanly cascades its chunks.
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-user delta cursors. The composite PK keeps it idempotent across
-- restarts; the delta_link is opaque from Graph's POV.
CREATE TABLE IF NOT EXISTS delta_state (
  user_aad_id   TEXT    NOT NULL,
  resource      TEXT    NOT NULL,         -- e.g. 'mail:inbox', 'drive:root', 'site:{siteId}:list:{listId}'
  delta_link    TEXT    NOT NULL,         -- @odata.deltaLink from the most recent successful pass
  last_run_at   INTEGER NOT NULL,         -- Unix seconds
  last_status   TEXT    NOT NULL DEFAULT 'ok',  -- 'ok' | 'error'
  last_error    TEXT,
  PRIMARY KEY (user_aad_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_delta_state_run
  ON delta_state(last_run_at);

-- A parsed M365 artifact (PDF page, .docx body, OneNote page, mail body, etc.).
-- One document row per ingested artifact. Chunks live in document_chunks.
CREATE TABLE IF NOT EXISTS documents (
  id                   TEXT    PRIMARY KEY,    -- UUID
  source_resource_type TEXT    NOT NULL,
  source_resource_id   TEXT    NOT NULL,
  title                TEXT,
  uri                  TEXT,                   -- web URL for citations
  mime_type            TEXT,
  size_bytes           INTEGER,
  content_sha256       TEXT,                   -- so re-ingests can dedupe
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,                -- soft-delete via Graph @removed
  sensitivity_label    TEXT                    -- MIP label name when present
);

CREATE INDEX IF NOT EXISTS idx_documents_resource
  ON documents(source_resource_type, source_resource_id);

CREATE INDEX IF NOT EXISTS idx_documents_alive
  ON documents(deleted_at) WHERE deleted_at IS NULL;

-- One row per chunk. Vectorize stores the embedding under chunk.id.
CREATE TABLE IF NOT EXISTS document_chunks (
  id                   TEXT    PRIMARY KEY,    -- UUID; matches Vectorize id
  document_id          TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal              INTEGER NOT NULL,       -- 0-based chunk index
  content              TEXT    NOT NULL,
  token_estimate       INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  embedding_status     TEXT    NOT NULL DEFAULT 'pending'  -- 'pending' | 'indexed' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc
  ON document_chunks(document_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
  ON document_chunks(embedding_status) WHERE embedding_status = 'pending';
