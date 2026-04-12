-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 7: Webapp SSO Chat
-- D1 schema migration for webapp sessions, conversations, and messages.
-- ─────────────────────────────────────────────────────────────────────────────

-- Webapp sessions — tracks authenticated users with encrypted Graph tokens
CREATE TABLE IF NOT EXISTS webapp_sessions (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  email           TEXT,
  access_token    TEXT    NOT NULL,     -- AES-GCM encrypted
  refresh_token   TEXT,                 -- AES-GCM encrypted
  token_expiry    INTEGER NOT NULL,     -- Unix timestamp
  scopes          TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  last_active     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webapp_sessions_user   ON webapp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_webapp_sessions_expiry ON webapp_sessions(token_expiry);

-- Webapp conversations — per-user chat conversation list
CREATE TABLE IF NOT EXISTS webapp_conversations (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL,
  title           TEXT    NOT NULL DEFAULT 'New conversation',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webapp_conv_user ON webapp_conversations(user_id, updated_at DESC);

-- Webapp messages — individual messages within conversations
CREATE TABLE IF NOT EXISTS webapp_messages (
  id              TEXT    PRIMARY KEY,
  conversation_id TEXT    NOT NULL,
  role            TEXT    NOT NULL,     -- user | assistant
  content         TEXT    NOT NULL,
  context_refs    TEXT,                 -- JSON: array of { type, id, title }
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webapp_msg_conv ON webapp_messages(conversation_id, created_at ASC);
