-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — D1 Phase 2 Migration
--
-- Additive: Phase 1 tables (threads, channels, digest_log) are unchanged.
--
-- Apply with:
--   wrangler d1 execute arcadia-db --file=schema/d1-phase2.sql          (local)
--   wrangler d1 execute arcadia-db --remote --file=schema/d1-phase2.sql  (remote)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Task tracking ────────────────────────────────────────────────────────────
-- One row per detected or explicitly assigned task.
-- Status lifecycle: open → in_progress → blocked → done
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT    NOT NULL PRIMARY KEY,        -- crypto.randomUUID() at insert
  team_id       TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  thread_id     TEXT    NOT NULL,                   -- Root message ID (FK to threads.id)
  description   TEXT    NOT NULL,
  owner_id      TEXT,                               -- AAD user ID of assignee (nullable)
  owner_name    TEXT,                               -- Display name at time of assignment
  assigned_by   TEXT,                               -- "system" | display name of assigner
  assigned_at   INTEGER,                            -- Unix timestamp of assignment
  deadline      INTEGER,                            -- Unix timestamp (nullable)
  priority      TEXT    NOT NULL DEFAULT 'normal',  -- 'low' | 'normal' | 'high'
  status        TEXT    NOT NULL DEFAULT 'open',    -- 'open' | 'in_progress' | 'blocked' | 'done'
  detected_at   INTEGER NOT NULL,                   -- Unix timestamp of first detection
  source_msg_id TEXT    NOT NULL,                   -- Source message ID that triggered detection
  last_nudge_at INTEGER,                            -- Unix timestamp of last nudge posted
  nudge_count   INTEGER NOT NULL DEFAULT 0          -- Total nudges sent
);

CREATE INDEX IF NOT EXISTS idx_tasks_channel
  ON tasks (team_id, channel_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner
  ON tasks (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline
  ON tasks (deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_thread
  ON tasks (thread_id);

-- ─── Ownership history ────────────────────────────────────────────────────────
-- Immutable audit log — every ownership change appended, never updated.
-- Current owner is always read from tasks.owner_id (not this table).
CREATE TABLE IF NOT EXISTS ownership_history (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT    NOT NULL,                -- FK to tasks.id
  owner_id    TEXT,                            -- AAD user ID (nullable for "unassigned" events)
  owner_name  TEXT,
  assigned_by TEXT    NOT NULL,               -- "system" | display name of assigner
  reason      TEXT    NOT NULL,               -- 'ai-detected' | 'explicit-command' | 'reassigned' | 'unassigned'
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ownership_task
  ON ownership_history (task_id, occurred_at DESC);

-- ─── Graph change notification subscriptions ─────────────────────────────────
-- Tracks active Microsoft Graph subscriptions for Teams channel messages.
-- Teams subscriptions expire after 60 minutes max — must be renewed.
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id                  TEXT    NOT NULL PRIMARY KEY, -- Graph subscription ID (from API response)
  team_id             TEXT    NOT NULL,
  channel_id          TEXT    NOT NULL,
  resource            TEXT    NOT NULL,             -- Graph resource path subscribed to
  expiration_datetime INTEGER NOT NULL,             -- Unix timestamp of expiry
  client_state        TEXT    NOT NULL,             -- Per-subscription UUID used to validate notifications
  created_at          INTEGER NOT NULL,
  renewed_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
  ON graph_subscriptions (expiration_datetime);
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel
  ON graph_subscriptions (team_id, channel_id);

-- ─── Weekly report archive ────────────────────────────────────────────────────
-- Historical record of all posted weekly reports.
CREATE TABLE IF NOT EXISTS weekly_report_log (
  id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  week_start TEXT    NOT NULL,   -- YYYY-MM-DD of the Monday that started the week
  posted_at  INTEGER NOT NULL,   -- Unix timestamp
  content    TEXT    NOT NULL    -- Full report text
);

CREATE INDEX IF NOT EXISTS idx_weekly_channel
  ON weekly_report_log (team_id, channel_id, posted_at DESC);
