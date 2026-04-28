-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 9: Per-User Intelligence
--
-- Adds proactive DM delivery columns to linked_users, and three new tables for
-- user-configurable report configs, their source selections, and a delivery log.
--
-- Run: wrangler d1 execute arcadia-db --remote --file=schema/d1-phase9.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Extend linked_users with DM conversation reference so the cron can deliver
-- reports to the user's Teams DM via Bot Framework proactive messaging.
ALTER TABLE linked_users ADD COLUMN conversation_id TEXT;
ALTER TABLE linked_users ADD COLUMN service_url TEXT;

-- ─── Per-user report configurations ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_report_configs (
  id            TEXT    PRIMARY KEY,         -- UUID
  user_id       TEXT    NOT NULL,            -- AAD Object ID
  config_name   TEXT    NOT NULL,
  report_type   TEXT    NOT NULL,            -- 'daily' | 'weekly'
  schedule_hour INTEGER NOT NULL DEFAULT 8,  -- UTC hour to deliver (0–23)
  schedule_day  INTEGER,                     -- Day of week for weekly: 0=Sun…6=Sat; NULL defaults to Monday (1)
  active        INTEGER NOT NULL DEFAULT 1,  -- 1 = enabled, 0 = disabled
  created_at    INTEGER NOT NULL,            -- Unix timestamp
  updated_at    INTEGER NOT NULL             -- Unix timestamp
);

CREATE INDEX IF NOT EXISTS idx_user_report_configs_user_id
  ON user_report_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_report_configs_active_hour
  ON user_report_configs(active, schedule_hour);

-- ─── Report sources ───────────────────────────────────────────────────────────
--
-- Each row represents one Teams/Channel/Chat to include in a report.
-- source_id encoding:
--   source_type = 'team'    → bare team ID
--   source_type = 'channel' → '{teamId}:{channelId}'
--   source_type = 'chat'    → bare chat ID

CREATE TABLE IF NOT EXISTS report_sources (
  id          TEXT    PRIMARY KEY,  -- UUID
  user_id     TEXT    NOT NULL,     -- AAD Object ID (denormalised for fast per-user queries)
  config_id   TEXT    NOT NULL,     -- FK → user_report_configs.id
  source_type TEXT    NOT NULL,     -- 'team' | 'channel' | 'chat'
  source_id   TEXT    NOT NULL,     -- encoded per convention above
  source_name TEXT    NOT NULL,     -- display name at time of creation
  label       TEXT,                 -- user-defined label, e.g. "GNC Project"
  created_at  INTEGER NOT NULL      -- Unix timestamp
);

CREATE INDEX IF NOT EXISTS idx_report_sources_config_id
  ON report_sources(config_id);
CREATE INDEX IF NOT EXISTS idx_report_sources_user_id
  ON report_sources(user_id);

-- ─── Report delivery log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS report_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT    NOT NULL,
  config_id       TEXT    NOT NULL,
  generated_at    INTEGER,                           -- Unix timestamp
  delivered_at    INTEGER,                           -- Unix timestamp; NULL until sent
  status          TEXT    NOT NULL DEFAULT 'pending', -- 'pending'|'generated'|'delivered'|'failed'
  content_preview TEXT                               -- first 500 chars of the report
);

CREATE INDEX IF NOT EXISTS idx_report_log_user_id
  ON report_log(user_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_log_config_id
  ON report_log(config_id);
