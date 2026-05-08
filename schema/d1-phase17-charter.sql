-- ─────────────────────────────────────────────────────────────────────────────
-- Arcadia Phase 17 — User Operating Charter
--
-- A user-authored Markdown document, one per staff member, that Arcadia reads
-- on every conversational turn and treats as ground truth. Sits alongside the
-- AI-inferred ProfileInsights in user_profiles: the charter is what the user
-- says about themselves; ProfileInsights is what Arcadia has inferred.
--
-- v1: single mutable row per user, no revision history, hardcoded review
-- cadence (90 days enforced in app code).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_charter (
  user_aad_id      TEXT    PRIMARY KEY,
  content          TEXT    NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL,
  last_reviewed_at INTEGER
);
