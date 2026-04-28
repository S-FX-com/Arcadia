-- Phase 11: Hermes-Inspired Self-Learning Loop
-- Procedures, scoring, evolution log, and active user intelligence.

-- Procedures: learned approaches to recurring task types
-- Equivalent to Hermes' skills/, but stored in D1 with scoring
CREATE TABLE IF NOT EXISTS procedures (
  id              TEXT PRIMARY KEY,         -- crypto.randomUUID()
  name            TEXT NOT NULL,            -- short identifier e.g. "cmta-exec-summary"
  description     TEXT NOT NULL,            -- when to apply this procedure
  trigger_pattern TEXT NOT NULL,            -- keyword/intent pattern that activates this
  content         TEXT NOT NULL,            -- the actual instruction injected into system prompt
  scope           TEXT NOT NULL DEFAULT 'global', -- global|client:{id}|user:{id}
  source_type     TEXT NOT NULL,            -- 'extracted'|'manual'|'evolved'
  source_session  TEXT,                     -- conversation_id that generated this
  version         INTEGER NOT NULL DEFAULT 1,
  uses            INTEGER NOT NULL DEFAULT 0,
  positive_signals INTEGER NOT NULL DEFAULT 0,  -- thumbs up, "thanks", task completion
  negative_signals INTEGER NOT NULL DEFAULT 0,  -- follow-up correction, "that's wrong"
  score           REAL NOT NULL DEFAULT 0.5,    -- 0.0-1.0 computed score
  status          TEXT NOT NULL DEFAULT 'candidate', -- candidate|active|retired
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

-- Procedure versions: full history of content changes
CREATE TABLE IF NOT EXISTS procedure_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_id    TEXT NOT NULL,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  score_at_time   REAL,
  evolved_by      TEXT,                     -- 'cron'|'manual'|'feedback'
  created_at      INTEGER NOT NULL
);

-- Interaction scores: raw signal from each conversation turn
CREATE TABLE IF NOT EXISTS interaction_scores (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,            -- assistant message that was scored
  user_id         TEXT NOT NULL,
  client_id       TEXT,
  procedures_used TEXT NOT NULL DEFAULT '[]', -- JSON array of procedure IDs injected
  signal_type     TEXT NOT NULL,            -- 'positive'|'negative'|'neutral'|'correction'
  signal_source   TEXT NOT NULL,            -- 'explicit'|'implicit'|'correction_detected'
  context         TEXT,                     -- brief note on what triggered scoring
  created_at      INTEGER NOT NULL
);

-- Evolution log: when procedures were promoted/retired/evolved
CREATE TABLE IF NOT EXISTS procedure_evolution_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_id    TEXT NOT NULL,
  action          TEXT NOT NULL,            -- 'promoted'|'retired'|'evolved'|'created'|'merged'
  from_status     TEXT,
  to_status       TEXT,
  from_score      REAL,
  to_score        REAL,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);

-- User intelligence: actively maintained profile (replaces passive ProfileInsights)
CREATE TABLE IF NOT EXISTS user_intelligence (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  -- Communication
  preferred_response_length TEXT DEFAULT 'medium', -- brief|medium|detailed
  preferred_format  TEXT DEFAULT 'markdown',        -- markdown|plain|structured
  communication_style TEXT,                         -- e.g. "direct, prefers bullets"
  -- Working patterns
  peak_hours      TEXT,                             -- e.g. "9am-12pm ET"
  timezone        TEXT DEFAULT 'America/New_York',
  -- Domain knowledge
  expertise_areas TEXT NOT NULL DEFAULT '[]',       -- JSON array
  recurring_clients TEXT NOT NULL DEFAULT '[]',     -- JSON array of client IDs
  -- Preferences learned from corrections
  correction_patterns TEXT NOT NULL DEFAULT '[]',   -- JSON: things the user has corrected
  -- Interaction stats
  total_interactions INTEGER NOT NULL DEFAULT 0,
  positive_rate   REAL NOT NULL DEFAULT 0.5,
  last_updated    INTEGER NOT NULL,
  intelligence_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_procedures_scope ON procedures(scope, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_procedures_trigger ON procedures(trigger_pattern, status);
CREATE INDEX IF NOT EXISTS idx_interaction_scores_conv ON interaction_scores(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_scores_procedure ON interaction_scores(procedures_used, signal_type);
CREATE INDEX IF NOT EXISTS idx_evolution_log_procedure ON procedure_evolution_log(procedure_id, created_at DESC);
