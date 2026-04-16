// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Feature Flags (Tier 4, Phase 2 restructure, numeral 11)
//
// Central place for reading boolean-like env flags. Replaces scattered
// `env.X_ENABLED === "true"` checks so that adding/renaming a flag only
// touches this file.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "./types.js";

function flag(value: string | undefined): boolean {
  return value === "true";
}

export const features = {
  webapp: (env: Env) => flag(env.WEBAPP_ENABLED),
  memory: (env: Env) => flag(env.MEMORY_ENABLED),
  memoryConsolidation: (env: Env) => flag(env.MEMORY_CONSOLIDATION_ENABLED),
  vectorize: (env: Env) => flag(env.VECTORIZE_ENABLED) && env.ARCADIA_VECTORS !== undefined,
  knowledgeGraph: (env: Env) => flag(env.KNOWLEDGE_GRAPH_ENABLED),
  autoresearch: (env: Env) => flag(env.AUTORESEARCH_ENABLED),
  morningBrief: (env: Env) => flag(env.MORNING_BRIEF_ENABLED),
  eveningWrapup: (env: Env) => flag(env.EVENING_WRAPUP_ENABLED),
  weeklyReport: (env: Env) => flag(env.WEEKLY_REPORT_ENABLED),
};
