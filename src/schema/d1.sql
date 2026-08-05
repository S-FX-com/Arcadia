-- Arcadia operational schema (D1) — v4
-- Re-runnable: CREATE ... IF NOT EXISTS / INSERT OR IGNORE only.
-- Apply with: wrangler d1 execute arcadia-ops --file=src/schema/d1.sql [--remote]
-- Timestamps are ISO 8601 TEXT (sortable, readable in the D1 console).

-- ---------------------------------------------------------------------------
-- Identity, roles, and admin configuration
-- ---------------------------------------------------------------------------

-- Staff directory. Access authenticates; this table authorizes. A person with
-- no row here gets the specialist baseline (see src/lib/rbac.ts).
CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'specialist'
               CHECK (role IN ('superadmin','founder','lead','specialist')),
  lead_email   TEXT,
  pod          TEXT,
  skills       TEXT NOT NULL DEFAULT '[]',   -- JSON array, used by Phase 3 dispatch
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_lead ON users(lead_email);

-- Capabilities granted beyond a person's role.
CREATE TABLE IF NOT EXISTS user_capabilities (
  email      TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, capability)
);

-- Superadmins. These two are the only ones by default; role changes are
-- audited and require the admin_users capability.
INSERT OR IGNORE INTO users (email, display_name, role) VALUES
  ('shane@s-fx.com', 'Shane Skwarek', 'superadmin'),
  ('alex@s-fx.com',  'Alex',          'superadmin');

-- Per-task model routing. Rows override the built-in Workers AI defaults in
-- src/ai/types.ts; absent rows use the default.
CREATE TABLE IF NOT EXISTS model_config (
  task       TEXT PRIMARY KEY,
  provider   TEXT NOT NULL CHECK (provider IN ('workers-ai','anthropic')),
  model      TEXT NOT NULL,
  max_tokens INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
-- Phase 2 — doctrine gaps (capture channel D, §5.5)
-- ---------------------------------------------------------------------------

-- Questions Arcadia could not answer from doctrine. Shane's answer becomes
-- permanent doctrine, so every gap closes once, forever. times_asked ranks
-- which gaps cost the most to leave open.
CREATE TABLE IF NOT EXISTS doctrine_gaps (
  id                TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  asked_by          TEXT NOT NULL,
  times_asked       INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','declined')),
  answered_by       TEXT,
  answered_at       TEXT,
  staging_memory_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gaps_open ON doctrine_gaps(status, times_asked DESC);

-- ---------------------------------------------------------------------------
-- Phase 1b — Stall Radar + Certification Ledger
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

-- Last reading per project per signal. Fingerprints power diff-based signals
-- (staging HTML hash); available=0 records a visibility gap, which must never
-- be read as a stall.
CREATE TABLE IF NOT EXISTS project_signals (
  project_id       TEXT NOT NULL,
  signal           TEXT NOT NULL,
  fingerprint      TEXT,
  last_activity_at TEXT,
  available        INTEGER NOT NULL DEFAULT 0,
  detail           TEXT,
  read_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, signal)
);

-- The public accountability board. Pod-level and founder escalations land
-- here durably — publicness is the mechanism, so it cannot depend on email.
CREATE TABLE IF NOT EXISTS board_posts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  owner      TEXT,
  lead       TEXT,
  pod        TEXT,
  project_id TEXT,
  public     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_board_public ON board_posts(public, created_at);

-- Delivery log for the email leg. Board posts are durable; email is best effort.
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  recipients    TEXT NOT NULL,
  subject       TEXT NOT NULL,
  delivered     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  board_post_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Signed pre-flight checklists. Signatures are immutable: rows are INSERT-only
-- and never UPDATEd. Verification results live in certification_checks so the
-- signature and the independent check stay separable.
CREATE TABLE IF NOT EXISTS certifications (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),
  checklist    TEXT NOT NULL,                 -- key from src/certification/checklists.ts
  stage        TEXT NOT NULL,
  signed_by    TEXT NOT NULL,
  signed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  target_url   TEXT,
  items        TEXT NOT NULL                  -- JSON: [{item, label, signed: true}]
);
CREATE INDEX IF NOT EXISTS idx_certifications_signer ON certifications(signed_by, signed_at);
CREATE INDEX IF NOT EXISTS idx_certifications_stage ON certifications(project_id, stage);

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
