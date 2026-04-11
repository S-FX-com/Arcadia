-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 5: Autoresearch — M365 Tenant Intelligence
-- ─────────────────────────────────────────────────────────────────────────────

-- Research cycle log — the results.tsv analog from Karpathy's Autoresearch.
-- Each row is one completed (or failed) autonomous research cycle.
CREATE TABLE IF NOT EXISTS research_cycles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT    NOT NULL DEFAULT 'running',   -- running | completed | failed
  channels_scanned INTEGER NOT NULL DEFAULT 0,
  chats_scanned   INTEGER NOT NULL DEFAULT 0,
  users_scanned   INTEGER NOT NULL DEFAULT 0,
  memories_created INTEGER NOT NULL DEFAULT 0,
  bridges_detected INTEGER NOT NULL DEFAULT 0,
  questions_generated INTEGER NOT NULL DEFAULT 0,
  knowledge_score_delta REAL DEFAULT 0,
  summary         TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_cycles_status
  ON research_cycles(status, started_at DESC);

-- Pending research questions for Shane Skwarek.
-- Questions are generated when Arcadia encounters ambiguity or gaps.
CREATE TABLE IF NOT EXISTS research_questions (
  id              TEXT    PRIMARY KEY,
  question        TEXT    NOT NULL,
  context         TEXT,
  importance      REAL    NOT NULL DEFAULT 0.5,
  source          TEXT    NOT NULL,                     -- bridge | gap | analysis
  related_bridge_id TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',   -- pending | asked | answered | expired
  answer          TEXT,
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_research_questions_status
  ON research_questions(status, importance DESC, created_at ASC);

-- Channel↔Chat conversation bridges.
-- Tracks when a topic discussed in a channel continues in a private chat.
CREATE TABLE IF NOT EXISTS conversation_bridges (
  id                  TEXT    PRIMARY KEY,
  channel_id          TEXT    NOT NULL,
  channel_name        TEXT,
  chat_id             TEXT    NOT NULL,
  chat_topic          TEXT,
  shared_participants TEXT,                              -- JSON array of user display names
  shared_topics       TEXT,                              -- JSON array of topic keywords
  temporal_correlation REAL,                             -- 0.0–1.0
  overall_score       REAL,                              -- 0.0–1.0
  details             TEXT,
  discovered_at       INTEGER NOT NULL,
  last_validated_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conversation_bridges_score
  ON conversation_bridges(overall_score DESC);

-- Knowledge coverage tracking.
-- Tracks entities (people, projects, customers) and how well Arcadia understands them.
CREATE TABLE IF NOT EXISTS knowledge_entities (
  id                TEXT    PRIMARY KEY,
  entity_type       TEXT    NOT NULL,                    -- person | project | customer | team | process
  entity_name       TEXT    NOT NULL,
  confidence        REAL    NOT NULL DEFAULT 0,          -- 0.0–1.0
  last_researched_at INTEGER,
  gap_type          TEXT,                                -- unknown-owner | unknown-status | fragmented-context | stale-info
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_entities_type
  ON knowledge_entities(entity_type, confidence ASC);
