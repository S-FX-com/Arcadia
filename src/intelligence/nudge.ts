// At-risk task nudges.
//
// Picks tasks where:
//   - status is open or in_progress
//   - deadline_at is past or within 24h
//   - last_nudge_at is null OR older than NUDGE_COOLDOWN_HOURS
//
// For each (capped at NUDGE_MAX_PER_RUN), posts a nudge card to the
// task's channel and updates last_nudge_at. Presence-awareness lives
// behind src/graph/presence.ts and is consulted when available; without
// it, every owner is treated as reachable.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { config } from "../lib/config";
import { nudgeCard } from "../cards/nudge";
import { postCard } from "../runtime/bot-outbound";

interface NudgeCandidate {
  task_id: string;
  title: string;
  deadline_at: string | null;
  priority: string;
  status: string;
  owner_aad_id: string | null;
  channel_id: string | null;
  service_url: string | null;
  conversation_id: string | null;
}

export interface NudgeRunResult {
  candidates: number;
  nudgesSent: number;
  skipped: number;
  failures: number;
}

export async function runNudgeCycle(
  env: Env,
  log: Logger,
): Promise<NudgeRunResult> {
  const cfg = config(env);
  const cooldownMs = cfg.nudgeCooldownHours * 3600 * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownMs).toISOString();
  const deadlineWindow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT t.id AS task_id, t.title, t.deadline_at, t.priority, t.status,
            t.owner_aad_id, t.channel_id,
            c.service_url, c.conversation_id
       FROM tasks t
       LEFT JOIN channels c ON c.channel_id = t.channel_id
      WHERE t.status IN ('open','in_progress')
        AND t.owner_aad_id IS NOT NULL
        AND t.deadline_at IS NOT NULL
        AND t.deadline_at <= ?
        AND (t.last_nudge_at IS NULL OR t.last_nudge_at < ?)
      ORDER BY
        CASE WHEN t.deadline_at < datetime('now') THEN 0 ELSE 1 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
        t.deadline_at
      LIMIT ?`,
  )
    .bind(deadlineWindow, cooldownCutoff, cfg.nudgeMaxPerRun)
    .all<NudgeCandidate>();

  const result: NudgeRunResult = {
    candidates: rows.results.length,
    nudgesSent: 0,
    skipped: 0,
    failures: 0,
  };

  for (const c of rows.results) {
    if (!c.service_url || !c.conversation_id || !c.owner_aad_id) {
      result.skipped += 1;
      log.info("nudge_skip_no_target", { taskId: c.task_id });
      continue;
    }
    try {
      const nudgeId = crypto.randomUUID();
      const card = nudgeCard({
        nudgeId,
        targetAadId: c.owner_aad_id,
        subject: c.title,
        reason: reasonFor(c),
        taskId: c.task_id,
      });

      await postCard(
        env,
        {
          serviceUrl: c.service_url,
          conversationId: c.conversation_id,
        },
        card,
        log,
        { summary: `Nudge: ${c.title}` },
      );

      const now = new Date().toISOString();
      await env.ARCADIA_DB.prepare(
        `UPDATE tasks SET last_nudge_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(now, now, c.task_id)
        .run();

      result.nudgesSent += 1;
    } catch (e) {
      result.failures += 1;
      log.error("nudge_failed", { taskId: c.task_id, error: String(e) });
    }
  }

  log.info("nudge_cycle", result);
  return result;
}

function reasonFor(c: NudgeCandidate): string {
  if (!c.deadline_at) return "This has been quiet for a while.";
  const due = new Date(c.deadline_at).getTime();
  const now = Date.now();
  if (due < now) {
    const hours = Math.round((now - due) / 3600000);
    return `Deadline was ${hours}h ago. Where are we with it?`;
  }
  const hours = Math.round((due - now) / 3600000);
  return `Deadline in ${hours}h — worth a check-in.`;
}
