-- 0003_registry.sql — org registry (sites, drives) + document ACL scope
-- + ingest observability.
--
-- P1 of EXECUTION-PLAN.md. The v2 producers discovered drives/sites by
-- json_extract over documents.uri, which never matched — these tables
-- make sites and drives first-class registry rows populated by Graph
-- enumeration (src/graph/registry.ts), the same way channels/chats/users
-- are registered.
--
-- documents gains scope_type/scope_id so document recall can be
-- ACL-filtered through resource_acl exactly like memories (the scope
-- previously rode only in Vectorize metadata).
--
-- ingest_runs gives every producer/consumer cycle an auditable row so
-- the /sources page can answer "is Arcadia seeing everything, and how
-- fresh is it?".

CREATE TABLE IF NOT EXISTS sites (
  site_id           TEXT PRIMARY KEY,   -- Graph composite id (host,site,web)
  tenant_id         TEXT NOT NULL,
  display_name      TEXT,
  web_url           TEXT,
  last_synced_at    TEXT,
  registered_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drives (
  drive_id          TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  owner_type        TEXT NOT NULL CHECK (owner_type IN ('user','site','group')),
  owner_id          TEXT,
  display_name      TEXT,
  drive_type        TEXT,               -- personal | business | documentLibrary
  last_synced_at    TEXT,
  registered_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drives_owner ON drives(owner_type, owner_id);

ALTER TABLE documents ADD COLUMN scope_type TEXT;
ALTER TABLE documents ADD COLUMN scope_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,          -- producer name, 'consumer', or 'registry'
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  enqueued      INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  detail_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON ingest_runs(source, started_at);

INSERT OR IGNORE INTO _schema_migrations(filename) VALUES ('0003_registry.sql');
