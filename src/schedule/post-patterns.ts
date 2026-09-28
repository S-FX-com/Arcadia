// Post shift instances for every enabled pattern, out to the configured
// horizon, skipping dates that overlap confirmed time off and dates that
// already have a row (posted or deleted). Delete is not this job.

import { mintScheduleScope, openScheduleSession } from "../gatekeepers/graph";
import type { GatekeeperContext } from "../gatekeepers/types";
import { appendAudit } from "../lib/audit";
import { graphAvailable } from "../integrations/graph";
import {
  clampHorizonWeeks,
  DEFAULT_HORIZON_WEEKS,
  horizonDates,
  shiftInterval,
  skipConfirmedTimeOff,
} from "../lib/shift-pattern";

interface PatternRow {
  id: string;
  team_id: string;
  user_id: string;
  weekdays: string;
  start_time: string;
  end_time: string;
  scheduling_group_id: string;
  label: string | null;
  enabled_by: string;
}

export interface PatternPostResult {
  posted: number;
  skippedTimeOff: number;
  detail: string;
}

async function horizonWeeks(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT value FROM config WHERE key = 'schedule.pattern_horizon_weeks'`
  ).first<{ value: string }>();
  return clampHorizonWeeks(row ? Number(row.value) : DEFAULT_HORIZON_WEEKS);
}

export async function postShiftPatterns(env: Env, ctx: GatekeeperContext): Promise<PatternPostResult> {
  const scope = await mintScheduleScope(env);
  if (!scope || !graphAvailable(env)) {
    const detail = !graphAvailable(env)
      ? "Graph credentials are not configured. No shifts were posted."
      : "No Shifts team is configured. No shifts were posted.";
    await appendAudit(env.DB, { actor: ctx.actor, action: "shift_patterns_skipped", detail });
    return { posted: 0, skippedTimeOff: 0, detail };
  }

  const patterns = (
    await env.DB.prepare(
      `SELECT id, team_id, user_id, weekdays, start_time, end_time, scheduling_group_id, label, enabled_by
         FROM shift_patterns WHERE enabled = 1 AND team_id = ?1`
    )
      .bind(scope.teamId)
      .all<PatternRow>()
  ).results;
  if (patterns.length === 0) {
    return { posted: 0, skippedTimeOff: 0, detail: "No enabled pattern on this team." };
  }

  const session = openScheduleSession(env, ctx, scope);
  let timeOff: Array<{ userId?: string; startDateTime?: string; endDateTime?: string }> = [];
  try {
    timeOff = await session.timesOff();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "confirmed time off could not be read";
    await appendAudit(env.DB, { actor: ctx.actor, action: "shift_patterns_skipped", detail });
    return { posted: 0, skippedTimeOff: 0, detail: `Time off could not be read, so nothing was posted. ${detail}` };
  }

  const weeks = await horizonWeeks(env);
  const now = new Date();
  let posted = 0;
  let skippedTimeOff = 0;
  for (const pattern of patterns) {
    let weekdays: number[] = [];
    try {
      weekdays = JSON.parse(pattern.weekdays) as number[];
    } catch {
      weekdays = [];
    }
    const dates = horizonDates(now, weeks, weekdays);
    const split = skipConfirmedTimeOff(pattern.user_id, dates, pattern.start_time, pattern.end_time, timeOff);
    skippedTimeOff += split.skipped.length;
    const existing = (
      await env.DB.prepare(`SELECT shift_date FROM shift_pattern_posts WHERE pattern_id = ?1`)
        .bind(pattern.id)
        .all<{ shift_date: string }>()
    ).results;
    const have = new Set(existing.map((row) => row.shift_date));
    for (const date of split.post) {
      if (have.has(date)) continue;
      const interval = shiftInterval(date, pattern.start_time, pattern.end_time);
      if (!interval) continue;
      try {
        const created = await session.createShift(
          {
            userId: pattern.user_id,
            schedulingGroupId: pattern.scheduling_group_id,
            startDateTime: interval.start.toISOString(),
            endDateTime: interval.end.toISOString(),
            ...(pattern.label ? { displayName: pattern.label } : {}),
          },
          { kind: "human_approval", approvalId: pattern.id, decidedBy: pattern.enabled_by }
        );
        await env.DB.prepare(
          `INSERT INTO shift_pattern_posts (id, pattern_id, shift_date, graph_shift_id, posted_by)
           VALUES (?1, ?2, ?3, ?4, ?5)`
        )
          .bind(crypto.randomUUID(), pattern.id, date, created.graphId ?? null, pattern.enabled_by)
          .run();
        posted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "shift post failed";
        const detail = `Posted ${posted}. Skipped ${skippedTimeOff} for confirmed time off. Stopped: ${message}`;
        await appendAudit(env.DB, { actor: ctx.actor, action: "shift_patterns_posted", detail });
        return { posted, skippedTimeOff, detail };
      }
    }
  }
  const detail = `Posted ${posted}. Skipped ${skippedTimeOff} for confirmed time off. Horizon ${weeks} weeks.`;
  await appendAudit(env.DB, { actor: ctx.actor, action: "shift_patterns_posted", detail });
  return { posted, skippedTimeOff, detail };
}
