// Parses runtime tunables from Env into a typed config object.
// Defaults match the values documented in wrangler.toml so a fresh
// deployment with no [vars] block still works.

import type { Env } from "../env";

export interface Config {
  staleThreadHours: number;
  maxMessagesCached: number;
  digestCronHour: number;
  cfAiDefaultModel: string;
  nudgeCooldownHours: number;
  nudgeMaxPerRun: number;
  researchQuestionMaxPerCycle: number;
  researchQuestionMaxPerDay: number;
  procedureMinUses: number;
  procedurePromoteThreshold: number;
  procedureRetireThreshold: number;
  /** Refresh a person profile every N handled messages (SOUL.md cadence). */
  profileRefreshEvery: number;
  /** Minimum recent memories before a person profile is (re)built. */
  profileMinMemories: number;
}

function num(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function config(env: Env): Config {
  return {
    staleThreadHours: num(env.STALE_THREAD_HOURS, 48),
    maxMessagesCached: num(env.MAX_MESSAGES_CACHED, 100),
    digestCronHour: num(env.DIGEST_CRON_HOUR, 8),
    cfAiDefaultModel:
      env.CF_AI_DEFAULT_MODEL ?? "@cf/google/gemma-4-26b-a4b-it",
    nudgeCooldownHours: num(env.NUDGE_COOLDOWN_HOURS, 8),
    nudgeMaxPerRun: num(env.NUDGE_MAX_PER_RUN, 5),
    researchQuestionMaxPerCycle: num(env.RESEARCH_QUESTION_MAX_PER_CYCLE, 3),
    researchQuestionMaxPerDay: num(env.RESEARCH_QUESTION_MAX_PER_DAY, 5),
    procedureMinUses: num(env.PROCEDURE_MIN_USES, 5),
    procedurePromoteThreshold: num(env.PROCEDURE_PROMOTE_THRESHOLD, 0.65),
    procedureRetireThreshold: num(env.PROCEDURE_RETIRE_THRESHOLD, 0.35),
    profileRefreshEvery: num(env.PROFILE_REFRESH_EVERY, 20),
    profileMinMemories: num(env.PROFILE_MIN_MEMORIES, 5),
  };
}
