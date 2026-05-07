-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 13 — Per-User ACL Index
--
-- Lays the data model for permission-preserving memory recall. After this
-- migration, every memory and client_memory row CAN carry a (resource_type,
-- resource_id) pointer back to its source M365 artifact. The new
-- `resource_acl` table records which AAD principals (users + groups) are
-- allowed to see each artifact, and `group_membership` mirrors transitive
-- group membership refreshed from Microsoft Graph on a 6h cron.
--
-- This migration is purely additive: existing memories with NULL source
-- resource fields keep working under the "permissive" enforcement mode.
-- The recall path is wired up in a follow-up commit, gated by an
-- ACL_ENFORCEMENT feature flag.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── resource_acl ────────────────────────────────────────────────────────────
-- One row per (resource, principal). Bulk-populated by the indexer when it
-- ingests an artifact: it asks Graph for the artifact's permissions and
-- writes one row per direct user grant + one row per group grant. Group
-- expansion happens at query time via group_membership, NOT here, so a
-- group's membership change doesn't require rewriting every ACL row.
CREATE TABLE IF NOT EXISTS resource_acl (
  resource_type    TEXT    NOT NULL,    -- 'teams_message' | 'teams_channel' | 'teams_chat'
                                        -- | 'sharepoint_item' | 'onedrive_item'
                                        -- | 'mail_message' | 'calendar_event'
                                        -- | 'planner_task' | 'onenote_page'
  resource_id      TEXT    NOT NULL,
  principal_aad_id TEXT    NOT NULL,    -- AAD object id of user OR group
  principal_kind   TEXT    NOT NULL CHECK(principal_kind IN ('user', 'group')),
  granted_at       INTEGER NOT NULL,    -- Unix seconds
  PRIMARY KEY (resource_type, resource_id, principal_aad_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_acl_principal
  ON resource_acl(principal_aad_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_resource_acl_resource
  ON resource_acl(resource_type, resource_id);

-- ─── group_membership ────────────────────────────────────────────────────────
-- Transitive (recursive) group membership snapshot. Populated by a 6h cron
-- that walks /groups/{id}/transitiveMembers for every group referenced in
-- resource_acl. Expanding membership at query time (in JS) keeps writes
-- cheap and the source of truth in Graph.
CREATE TABLE IF NOT EXISTS group_membership (
  group_aad_id TEXT    NOT NULL,        -- AAD object id of the group
  user_aad_id  TEXT    NOT NULL,        -- AAD object id of the user
  refreshed_at INTEGER NOT NULL,        -- Unix seconds (last successful refresh)
  PRIMARY KEY (group_aad_id, user_aad_id)
);

CREATE INDEX IF NOT EXISTS idx_group_membership_user
  ON group_membership(user_aad_id);

-- ─── memories — source-resource pointers ─────────────────────────────────────
-- Both columns are nullable for backwards compatibility with rows created
-- before this migration. Phase 1 follow-up wiring will populate them on
-- every new memory; legacy rows remain visible under permissive enforcement.
ALTER TABLE memories ADD COLUMN source_resource_type TEXT;
ALTER TABLE memories ADD COLUMN source_resource_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_resource
  ON memories(source_resource_type, source_resource_id);

-- ─── client_memories — source-resource pointers ──────────────────────────────
ALTER TABLE client_memories ADD COLUMN source_resource_type TEXT;
ALTER TABLE client_memories ADD COLUMN source_resource_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_client_memories_resource
  ON client_memories(source_resource_type, source_resource_id);
