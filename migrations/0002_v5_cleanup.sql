-- Migration number: 0002 	 2026-11-10T04:47:03.095Z
-- DESTRUCTIVE: drops 28 v5 tables, 2 Hermes-era tables, the instrument.* and
-- hermes_* config rows, and the grant and routing rows of removed
-- capabilities and task kinds.
-- Apply only after scripts/export-d1.sh (npm run db:export).
--
-- ROLLOUT ORDER: code first, then this migration. The Phase 1 code never reads a
-- dropped table. Merge, let the deploy of main finish, and only then does Shane
-- run GitHub Actions → Apply D1 migrations (or, from a terminal,
-- npm run db:export && npm run db:migrate:remote).
-- Applied before the deploy, it breaks the live v5 Directory sync, Schedule
-- and /clients until the deploy lands. See migrations/README.md ("Drops and
-- the deploy order") and docs/teardown-v5.md.
--
-- Brief Phase 1 section 1.4. Dropped tables (indexes go with them):
--   Doctrine, old Ask, site planning: approvals, doctrine_gaps, chat_messages,
--     seed_runs, seed_conflicts, site_plans
--   Accountability instruments: projects, project_signals, board_posts,
--     notifications, stall_events, certifications, certification_checks,
--     work_items, stage_transitions, pass_through_flags, false_certifications
--   Gatekeepers: gk_observations, gk_actions
--   Objectives, processes, run-sheet: planner_plan_index, planner_index_runs,
--     process_links, client_loop_bindings, client_run_sheets
--   Membership gating, leadership, manager proof, availability: client_members,
--     directory_manager_overlay, directory_graph_managers,
--     schedule_availability_cache
--   Hermes leftovers (beyond the brief's list; removed from the schema in
--     b122a52 but never dropped, not in 0001, hence IF EXISTS): topics,
--     published_log
-- Deleted config rows: every instrument.* key (0001 seeds
--   instrument.escalation_ladder, instrument.certification_ledger and
--   instrument.dispatch_enforcement), plus hermes_rate_ceiling_per_day,
--   hermes_rate_ceiling_per_week, hermes_auto_publish and
--   hermes_draft_first_started_at.
-- Deleted user_capabilities rows: grants of the capabilities Phase 1 removes
--   from src/lib/rbac.ts (approve_plans, ratify_doctrine, view_audit,
--   sign_certification, manage_projects, ask_arcadia).
-- Deleted model_config rows: overrides for the task kinds Phase 1 removes from
--   src/ai/types.ts (stall_sweep, classification, spellcheck, summary,
--   synthesis, copy_diff, judgment, site_ia, site_page_spec), plus any
--   'digest' override: in v5 it routed the founder digest, and the v6 'digest'
--   kind is the Phase 9 client-memory digest, which must start on the defaults.
--
-- Tables otherwise not touched (Phase 2 migrates them): users,
-- user_capabilities, directory_profiles, directory_overlay, directory_social,
-- directory_ignored, directory_sync_runs, clients, client_bindings,
-- continuing_education, time_off_requests, shift_patterns, shift_pattern_posts,
-- model_config, config, audit_log.

-- Foreign keys exist only between tables in the drop set, plus
-- client_members -> clients (a dropped child of a kept parent). Children are
-- dropped before parents; the pragma is the D1-documented guard for
-- migrations that touch foreign keys.
PRAGMA defer_foreign_keys = true;

-- Accountability instruments, FK children first.
DROP TABLE IF EXISTS stall_events;          -- -> projects
DROP TABLE IF EXISTS certification_checks;  -- -> certifications
DROP TABLE IF EXISTS false_certifications;  -- -> certifications
DROP TABLE IF EXISTS stage_transitions;     -- -> work_items
DROP TABLE IF EXISTS work_items;            -- -> projects
DROP TABLE IF EXISTS certifications;        -- -> projects
DROP TABLE IF EXISTS pass_through_flags;
DROP TABLE IF EXISTS project_signals;
DROP TABLE IF EXISTS board_posts;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS projects;

-- Doctrine, old Ask Arcadia, site planning.
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS doctrine_gaps;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS seed_conflicts;
DROP TABLE IF EXISTS seed_runs;
DROP TABLE IF EXISTS site_plans;

-- Gatekeepers.
DROP TABLE IF EXISTS gk_observations;
DROP TABLE IF EXISTS gk_actions;

-- Objectives, processes / Loop, run-sheet.
DROP TABLE IF EXISTS planner_plan_index;
DROP TABLE IF EXISTS planner_index_runs;
DROP TABLE IF EXISTS process_links;
DROP TABLE IF EXISTS client_loop_bindings;
DROP TABLE IF EXISTS client_run_sheets;

-- Workspace membership gating, leadership chart, manager proof, availability.
DROP TABLE IF EXISTS client_members;        -- -> clients (kept parent)
DROP TABLE IF EXISTS directory_manager_overlay;
DROP TABLE IF EXISTS directory_graph_managers;
DROP TABLE IF EXISTS schedule_availability_cache;

-- Hermes leftovers.
DROP TABLE IF EXISTS published_log;
DROP TABLE IF EXISTS topics;

-- Dead config rows. No LIKE: '_' and '%' are LIKE wildcards. Every key that
-- starts with 'instrument.' sorts at or after 'instrument.' and before
-- 'instrument/' ('/' is the character after '.').
DELETE FROM config WHERE key >= 'instrument.' AND key < 'instrument/';
DELETE FROM config WHERE key IN (
  'hermes_rate_ceiling_per_day',
  'hermes_rate_ceiling_per_week',
  'hermes_auto_publish',
  'hermes_draft_first_started_at'
);

-- Grants of removed capabilities. The code already ignores them on read.
DELETE FROM user_capabilities WHERE capability IN (
  'approve_plans',
  'ratify_doctrine',
  'view_audit',
  'sign_certification',
  'manage_projects',
  'ask_arcadia'
);

-- Routing overrides of removed task kinds, and the v5 founder-digest override.
DELETE FROM model_config WHERE task IN (
  'stall_sweep',
  'classification',
  'spellcheck',
  'summary',
  'synthesis',
  'copy_diff',
  'judgment',
  'site_ia',
  'site_page_spec',
  'digest'
);
