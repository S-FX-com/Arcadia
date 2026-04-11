-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 4 Schema Migration
-- Long-term memory store and consolidation dream log
--
-- Run:
--   wrangler d1 execute arcadia-db --file=schema/d1-phase4.sql          (local)
--   wrangler d1 execute arcadia-db --remote --file=schema/d1-phase4.sql  (remote)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Long-term memory store ──────────────────────────────────────────────────
-- Four memory categories mirror how humans convert experience into knowledge:
--   episodic    — specific events: "Shane asked about GNC on April 5"
--   semantic    — distilled facts: "GNC is a key customer, contact is Jane"
--   procedural  — process knowledge: "standup runs at 9am, Shane leads it"
--   observation — behavioural patterns: "Mike goes quiet when overloaded"
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  category          TEXT    NOT NULL,           -- episodic|semantic|procedural|observation
  content           TEXT    NOT NULL,           -- Natural language memory content
  keywords          TEXT    NOT NULL DEFAULT '', -- Comma-separated lowercase keywords for recall
  importance        REAL    NOT NULL DEFAULT 0.5, -- 0.0–1.0 importance score
  source_channel_id TEXT,                       -- Channel where memory originated (null = global)
  source_user_id    TEXT,                       -- User who triggered the memory (null = system)
  created_at        INTEGER NOT NULL,           -- Unix timestamp
  last_recalled_at  INTEGER,                    -- Unix timestamp of last recall (null = never)
  recall_count      INTEGER NOT NULL DEFAULT 0, -- Times this memory was recalled
  consolidated_at   INTEGER,                    -- Unix timestamp of last consolidation touch
  expires_at        INTEGER                     -- Unix timestamp (null = permanent)
);

CREATE INDEX IF NOT EXISTS idx_memories_category
  ON memories(category, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source_channel
  ON memories(source_channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source_user
  ON memories(source_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_expires
  ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_created
  ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_recall
  ON memories(recall_count DESC, importance DESC);

-- ─── Memory consolidation dream log ──────────────────────────────────────────
-- Tracks each consolidation cycle run.
-- Three phases mirror sleep cycles:
--   light  — twice daily (morning/evening): episodic → semantic summarisation
--   deep   — daily: cross-reference patterns, prune, promote
--   rem    — weekly: behavioural trends, self-model update
CREATE TABLE IF NOT EXISTS memory_dreams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  phase              TEXT    NOT NULL,          -- light|deep|rem
  started_at         INTEGER NOT NULL,          -- Unix timestamp
  completed_at       INTEGER,                   -- Unix timestamp (null if still running / errored)
  summary            TEXT,                      -- Plain text summary of what was accomplished
  memories_processed INTEGER NOT NULL DEFAULT 0,
  memories_created   INTEGER NOT NULL DEFAULT 0,
  memories_pruned    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dreams_phase
  ON memory_dreams(phase, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dreams_started
  ON memory_dreams(started_at DESC);
