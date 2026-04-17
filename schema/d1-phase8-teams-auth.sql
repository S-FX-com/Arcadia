-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia — Phase 8: Teams DM auth gating
--
-- Persistent link between a Teams/AAD identity and a Webapp authentication.
-- A row is created when a user signs into the Arcadia webapp. The bot checks
-- this table before allowing any 1:1 DM interaction — users must authenticate
-- the webapp first so Arcadia has explicit permission to build a personal
-- persona and read their individual context. Group chats / channels are not
-- gated (operate on shared conversation context, not individual personas).
--
-- Run: wrangler d1 execute arcadia-db --remote --file=schema/d1-phase8-teams-auth.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS linked_users (
  aad_object_id  TEXT    PRIMARY KEY,   -- AAD Object ID (matches activity.from.aadObjectId)
  display_name   TEXT    NOT NULL,
  email          TEXT,
  linked_at      INTEGER NOT NULL,      -- Unix timestamp of first webapp auth
  last_auth_at   INTEGER NOT NULL       -- Unix timestamp of most recent webapp auth
);

CREATE INDEX IF NOT EXISTS idx_linked_users_last_auth
  ON linked_users(last_auth_at DESC);
