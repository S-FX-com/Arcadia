-- Arcadia operational schema (D1) — v5
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

-- Approval gate decisions, durable and attributed. One row per gate raised;
-- decided_by is the human who tapped, never Arcadia.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('doctrine_ratify','site_plan')),
  subject     TEXT NOT NULL,                 -- staging memory id / site plan id
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
  actor            TEXT NOT NULL,            -- 'arcadia' | 'radar' | 'ledger' | a human email
  action           TEXT NOT NULL,
  subject          TEXT,
  workflow_id      TEXT,
  doctrine_entries TEXT NOT NULL DEFAULT '[]',
  detail           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor, created_at);

-- Operational knobs enforced in D1 rather than in code (§4 controls). Model
-- routing overrides (src/ai/router.ts) and anything else an admin can change
-- without a deploy live here.
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

-- ---------------------------------------------------------------------------
-- Phase 4 — site planning
-- ---------------------------------------------------------------------------

-- One row per plan. The deliverable itself is an HTML artifact in R2; Melina
-- and Diego approve before anything reaches a client (§4 Phase 4, §8).
CREATE TABLE IF NOT EXISTS site_plans (
  id            TEXT PRIMARY KEY,          -- the workflow id
  root_url      TEXT NOT NULL,
  client        TEXT,
  requested_by  TEXT NOT NULL,
  artifact_key  TEXT NOT NULL,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  findings      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'awaiting_approval'
                CHECK (status IN ('awaiting_approval','approved','rejected')),
  approved_by   TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Ask Arcadia conversations, one row per turn. Multi-turn because doctrine
-- questions arrive as follow-ups ("and deferred payment?") that mean nothing
-- read alone. Scoped to the person who asked, like every person-level record
-- (§5.7). seq is the turn order: datetime('now') is second-resolution, so a
-- question and its answer can tie on created_at.
--
-- Clearing a conversation is a display action only. Every answer is already
-- recorded in audit_log with the doctrine entries that produced it (§5.6.6),
-- and that log is append-only — the attribution does not go away with the
-- transcript.
CREATE TABLE IF NOT EXISTS chat_messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,                   -- whose conversation
  role       TEXT NOT NULL CHECK (role IN ('user','arcadia')),
  content    TEXT NOT NULL,
  citations  TEXT NOT NULL DEFAULT '[]',      -- JSON array of doctrine memory ids
  escalated  INTEGER NOT NULL DEFAULT 0,      -- answer was a gap escalation, not an answer
  gap_id     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_email ON chat_messages(email, seq);

-- Bulk seed runs (capture channel C, §5.5). A run pushes documents through the
-- §5.3 pipeline into sfx-doctrine-staging. It never reaches canonical on its
-- own: doctrine never auto-commits (§5.6.1), so a human still ratifies every
-- entry from the doctrine surface.
CREATE TABLE IF NOT EXISTS seed_runs (
  id           TEXT PRIMARY KEY,               -- workflow id
  requested_by TEXT NOT NULL,
  -- 'paste' — parts staged by the request (typed into the form, or uploaded
  -- as files); 'r2' — the workflow staged them itself from a bucket prefix.
  -- Do not add a value here without rebuilding the table: SQLite cannot widen
  -- a CHECK in place, so an existing database would reject the new one.
  source       TEXT NOT NULL CHECK (source IN ('paste','r2')),
  documents    TEXT NOT NULL DEFAULT '[]',     -- JSON array of document names
  parts_total  INTEGER NOT NULL DEFAULT 0,
  parts_done   INTEGER NOT NULL DEFAULT 0,
  written      INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  conflicts    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_seed_runs_at ON seed_runs(created_at DESC);

-- Contradiction halts (§5.6.2): a seeded candidate whose topic key already has
-- a head entry in staging is never silently dropped. Both versions land here
-- for a human to choose between. Counting them is not enough — an unsurfaced
-- conflict is a lost piece of doctrine.
CREATE TABLE IF NOT EXISTS seed_conflicts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  topic_key     TEXT NOT NULL,
  existing_id   TEXT NOT NULL,
  existing_text TEXT NOT NULL,
  incoming_text TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seed_conflicts_open ON seed_conflicts(status, created_at);

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

-- ---------------------------------------------------------------------------
-- Gatekeepers (Cloudflare OS integration) — src/gatekeepers/
-- ---------------------------------------------------------------------------

-- Every read a gatekeeper session performs, logged before data returns to the
-- caller (Cloudflare OS observation semantics). Append-only.
CREATE TABLE IF NOT EXISTS gk_observations (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  gatekeeper TEXT NOT NULL,               -- 'site-crawl' | 'graph' | 'project-context' | 'os-bridge'
  resource   TEXT NOT NULL,               -- the single scoped resource, e.g. 'wp:www.s-fx.com:tutorials'
  session_id TEXT NOT NULL,               -- workflow / sweep / OS session id
  actor      TEXT NOT NULL,               -- agent name or human email the session acts for
  title      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gk_obs_at ON gk_observations(created_at);
CREATE INDEX IF NOT EXISTS idx_gk_obs_session ON gk_observations(session_id);

-- Every side effect a gatekeeper session submits. Applied only after a
-- decision with recorded authorization; 'pending' rows are blocked actions —
-- the enforcement working, not noise.
CREATE TABLE IF NOT EXISTS gk_actions (
  id              TEXT PRIMARY KEY,       -- '<session_id>#<action key>' (retry-safe)
  gatekeeper      TEXT NOT NULL,
  resource        TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  actor           TEXT NOT NULL,
  action_kind     TEXT NOT NULL,          -- stable tag, e.g. 'wp.publish_post'
  title           TEXT NOT NULL,
  detail          TEXT,
  auto_approvable INTEGER NOT NULL DEFAULT 0,  -- safe to apply with no human tap (never client-visible)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','applied','rejected','failed')),
  auth_evidence   TEXT,                   -- JSON ActionAuthorization that authorized the apply
  decided_by      TEXT,                   -- named human, when a human decided
  result          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at      TEXT,
  applied_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_gk_actions_status ON gk_actions(status, created_at);

-- ---------------------------------------------------------------------------
-- Phase 3 — dispatch + escalation enforcement
-- ---------------------------------------------------------------------------

-- Work items flowing through the review chain. `stage` is enforced against
-- src/dispatch/stages.ts — stages cannot be skipped.
CREATE TABLE IF NOT EXISTS work_items (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  project_id       TEXT REFERENCES projects(id),
  priority         INTEGER NOT NULL DEFAULT 0,
  required_skills  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  assigned_to      TEXT,
  status           TEXT NOT NULL DEFAULT 'ready'
                   CHECK (status IN ('ready','offered','in_progress','done','blocked')),
  stage            TEXT NOT NULL DEFAULT 'development',
  stage_entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  sla_escalated    INTEGER NOT NULL DEFAULT 0,
  offered_at       TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_ready ON work_items(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_work_assignee ON work_items(assigned_to, status);

-- Every stage handoff, with how long the stage actually held the work. This
-- is the raw material for pass-through detection.
CREATE TABLE IF NOT EXISTS stage_transitions (
  id           TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  from_stage   TEXT NOT NULL,
  to_stage     TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  held_seconds INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transitions_reviewer ON stage_transitions(reviewer, from_stage);

-- A gate that forwards instead of filters: approved too fast, or approved
-- work that later failed downstream.
CREATE TABLE IF NOT EXISTS pass_through_flags (
  id           TEXT PRIMARY KEY,
  stage        TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('fast_approval','downstream_failure')),
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_passthrough_reviewer ON pass_through_flags(reviewer, stage);

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

-- ---------------------------------------------------------------------------
-- v5.0 — client workspaces (§8)
-- ---------------------------------------------------------------------------

-- The workspace. A client IS whatever an admin binds to it (§8 binding
-- policy): typed bindings, attributed, no auto-detection. `projects` keeps
-- its free-text client label for now; linking projects to a client row is
-- v5.2 (stall correlation) work.
CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','offboarded')),
  owner             TEXT,                     -- named human owner (email)
  created_by        TEXT NOT NULL,            -- admin who created the workspace
  members_synced_at TEXT,                     -- last successful Graph membership sync
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Typed source bindings. Binding is the access-granting act — a team binding
-- decides whose membership unlocks the workspace — so every row carries the
-- admin who added it. external_id formats per type are documented in
-- src/clients/bindings.ts (channel: 'teamId/channelId'; sharepoint_folder:
-- 'driveId:/path'; repo: 'owner/name').
CREATE TABLE IF NOT EXISTS client_bindings (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  type        TEXT NOT NULL CHECK (type IN
              ('team','channel','planner_plan','sharepoint_folder','enque_org','repo','staging_url')),
  external_id TEXT NOT NULL,
  label       TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_unique ON client_bindings(client_id, type, external_id);
CREATE INDEX IF NOT EXISTS idx_bindings_client ON client_bindings(client_id);

-- Graph-derived membership cache (§8): access = capability × membership.
-- Rows are replaced wholesale on each sync; the 15-minute staleness ceiling
-- is enforced in src/clients/members.ts, which fails closed when the cache
-- cannot be refreshed past it.
CREATE TABLE IF NOT EXISTS client_members (
  client_id      TEXT NOT NULL REFERENCES clients(id),
  email          TEXT NOT NULL,               -- lowercased; joins to the SSO identity
  aad_id         TEXT,
  display_name   TEXT,
  source_team_id TEXT NOT NULL,               -- which bound Team granted this membership
  synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, email, source_team_id)
);
CREATE INDEX IF NOT EXISTS idx_client_members_email ON client_members(email);

-- v5 posture (§1, §4.3): accountability instruments are dormant behind
-- per-instrument flags, default OFF — an absent row is dormant too, so a
-- fresh database wakes nothing. Flipping one on is the §4.3 protocol
-- (announced first, counters from zero), not a casual toggle.
INSERT OR IGNORE INTO config (key, value) VALUES
  ('instrument.escalation_ladder',    'off'),
  ('instrument.certification_ledger', 'off'),
  ('instrument.dispatch_enforcement', 'off');

-- ---------------------------------------------------------------------------
-- Agency — Schedule (Teams Shifts). One department-wide schedule, not a
-- per-client or per-project scope: which M365 Team hosts it lives in
-- `config` ('schedule.team_id'), set once by a superadmin, same mechanism as
-- model routing overrides.
-- ---------------------------------------------------------------------------

-- Time-off requests Arcadia filed on a specialist's behalf (Graph:
-- POST .../schedule/timeOffRequests, senderUserId — no delegated user token
-- needed to file). Filing is not a live commitment: nothing changes for
-- anyone until a human approves it natively in Shifts. Arcadia never calls
-- Graph's approve/decline herself (CLAUDE.md §8: she flags and logs, she
-- does not decide, and the v1.0 approve/decline endpoint's own application-
-- permission support is under a documented, unresolved deprecation) — status
-- here is read back from Graph on sync, never written by an approval action.
CREATE TABLE IF NOT EXISTS time_off_requests (
  id                TEXT PRIMARY KEY,
  graph_request_id  TEXT,                        -- Graph's timeOffRequest id, once filed
  requested_by      TEXT NOT NULL,                -- email, lowercased
  reason            TEXT,
  start_date        TEXT NOT NULL,                -- YYYY-MM-DD
  end_date          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  filed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at    TEXT,
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_time_off_person ON time_off_requests(requested_by, start_date);
CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off_requests(status);

-- Best-effort Availability display. shiftPreferences/shiftAvailability is a
-- Graph BETA resource with no v1.0 equivalent — Microsoft's own docs mark it
-- unsupported for production use, and writing it is documented as
-- unsupported for an application-only caller at all (would need a delegated,
-- signed-in-user token this Worker does not request). This cache is read-only
-- decoration: a pre-rendered summary string, not a relational model of a beta
-- shape that can change under us. Populated on demand (self, or an
-- admin-triggered bulk sync), never by a background sweep in this stage.
CREATE TABLE IF NOT EXISTS schedule_availability_cache (
  email        TEXT PRIMARY KEY,
  display_name TEXT,
  summary      TEXT NOT NULL,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- M365 repository (27 September 2026). Arcadia keeps what Microsoft does not
-- store well, and a cache of the directory read. No Entra write. The
-- Certification Ledger tables above are not this chronicle.
-- ---------------------------------------------------------------------------

-- Active member users from Graph. Refreshed by the directory sync. Guests
-- and disabled accounts are not inserted. Overlay and social rows survive
-- a refresh; they are not Graph fields.
CREATE TABLE IF NOT EXISTS directory_profiles (
  aad_id              TEXT PRIMARY KEY,
  mail                TEXT,
  display_name        TEXT,
  job_title           TEXT,
  department          TEXT,
  office_location     TEXT,
  mobile_phone        TEXT,
  business_phones     TEXT NOT NULL DEFAULT '[]',
  city                TEXT,
  state               TEXT,
  country             TEXT,
  account_enabled     INTEGER NOT NULL DEFAULT 1,
  user_type           TEXT,
  synced_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_directory_mail ON directory_profiles(mail);

-- A value set here displays on top of the Graph value. Empty means "show
-- Graph." Reporting lines stay on users.lead_email unless the chart
-- overlay or a succeeded manager proof says otherwise.
CREATE TABLE IF NOT EXISTS directory_overlay (
  aad_id               TEXT PRIMARY KEY,
  title_override       TEXT,
  department_override  TEXT,
  city_override        TEXT,
  state_override       TEXT,
  updated_by           TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manager set from the Leadership chart. A row is the Arcadia line: it
-- wins over Graph and over users.lead_email. manager_aad_id NULL means
-- this person was placed in Unplaced on purpose. No row means fall through.
-- No Entra write.
CREATE TABLE IF NOT EXISTS directory_manager_overlay (
  aad_id         TEXT PRIMARY KEY,
  manager_aad_id TEXT,
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Managers read after a successful app-only proof. The chart uses these
-- rows only while the latest directory_sync_runs.manager_proof is succeeded.
CREATE TABLE IF NOT EXISTS directory_graph_managers (
  aad_id         TEXT PRIMARY KEY,
  manager_aad_id TEXT,
  manager_mail   TEXT,
  synced_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_social (
  id        TEXT PRIMARY KEY,
  aad_id    TEXT NOT NULL,
  network   TEXT NOT NULL,
  url       TEXT NOT NULL,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_directory_social_user ON directory_social(aad_id);

-- One row per sync. manager_proof is skipped when credentials are absent,
-- failed when the call did not return a manager id, succeeded only then.
-- A succeeded row is the only reason any code may treat manager as real,
-- and only for probed_aad_id.
CREATE TABLE IF NOT EXISTS directory_sync_runs (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  users_seen      INTEGER NOT NULL DEFAULT 0,
  manager_proof   TEXT NOT NULL CHECK (manager_proof IN ('skipped','failed','succeeded')),
  probed_aad_id   TEXT,
  manager_aad_id  TEXT,
  manager_mail    TEXT,
  detail          TEXT
);

-- Course | Certification. Not certifications / certification_checks /
-- false_certifications, and it does not flip instrument.certification_ledger.
CREATE TABLE IF NOT EXISTS continuing_education (
  id              TEXT PRIMARY KEY,
  subject_aad_id  TEXT NOT NULL,
  subject_email   TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('course','certification')),
  title           TEXT NOT NULL,
  completed_on    TEXT NOT NULL,
  provider        TEXT,
  note            TEXT,
  added_by        TEXT NOT NULL,
  added_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_education_subject ON continuing_education(subject_aad_id, completed_on);

-- The pattern. Instances are posted to Shifts; this row is not a shift.
-- Stopping the pattern stops new posts. Posted shifts stay until a named
-- human deletes them (shift_pattern_posts.deleted_at).
CREATE TABLE IF NOT EXISTS shift_patterns (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  weekdays            TEXT NOT NULL,
  start_time          TEXT NOT NULL,
  end_time            TEXT NOT NULL,
  scheduling_group_id TEXT NOT NULL,
  label               TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  enabled_by          TEXT NOT NULL,
  enabled_at          TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_by          TEXT,
  stopped_at          TEXT
);

-- One row per pattern per date, including dates a human deleted, so the
-- job does not recreate a shift someone removed.
CREATE TABLE IF NOT EXISTS shift_pattern_posts (
  id             TEXT PRIMARY KEY,
  pattern_id     TEXT NOT NULL,
  shift_date     TEXT NOT NULL,
  graph_shift_id TEXT,
  posted_at      TEXT NOT NULL DEFAULT (datetime('now')),
  posted_by      TEXT NOT NULL,
  deleted_at     TEXT,
  deleted_by     TEXT,
  UNIQUE (pattern_id, shift_date)
);

-- How many weeks ahead the pattern job posts. Absent row means 8.
INSERT OR IGNORE INTO config (key, value) VALUES ('schedule.pattern_horizon_weeks', '8');

-- Group-owned Planner plans. The board is still read live; this is the index.
CREATE TABLE IF NOT EXISTS planner_plan_index (
  plan_id    TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  group_name TEXT,
  title      TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planner_index_runs (
  id              TEXT PRIMARY KEY,
  finished_at     TEXT NOT NULL,
  plans_seen      INTEGER NOT NULL DEFAULT 0,
  roster_omitted  INTEGER NOT NULL DEFAULT 0,
  detail          TEXT
);

-- Loop link catalog. A URL a person typed. Not a crawl, and not
-- FileStorageContainer.Selected.
CREATE TABLE IF NOT EXISTS process_links (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  owner       TEXT,
  description TEXT,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Loop URLs bound to a client. Sibling of client_bindings because that
-- table's CHECK cannot grow in place (SQLite). Same attribution rule:
-- who added it, and when. The URL is a link. The pages are not read.
CREATE TABLE IF NOT EXISTS client_loop_bindings (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  url        TEXT NOT NULL,
  label      TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_client_loops ON client_loop_bindings(client_id);

-- Weekly factual run-sheet. JSON plus the plain rendering. Not sent to
-- the client. No EOS prose.
CREATE TABLE IF NOT EXISTS client_run_sheets (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  week_start   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  rendered     TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE (client_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_run_sheets_client ON client_run_sheets(client_id, week_start);
