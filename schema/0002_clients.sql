-- 0002_clients.sql — Client object + asset bundle.
--
-- A "Client" is a first-class scope (alongside channel, chat, user,
-- project, customer). It groups the Microsoft 365 / Enque assets used
-- to serve one external partner — e.g. Morgan Stanley, Wells Fargo.
--
-- Membership in a Client is governed by the existing resource_acl
-- machinery: a row with resource_type='client' and resource_id=<client.id>
-- per principal (typically a 'group' principal pointing at the M365
-- group that backs the Teams team — that group's transitiveMembers
-- already define who belongs).
--
-- The active Client for a user is stored on `users.active_client_id`.
-- Only admins (users.is_admin = 1) may grant access; any user may
-- switch their own active Client to any Client they're entitled to.

CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','archived')),
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- One row per asset bundled into a Client. asset_id is the canonical
-- identifier in the upstream system: AAD group id for teams_team,
-- channel id for teams_channel, chat id for teams_chat, Planner plan
-- id, SharePoint site id, Loop workspace id, Enque team id.
CREATE TABLE IF NOT EXISTS client_assets (
  client_id    TEXT NOT NULL,
  asset_kind   TEXT NOT NULL CHECK (asset_kind IN (
                  'teams_team',
                  'teams_channel',
                  'teams_chat',
                  'planner_plan',
                  'sharepoint_site',
                  'loop_workspace',
                  'enque_team'
                )),
  asset_id     TEXT NOT NULL,
  label        TEXT,
  added_by     TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, asset_kind, asset_id),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_client_assets_kind ON client_assets(asset_kind, asset_id);

-- Per-user active client. NULL = no client selected; chat falls back
-- to the un-scoped behaviour. Validated at write time against the
-- user's entitlements (resource_acl).
ALTER TABLE users ADD COLUMN active_client_id TEXT;

INSERT OR IGNORE INTO _schema_migrations(filename) VALUES ('0002_clients.sql');
