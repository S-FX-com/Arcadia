-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 15 — Routines (user-defined automations)
--
-- A "routine" is a saved automation: one trigger + an ordered list of
-- steps. Triggers are dispatched in code from a single dynamic-cron
-- router (the platform's static cron list stays unchanged) plus
-- chat-intent matches and incoming Graph events. Steps are tools from
-- the Phase 2 registry plus side-effecting "action" tools registered
-- here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routines (
  id            TEXT    PRIMARY KEY,
  owner_aad_id  TEXT    NOT NULL,             -- AAD object id of the routine's owner
  name          TEXT    NOT NULL,
  description   TEXT,
  trigger_json  TEXT    NOT NULL,             -- JSON: { kind: 'cron' | 'graph_event' | 'chat_intent', ... }
  steps_json    TEXT    NOT NULL,             -- JSON array of { tool, args } pairs (steps execute serially)
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_run_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_routines_owner   ON routines(owner_aad_id);
CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines(enabled, last_run_at);

CREATE TABLE IF NOT EXISTS routine_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id      TEXT    NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT    NOT NULL,           -- 'running' | 'success' | 'failed'
  steps_completed INTEGER NOT NULL DEFAULT 0,
  log_json        TEXT                        -- JSON array of per-step results
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at DESC);
