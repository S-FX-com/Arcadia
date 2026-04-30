-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 12 — Admin Controls, RBAC, Shift Templates, Staff Reports
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── User Roles (RBAC) ───────────────────────────────────────────────────────
-- Stores assigned roles for webapp users. The bootstrap admin (ADMIN_USER_AAD_ID
-- env var) is auto-provisioned into this table on first access.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id      TEXT    PRIMARY KEY,   -- AAD Object ID
  display_name TEXT    NOT NULL,
  email        TEXT,
  role         TEXT    NOT NULL CHECK(role IN ('admin','manager','viewer')),
  assigned_by  TEXT    NOT NULL,      -- AAD Object ID of the admin who assigned this
  assigned_at  INTEGER NOT NULL,      -- Unix timestamp
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

-- ─── Admin Audit Log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     TEXT    NOT NULL,
  actor_name   TEXT    NOT NULL,
  action       TEXT    NOT NULL,      -- e.g. 'role.assign', 'shift.push', 'shift.delete'
  target_type  TEXT,                  -- 'user' | 'shift_template' | 'shift'
  target_id    TEXT,
  payload      TEXT,                  -- JSON: action-specific data (before/after, counts, etc.)
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON admin_audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target  ON admin_audit_log(target_type, target_id);

-- ─── Shift Templates ─────────────────────────────────────────────────────────
-- Admin-defined recurring shift definitions. When "pushed", Arcadia expands the
-- recurrence rule and writes individual shifts to the Teams Shifts Graph API.
CREATE TABLE IF NOT EXISTS shift_templates (
  id                  TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL,
  team_id             TEXT    NOT NULL,
  scheduling_group_id TEXT,
  display_name        TEXT,           -- label shown in Teams Shifts UI
  theme               TEXT    NOT NULL DEFAULT 'blue',
  notes               TEXT,
  -- Recurrence rule stored as JSON:
  -- { type:'weekly'|'daily', days:[1,2,3,4,5] (1=Mon…7=Sun),
  --   start_time:'HH:MM', end_time:'HH:MM', timezone:'IANA tz',
  --   assignees:['aad-object-id', ...] }
  recurrence_rule     TEXT    NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_by          TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_templates_team   ON shift_templates(team_id, active);
CREATE INDEX IF NOT EXISTS idx_shift_templates_active ON shift_templates(active, created_at DESC);

-- ─── Shift Write Log ─────────────────────────────────────────────────────────
-- Records every shift instance pushed to the Teams Graph API so they can be
-- tracked, reported on, and individually deleted if needed.
CREATE TABLE IF NOT EXISTS shift_write_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id    TEXT    NOT NULL,
  graph_shift_id TEXT    NOT NULL,    -- ID returned by Teams Graph API
  team_id        TEXT    NOT NULL,
  assignee_id    TEXT    NOT NULL,    -- AAD Object ID of the staff member
  shift_start    INTEGER NOT NULL,    -- Unix timestamp
  shift_end      INTEGER NOT NULL,    -- Unix timestamp
  written_at     INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'created' CHECK(status IN ('created','deleted','error'))
);

CREATE INDEX IF NOT EXISTS idx_shift_write_log_template ON shift_write_log(template_id, shift_start);
CREATE INDEX IF NOT EXISTS idx_shift_write_log_assignee ON shift_write_log(assignee_id, shift_start);
CREATE INDEX IF NOT EXISTS idx_shift_write_log_status   ON shift_write_log(status, written_at DESC);
