-- 0005_actions.sql — the autonomy substrate (EXECUTION-PLAN §Phase 5, D5).
--
-- Arcadia's autonomy is a capability ladder, never a blank check. Every
-- action verb has a configured level per scope, and every attempt is
-- logged append-only.
--
--   Ladder levels (action_policy.level):
--     observe  — Arcadia may not perform the verb at all (default)
--     draft    — she may prepare the action but not send it; a draft is
--                surfaced for a human to send manually
--     confirm  — she may execute only after explicit human confirmation
--                (a Universal-Action confirmation card)
--     auto     — she may execute autonomously, within budget
--
-- The default for any (verb, scope) with no policy row is 'observe' —
-- fail-closed, matching the P2 ACL posture. Admins raise the level per
-- verb per scope.
--
-- action_log is append-only: one row per attempt, carrying the ladder
-- decision, params, and outcome. It is the audit trail SOUL.md promises
-- ("does not execute irreversible actions without confirmation").

CREATE TABLE IF NOT EXISTS action_policy (
  verb          TEXT NOT NULL,
  scope_type    TEXT NOT NULL,      -- 'tenant','channel','chat','user','client'
  scope_id      TEXT NOT NULL,      -- '*' = any scope of that type
  level         TEXT NOT NULL CHECK (level IN ('observe','draft','confirm','auto')),
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (verb, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS action_log (
  id            TEXT PRIMARY KEY,
  verb          TEXT NOT NULL,
  actor_aad_id  TEXT NOT NULL,      -- the human on whose behalf Arcadia acts
  on_behalf     TEXT,               -- app-only vs delegated marker
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  level         TEXT NOT NULL,      -- ladder level applied at decision time
  params_json   TEXT NOT NULL,
  status        TEXT NOT NULL
                  CHECK (status IN ('proposed','drafted','awaiting_confirmation',
                                    'confirmed','executed','failed','rejected','blocked')),
  result_json   TEXT,
  idempotency_key TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_log_verb   ON action_log(verb, created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_actor  ON action_log(actor_aad_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_status ON action_log(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_log_idem
  ON action_log(idempotency_key) WHERE idempotency_key IS NOT NULL;

INSERT OR IGNORE INTO _schema_migrations(filename) VALUES ('0005_actions.sql');
