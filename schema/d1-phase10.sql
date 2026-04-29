-- Phase 10: Client Intelligence, Image Generation & Model Routing

-- Clients (shared org-wide, not per-user)
CREATE TABLE IF NOT EXISTS clients (
  id            TEXT PRIMARY KEY,         -- crypto.randomUUID()
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT DEFAULT '#00b4d8',   -- UI accent color
  created_by    TEXT NOT NULL,            -- AAD user ID
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  index_status  TEXT DEFAULT 'pending',   -- pending|indexing|ready|error
  index_started_at  INTEGER,
  index_completed_at INTEGER,
  memory_summary    TEXT,                 -- AI-generated living summary of the client
  memory_version    INTEGER DEFAULT 0,
  UNIQUE(name)
);

-- M365 sources linked to a client
CREATE TABLE IF NOT EXISTS client_sources (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  source_type   TEXT NOT NULL,            -- team|channel|chat|sharepoint-site|planner-plan
  source_id     TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  team_id       TEXT,                     -- parent team_id if source_type=channel
  metadata      TEXT,                     -- JSON: additional context
  added_by      TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  UNIQUE(client_id, source_type, source_id)
);

-- Per-client memory store (separate from global memories table)
CREATE TABLE IF NOT EXISTS client_memories (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  category        TEXT NOT NULL,          -- episodic|semantic|procedural|observation
  content         TEXT NOT NULL,
  keywords        TEXT DEFAULT '',
  importance      REAL DEFAULT 0.5,
  source_ref      TEXT,                   -- source_id that generated this memory
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER                 -- NULL = permanent
);

-- Index run log
CREATE TABLE IF NOT EXISTS client_index_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT DEFAULT 'running', -- running|completed|failed
  messages_read   INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,
  summary         TEXT
);

-- Notifications for users (index complete, blockers detected)
CREATE TABLE IF NOT EXISTS client_notifications (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  user_id     TEXT,                       -- NULL = broadcast to all
  type        TEXT NOT NULL,              -- index_complete|blocker_detected|memory_updated
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Add client_id column to webapp_conversations for grouping
-- SQLite does not support IF NOT EXISTS on ADD COLUMN; this will fail if already added.
ALTER TABLE webapp_conversations ADD COLUMN client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_created_by ON clients(created_by);
CREATE INDEX IF NOT EXISTS idx_client_sources_client ON client_sources(client_id);
CREATE INDEX IF NOT EXISTS idx_client_memories_client ON client_memories(client_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_client_notifications_user ON client_notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webapp_conversations_client ON webapp_conversations(client_id);
