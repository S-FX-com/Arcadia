-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 6 Schema Migration
-- MemPalace Memory Architecture: Knowledge Graph, Memory Links, Palace Hierarchy
--
-- Run:
--   wrangler d1 execute arcadia-db --file=schema/d1-phase6.sql          (local)
--   wrangler d1 execute arcadia-db --remote --file=schema/d1-phase6.sql  (remote)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Knowledge graph with temporal validity ──────────────────────────────────
-- Adapted from MemPalace's SQLite knowledge graph.
-- Stores entity-relationship triples with time windows.
-- Examples:
--   ("shane", "manages", "gnc-renewal", confidence=0.9, valid_from=April)
--   ("mike", "works-on", "auth-migration", confidence=0.8)
CREATE TABLE IF NOT EXISTS knowledge_graph (
  id            TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  subject_id    TEXT    NOT NULL,           -- Normalized entity ID (lowercase, no spaces)
  subject_name  TEXT    NOT NULL,           -- Display name
  subject_type  TEXT    NOT NULL,           -- person|project|customer|team|channel|concept
  predicate     TEXT    NOT NULL,           -- Relationship: works-on, manages, member-of, etc.
  object_id     TEXT    NOT NULL,           -- Normalized entity ID
  object_name   TEXT    NOT NULL,           -- Display name
  object_type   TEXT    NOT NULL,           -- person|project|customer|team|channel|concept
  confidence    REAL    NOT NULL DEFAULT 0.5, -- 0.0–1.0
  source        TEXT,                       -- research|conversation|graph-api|admin
  valid_from    INTEGER,                    -- Unix timestamp (NULL = always true)
  valid_to      INTEGER,                    -- Unix timestamp (NULL = still valid)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kg_subject
  ON knowledge_graph(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_kg_object
  ON knowledge_graph(object_id, predicate);
CREATE INDEX IF NOT EXISTS idx_kg_predicate
  ON knowledge_graph(predicate);
CREATE INDEX IF NOT EXISTS idx_kg_temporal
  ON knowledge_graph(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_kg_type
  ON knowledge_graph(subject_type, object_type);

-- ─── Memory links (tunnels / cross-references) ──────────────────────────────
-- Connects related memories across different wings/rooms.
-- Adapted from MemPalace's tunnel concept: rooms appearing in multiple wings
-- create semantic bridges between knowledge domains.
CREATE TABLE IF NOT EXISTS memory_links (
  id            TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  memory_a_id   TEXT    NOT NULL,           -- Foreign key to memories.id
  memory_b_id   TEXT    NOT NULL,           -- Foreign key to memories.id
  link_type     TEXT    NOT NULL,           -- related|supersedes|contradicts|elaborates
  strength      REAL    NOT NULL DEFAULT 0.5, -- 0.0–1.0 (from embedding similarity)
  created_at    INTEGER NOT NULL,
  UNIQUE(memory_a_id, memory_b_id)
);

CREATE INDEX IF NOT EXISTS idx_links_a
  ON memory_links(memory_a_id);
CREATE INDEX IF NOT EXISTS idx_links_b
  ON memory_links(memory_b_id);

-- ─── Extend memories table: palace hierarchy + embedding tracking ────────────
-- wing: domain categorization (general, team, channel:{id}, person:{id}, etc.)
-- room: topic within the wing (standup, billing, auth-migration, etc.)
-- embedding_status: tracks Vectorize indexing for incremental backfill
ALTER TABLE memories ADD COLUMN wing TEXT DEFAULT 'general';
ALTER TABLE memories ADD COLUMN room TEXT;
ALTER TABLE memories ADD COLUMN embedding_status TEXT DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_memories_wing_room
  ON memories(wing, room, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories(embedding_status) WHERE embedding_status = 'pending';
