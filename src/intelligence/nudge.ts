// At-risk task nudges.
//
// Picks tasks where:
//   - status is open or in_progress
//   - deadline_at is past or within 24h
//   - last_nudge_at is null OR older than NUDGE_COOLDOWN_HOURS
//
// For each (capped at NUDGE_MAX_PER_RUN *sent* nudges — see below), posts a
// nudge card to the task's channel and updates last_nudge_at.
//
// Presence-awareness lives in src/graph/presence.ts: before posting, this
// module batch-fetches presence for every candidate owner and skips anyone
// not reachable (Busy, Do Not Disturb, in a meeting/call). A presence skip
// does NOT consume the cooldown — last_nudge_at is left untouched so the
// same task is reconsidered next cycle once the owner is free. Presence is
// fail-open by construction (see isReachable): an owner with unknown
// presence, or a tenant with Presence.Read.All unconsented, is always
// treated as reachable, so this never silently suppresses a nudge.
//
// NUDGE_MAX_PER_RUN caps nudges actually sent, not candidates considered —
// candidates skipped for presence or a missing send target don't count
// against the cap, so a run with several Busy owners still sends up to the
// cap to everyone else.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { config } from "../lib/config";
import { nudgeCard } from "../cards/nudge";
import { postCard } from "../runtime/bot-outbound";
import { getPresenceBatch, isReachable, type Presence } from "../graph/presence";

// ---------------------------------------------------------------------------
// Injectable seam (mirrors RegistryDeps in ../graph/registry) — lets tests
// drive presence and the card-post path without a live Graph/Bot Framework.
// ---------------------------------------------------------------------------

export interface NudgeDeps {
  getPresenceBatch: (
    env: Env,
    aadIds: string[],
  ) => Promise<Map<string, Presence>>;
  postCard: typeof postCard;
}

const defaultDeps: NudgeDeps = { getPresenceBatch, postCard };

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
  /** Subset of `skipped` specifically due to an unreachable owner presence. */
  skippedPresence: number;
  failures: number;
}

// Bounds how many at-risk rows a single cycle pulls out of D1. Deliberately
// decoupled from NUDGE_MAX_PER_RUN: that cap is applied to nudges actually
// *sent* (see the loop below), so a run needs headroom beyond the send cap
// to keep finding sendable candidates behind ones skipped for presence or a
// missing send target.
const NUDGE_CANDIDATE_FETCH_CAP = 200;

export async function runNudgeCycle(
  env: Env,
  log: Logger,
  deps: NudgeDeps = defaultDeps,
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
    .bind(deadlineWindow, cooldownCutoff, NUDGE_CANDIDATE_FETCH_CAP)
    .all<NudgeCandidate>();

  const result: NudgeRunResult = {
    candidates: rows.results.length,
    nudgesSent: 0,
    skipped: 0,
    skippedPresence: 0,
    failures: 0,
  };

  // Batch-fetch presence once for every distinct candidate owner up front —
  // one Graph round trip (chunked internally) instead of one per row.
  const ownerIds = rows.results
    .map((c) => c.owner_aad_id)
    .filter((id): id is string => id !== null);
  const presence = await deps.getPresenceBatch(env, ownerIds);

  for (const c of rows.results) {
    if (result.nudgesSent >= cfg.nudgeMaxPerRun) break;

    if (!c.service_url || !c.conversation_id || !c.owner_aad_id) {
      result.skipped += 1;
      log.info("nudge_skip_no_target", { taskId: c.task_id });
      continue;
    }

    if (!isReachable(presence.get(c.owner_aad_id))) {
      // Presence-skip: leave last_nudge_at untouched so this task is
      // reconsidered next cycle instead of waiting out the full cooldown.
      result.skipped += 1;
      result.skippedPresence += 1;
      log.info("nudge_skip_presence", {
        taskId: c.task_id,
        ownerAadId: c.owner_aad_id,
      });
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

      await deps.postCard(
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
