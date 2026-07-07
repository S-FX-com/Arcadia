-- 0004_learning.sql — the learning loop (EXECUTION-PLAN §Phase 4).
--
-- Three additions close the feedback→behaviour loop that SOUL.md
-- describes but the code never implemented:
--
--   1. Procedural memories gain usage/outcome counters so the
--      promote/retire thresholds (PROCEDURE_* config) have something to
--      act on. `promoted` procedures ride in the always-injected prompt
--      context; low-value ones retire.
--   2. improvement_proposals is the review queue: eval failures and
--      feedback signals generate PROPOSED charter amendments / memory
--      corrections. The operator ratifies — Arcadia proposes, never
--      silently self-edits (SOUL.md + D5).
--   3. procedure_events is an append-only log of procedure use +
--      outcome, so promotion is evidence-based and auditable.

ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
-- 0 = normal, 1 = promoted (injected into prompts), -1 = retired.
ALTER TABLE memories ADD COLUMN promoted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS procedure_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('used','success','failure')),
  source        TEXT,               -- surface that produced the signal
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_procedure_events_mem ON procedure_events(memory_id, created_at);

CREATE TABLE IF NOT EXISTS improvement_proposals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('charter_amendment','memory_correction','procedure','routine')),
  origin        TEXT NOT NULL,      -- 'eval','feedback','consolidation','curiosity'
  title         TEXT NOT NULL,
  rationale     TEXT,
  payload_json  TEXT NOT NULL,      -- the proposed change, shape depends on kind
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','applied')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  resolved_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON improvement_proposals(status, created_at);

INSERT OR IGNORE INTO _schema_migrations(filename) VALUES ('0004_learning.sql');
