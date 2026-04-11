-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 3 Schema Migration
-- User profiles, customer profiles, channel snapshots
--
-- Run: wrangler d1 execute arcadia-db --remote --file=schema/d1-phase3.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- User behaviour profiles (one row per unique Teams user)
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id        TEXT    PRIMARY KEY,  -- Teams aadObjectId (or from.id fallback)
  display_name   TEXT    NOT NULL,
  team_id        TEXT,                 -- most recently seen team
  message_count  INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,     -- Unix timestamp
  last_seen      INTEGER NOT NULL,     -- Unix timestamp
  insights       TEXT,                 -- JSON: ProfileInsights (recursive structure)
  insight_version INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL      -- Unix timestamp
);

-- Customer / external organisation profiles
CREATE TABLE IF NOT EXISTS customer_profiles (
  id             TEXT    PRIMARY KEY,  -- normalized slug, e.g. "gnc" or "acme-corp"
  name           TEXT    NOT NULL,
  mention_count  INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  context        TEXT,                 -- JSON: { contacts, topics, sentiment, recentContext }
  updated_at     INTEGER NOT NULL
);

-- Daily channel activity snapshots — used for exec summaries and pattern analysis
CREATE TABLE IF NOT EXISTS channel_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        TEXT    NOT NULL,
  channel_id     TEXT    NOT NULL,
  channel_name   TEXT    NOT NULL,
  date           TEXT    NOT NULL,     -- YYYY-MM-DD
  snapshot       TEXT    NOT NULL,     -- JSON: { messageCount, participants, topics, decisions, openItems }
  created_at     INTEGER NOT NULL,
  UNIQUE(team_id, channel_id, date)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_team
  ON user_profiles(team_id, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_mentions
  ON customer_profiles(mention_count DESC);

CREATE INDEX IF NOT EXISTS idx_channel_snapshots_team_date
  ON channel_snapshots(team_id, date DESC);
