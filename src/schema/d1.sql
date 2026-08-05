-- Arcadia operational schema (D1) — v4
-- Re-runnable: CREATE ... IF NOT EXISTS / INSERT OR IGNORE only.
-- Apply with: wrangler d1 execute arcadia-ops --file=src/schema/d1.sql [--remote]
-- Timestamps are ISO 8601 TEXT (sortable, readable in the D1 console).

-- ---------------------------------------------------------------------------
-- Phase 1a — Hermes
-- ---------------------------------------------------------------------------

-- Topic queue Hermes draws from. A topic returns to 'queued' when a draft is
-- rejected; 'duplicate' means semantic dedupe against published_log killed it.
CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  keywords    TEXT NOT NULL DEFAULT '[]',   -- JSON array
  notes       TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','in_progress','awaiting_approval','published','rejected','duplicate','failed')),
  workflow_id TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status, priority DESC, created_at);

-- Every artifact Hermes ships, with full provenance: which doctrine entries
-- and which sources produced it. Rate ceiling queries count rows here.
CREATE TABLE IF NOT EXISTS published_log (
  id               TEXT PRIMARY KEY,
  topic_id         TEXT NOT NULL,
  workflow_id      TEXT NOT NULL,
  wp_post_id       INTEGER,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT,
  status           TEXT NOT NULL CHECK (status IN ('draft','published')),
  doctrine_entries TEXT NOT NULL DEFAULT '[]',  -- JSON array of memory ids recalled for the draft
  sources          TEXT NOT NULL DEFAULT '[]',  -- JSON array of research source URLs
  approved_by      TEXT,                        -- email from Cloudflare Access
  published_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_published_log_at ON published_log(published_at);
CREATE INDEX IF NOT EXISTS idx_published_log_topic ON published_log(topic_id);

-- Approval gate decisions, durable and attributed. One row per gate raised;
-- decided_by is the human who tapped, never Arcadia.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('hermes_publish','doctrine_ratify')),
  subject     TEXT NOT NULL,                 -- topic id / staging memory id
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

-- Append-only action audit (§8): every action, doctrine entry used, and
-- escalation. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS audit_log (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor            TEXT NOT NULL,            -- 'hermes' | 'arcadia' | 'radar' | 'ledger' | a human email
  action           TEXT NOT NULL,
  subject          TEXT,
  workflow_id      TEXT,
  doctrine_entries TEXT NOT NULL DEFAULT '[]',
  detail           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor, created_at);

-- Operational knobs enforced in D1, not just schedule frequency (§4 controls).
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
INSERT OR IGNORE INTO config (key, value) VALUES
  ('hermes_rate_ceiling_per_day',  '1'),
  ('hermes_rate_ceiling_per_week', '3'),
  -- Draft-first for 60 days: auto_publish stays 'off' until 60 clean days,
  -- and flipping it requires a human write with updated_by set.
  ('hermes_auto_publish',          'off'),
  ('hermes_draft_first_started_at', datetime('now'));

-- ---------------------------------------------------------------------------
-- Phase 1b — Stall Radar + Certification Ledger (tables ready, modules stubbed)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  client     TEXT,
  owner      TEXT,                            -- named human owner (email)
  lead       TEXT,                            -- their lead (email)
  pod        TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done')),
  sources    TEXT NOT NULL DEFAULT '{}',      -- JSON: sharepoint path, planner plan, channel id, repo, staging URL
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ground-truth stall signals and the escalation ladder state (day 3/5/7).
CREATE TABLE IF NOT EXISTS stall_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  signal        TEXT NOT NULL,                -- 'file_mtime' | 'planner' | 'channel_velocity' | 'git' | 'staging_diff'
  detected_at   TEXT NOT NULL DEFAULT (datetime('now')),
  days_stalled  INTEGER NOT NULL DEFAULT 0,
  owner         TEXT NOT NULL,
  lead          TEXT NOT NULL,
  escalation    TEXT NOT NULL DEFAULT 'none' CHECK (escalation IN ('none','dm_owner','pod_public','founder_digest')),
  resolved_at   TEXT,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_stall_events_open ON stall_events(project_id, resolved_at);

-- Signed pre-flight checklists. Signatures are immutable: rows are INSERT-only.
CREATE TABLE IF NOT EXISTS certifications (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),
  checklist    TEXT NOT NULL,                 -- 'web_build' | 'seo' | 'social' | 'it_ticket' | 'client_doc'
  stage        TEXT NOT NULL,
  signed_by    TEXT NOT NULL,
  signed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  items        TEXT NOT NULL                  -- JSON: [{item, signed: true}]
);

-- Arcadia's independent verification of the signable subset, and the
-- false-certification events that make the ledger real. Queryable per person.
CREATE TABLE IF NOT EXISTS certification_checks (
  id               TEXT PRIMARY KEY,
  certification_id TEXT NOT NULL REFERENCES certifications(id),
  item             TEXT NOT NULL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('pass','fail','partial','unverifiable')),
  evidence         TEXT,
  checked_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS false_certifications (
  id               TEXT PRIMARY KEY,
  certification_id TEXT NOT NULL REFERENCES certifications(id),
  item             TEXT NOT NULL,
  signed_by        TEXT NOT NULL,
  lead             TEXT NOT NULL,
  evidence         TEXT NOT NULL,             -- what the crawler / checker actually found
  surfaced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_false_cert_person ON false_certifications(signed_by, surfaced_at);
