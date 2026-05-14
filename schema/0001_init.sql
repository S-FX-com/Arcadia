-- Arcadia v2 — baseline schema.
--
-- Forward-only migration chain. Every CREATE uses IF NOT EXISTS so this
-- file is re-runnable. The _schema_migrations table at the bottom marks
-- which numbered files have been applied; scripts/migrate.ts skips ones
-- already recorded.
--
-- v1 phase schemas are not compatible with this baseline.

-- ===========================================================================
-- Identity + topology
-- ===========================================================================

CREATE TABLE IF NOT EXISTS channels (
  channel_id        TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  service_url       TEXT NOT NULL,
  conversation_id   TEXT,
  display_name      TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  registered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_team ON channels(team_id);

CREATE TABLE IF NOT EXISTS chats (
  chat_id           TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  service_url       TEXT NOT NULL,
  chat_type         TEXT NOT NULL CHECK (chat_type IN ('oneOnOne','group','meeting')),
  display_name      TEXT,
  registered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT
);

CREATE TABLE IF NOT EXISTS users (
  aad_id              TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  upn                 TEXT,
  display_name        TEXT,
  mail                TEXT,
  manager_aad_id      TEXT,
  is_admin            INTEGER NOT NULL DEFAULT 0,
  profile_json        TEXT,
  profile_updated_at  TEXT,
  last_seen_at        TEXT,
  registered_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS threads (
  thread_id         TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  topic             TEXT,
  owner_aad_id      TEXT,
  last_activity_at  TEXT NOT NULL,
  stale_at          TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_threads_owner   ON threads(owner_aad_id);
CREATE INDEX IF NOT EXISTS idx_threads_stale   ON threads(stale_at);

-- ===========================================================================
-- Memory (four layers in one table, distinguished by `kind`)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS memories (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('episodic','semantic','procedural','observation')),
  scope_type            TEXT NOT NULL CHECK (scope_type IN ('tenant','channel','chat','user','project','customer')),
  scope_id              TEXT NOT NULL,
  subject_aad_id        TEXT,
  content               TEXT NOT NULL,
  source_resource_type  TEXT,
  source_resource_id    TEXT,
  source_message_id     TEXT,
  embedding_id          TEXT,
  confidence            REAL NOT NULL DEFAULT 1.0,
  sensitivity_label     TEXT,
  occurred_at           TEXT,
  expires_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_scope   ON memories(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind    ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject_aad_id);
CREATE INDEX IF NOT EXISTS idx_memories_source  ON memories(source_resource_type, source_resource_id);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);

CREATE TABLE IF NOT EXISTS memory_edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_id, to_id, kind),
  FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to   ON memory_edges(to_id);

-- ===========================================================================
-- Tasks + decisions
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT,
  chat_id             TEXT,
  thread_id           TEXT,
  title               TEXT NOT NULL,
  description         TEXT,
  owner_aad_id        TEXT,
  created_by_aad_id   TEXT,
  deadline_at         TEXT,
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status              TEXT NOT NULL DEFAULT 'open'   CHECK (status   IN ('open','in_progress','blocked','done','cancelled')),
  planner_task_id     TEXT,
  last_nudge_at       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner    ON tasks(owner_aad_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_channel  ON tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);

-- Append-only — never UPDATEd, never DELETEd. Provides full audit trail.
CREATE TABLE IF NOT EXISTS ownership_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL,
  from_aad_id     TEXT,
  to_aad_id       TEXT NOT NULL,
  reason          TEXT,
  source          TEXT NOT NULL,
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ownership_task ON ownership_history(task_id);

CREATE TABLE IF NOT EXISTS decisions (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT,
  thread_id           TEXT,
  text                TEXT NOT NULL,
  decided_at          TEXT NOT NULL,
  decided_by_aad_id   TEXT,
  source_message_id   TEXT,
  confidence          REAL NOT NULL DEFAULT 1.0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_channel ON decisions(channel_id);
CREATE INDEX IF NOT EXISTS idx_decisions_thread  ON decisions(thread_id);

-- ===========================================================================
-- Intelligence outputs
-- ===========================================================================

CREATE TABLE IF NOT EXISTS digests (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  body        TEXT NOT NULL,
  message_id  TEXT,
  posted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_digests_channel ON digests(channel_id, posted_at);

CREATE TABLE IF NOT EXISTS briefs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('morning','evening','weekly','pre_meeting','post_meeting')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('channel','user','chat')),
  target_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  message_id  TEXT,
  posted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_briefs_target ON briefs(target_kind, target_id, posted_at);

-- ===========================================================================
-- Routines
-- ===========================================================================

CREATE TABLE IF NOT EXISTS routines (
  id             TEXT PRIMARY KEY,
  owner_aad_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  trigger_json   TEXT NOT NULL,
  steps_json     TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routines_owner ON routines(owner_aad_id);

CREATE TABLE IF NOT EXISTS routine_runs (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL,
  trigger_kind   TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
  output_json    TEXT,
  error          TEXT,
  FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at);

-- ===========================================================================
-- ACL (strict from day one)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS resource_acl (
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  principal_type  TEXT NOT NULL CHECK (principal_type IN ('user','group','tenant')),
  principal_id    TEXT NOT NULL,
  granted_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_acl_principal ON resource_acl(principal_type, principal_id);

CREATE TABLE IF NOT EXISTS group_membership (
  group_id       TEXT NOT NULL,
  member_aad_id  TEXT NOT NULL,
  refreshed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, member_aad_id)
);
CREATE INDEX IF NOT EXISTS idx_group_membership_member ON group_membership(member_aad_id);

-- ===========================================================================
-- Graph integration state
-- ===========================================================================

CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id                  TEXT PRIMARY KEY,
  resource            TEXT NOT NULL,
  change_type         TEXT NOT NULL,
  notification_url    TEXT NOT NULL,
  expiration_at       TEXT NOT NULL,
  client_state_hash   TEXT NOT NULL,
  encryption_cert_id  TEXT,
  last_renewed_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_subscriptions_expires ON graph_subscriptions(expiration_at);

CREATE TABLE IF NOT EXISTS delta_state (
  resource     TEXT NOT NULL,
  scope_key    TEXT NOT NULL,
  delta_token  TEXT NOT NULL,
  last_run_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource, scope_key)
);

-- ===========================================================================
-- Ingest (documents + chunks)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS documents (
  id                   TEXT PRIMARY KEY,
  source               TEXT NOT NULL,
  resource_id          TEXT NOT NULL,
  owner_aad_id         TEXT,
  title                TEXT,
  uri                  TEXT,
  mime_type            TEXT,
  etag                 TEXT,
  sensitivity_label    TEXT,
  last_modified_at     TEXT,
  indexed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_aad_id);

CREATE TABLE IF NOT EXISTS document_chunks (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  text               TEXT NOT NULL,
  embedding_id       TEXT,
  sensitivity_label  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id, ordinal);

-- ===========================================================================
-- Charter (operator-authored ground truth)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS charter (
  id           TEXT PRIMARY KEY,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0,
  replaces_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_charter_active ON charter(active);

-- ===========================================================================
-- Eval + feedback
-- ===========================================================================

CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  tags          TEXT,
  input_json    TEXT NOT NULL,
  expected_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  pass_rate    REAL,
  model        TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_aad_id   TEXT,
  surface       TEXT NOT NULL,
  target_kind   TEXT NOT NULL,
  target_id     TEXT,
  signal        TEXT NOT NULL CHECK (signal IN ('positive','negative','correction')),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback(target_kind, target_id);

-- ===========================================================================
-- Migration bookkeeping
-- ===========================================================================

CREATE TABLE IF NOT EXISTS _schema_migrations (
  filename     TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO _schema_migrations(filename) VALUES ('0001_init.sql');
