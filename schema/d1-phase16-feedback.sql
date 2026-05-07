-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 16 — User feedback + eval results
--
-- chat_feedback: thumbs-up/down captured from the webapp chat UI per
--   message. Joined with conversation_messages in the eval pipeline
--   to build per-prompt regression baselines.
--
-- eval_runs: one row per nightly eval pass. Each pass scores the agent's
--   response against the frozen ground-truth answers under evals/cases/
--   using a Workers AI judge prompt.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_aad_id     TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  rating          TEXT    NOT NULL CHECK(rating IN ('up', 'down')),
  comment         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_feedback_message ON chat_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_user    ON chat_feedback(user_aad_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  cases_total  INTEGER NOT NULL DEFAULT 0,
  cases_passed INTEGER NOT NULL DEFAULT 0,
  judge_model  TEXT,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS eval_case_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_name       TEXT    NOT NULL,
  prompt          TEXT    NOT NULL,
  expected        TEXT    NOT NULL,
  actual          TEXT    NOT NULL,
  judge_score     REAL,                         -- 0.0 - 1.0
  judge_rationale TEXT,
  passed          INTEGER NOT NULL DEFAULT 0,   -- 1 / 0
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_case_results_run  ON eval_case_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_case_results_case ON eval_case_results(case_name, created_at DESC);
