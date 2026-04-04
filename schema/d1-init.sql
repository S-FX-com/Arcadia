-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — D1 Database Schema
--
-- Apply with:
--   wrangler d1 execute arcadia-db --file=schema/d1-init.sql          (local)
--   wrangler d1 execute arcadia-db --remote --file=schema/d1-init.sql  (remote)
-- ─────────────────────────────────────────────────────────────────────────────

-- Thread tracking
-- Stores last-known activity for each thread in registered channels.
-- Used by stale thread detection.
CREATE TABLE IF NOT EXISTS threads (
  id           TEXT    NOT NULL PRIMARY KEY,  -- Teams message ID (root of thread)
  team_id      TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  last_activity INTEGER NOT NULL,             -- Unix timestamp of last reply
  owner        TEXT,                          -- Display name of identified owner (nullable)
  status       TEXT    NOT NULL DEFAULT 'active'  -- 'active' | 'stale' | 'resolved'
);

CREATE INDEX IF NOT EXISTS idx_threads_channel
  ON threads (team_id, channel_id, status, last_activity);

-- Channel registry
-- Channels where Arcadia has been installed and should receive daily digests.
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT    NOT NULL PRIMARY KEY,  -- "{team_id}:{channel_id}"
  team_id       TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  channel_name  TEXT    NOT NULL,
  registered_at INTEGER NOT NULL,              -- Unix timestamp of bot install
  service_url   TEXT,                          -- Bot Framework service URL for proactive messaging
  conversation_id TEXT                         -- Teams conversation ID for proactive messaging
);

CREATE INDEX IF NOT EXISTS idx_channels_team
  ON channels (team_id);

-- Digest log
-- Historical record of all posted daily digests.
CREATE TABLE IF NOT EXISTS digest_log (
  id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  team_id      TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  posted_at    INTEGER NOT NULL,   -- Unix timestamp
  content      TEXT    NOT NULL    -- Full digest text
);

CREATE INDEX IF NOT EXISTS idx_digest_channel
  ON digest_log (team_id, channel_id, posted_at DESC);
