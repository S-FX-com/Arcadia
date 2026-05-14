// Morning + evening briefs.
//
// Morning: for each user with open work, generate a short "what's on
// your plate today" brief. Evening: same shape but framed as "how
// today went, what's blocked, what's next".
//
// Briefs are written to the `briefs` table. Delivery via 1:1 DM lands
// when the webapp + user-installed bot conversation tracking ships.
// Until then the runner generates and stores; the dashboard can read
// them and a future cron tail can fan them out.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";

export type BriefKind = "morning" | "evening";

interface UserWithWork {
  aad_id: string;
  display_name: string | null;
  open_count: number;
  due_today: number;
  overdue: number;
  recent_completions: number;
}

export interface BriefsRunResult {
  kind: BriefKind;
  usersConsidered: number;
  briefsWritten: number;
  failures: number;
}

const MAX_TASKS_IN_PROMPT = 12;

export async function runBriefsCycle(
  env: Env,
  kind: BriefKind,
  log: Logger,
): Promise<BriefsRunResult> {
  const users = await fetchUsersWithWork(env, kind);
  const result: BriefsRunResult = {
    kind,
    usersConsidered: users.length,
    briefsWritten: 0,
    failures: 0,
  };

  const router = new Router(env);
  for (const u of users) {
    try {
      const tasks = await fetchUserTasks(env, u.aad_id);
      const body = await composeBrief(env, router, kind, u, tasks, log);
      await env.ARCADIA_DB.prepare(
        `INSERT INTO briefs (id, kind, target_kind, target_id, body, message_id, posted_at)
         VALUES (?, ?, 'user', ?, ?, NULL, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          kind,
          u.aad_id,
          body,
          new Date().toISOString(),
        )
        .run();
      result.briefsWritten += 1;
    } catch (e) {
      result.failures += 1;
      log.error("brief_failed", {
        kind,
        userAadId: u.aad_id,
        error: String(e),
      });
    }
  }

  log.info("briefs_cycle", result);
  return result;
}

async function fetchUsersWithWork(
  env: Env,
  kind: BriefKind,
): Promise<UserWithWork[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 3600 * 1000);

  if (kind === "morning") {
    const rows = await env.ARCADIA_DB.prepare(
      `SELECT u.aad_id, u.display_name,
              SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN t.status IN ('open','in_progress')
                        AND t.deadline_at IS NOT NULL
                        AND t.deadline_at >= ? AND t.deadline_at < ? THEN 1 ELSE 0 END) AS due_today,
              SUM(CASE WHEN t.status IN ('open','in_progress')
                        AND t.deadline_at IS NOT NULL
                        AND t.deadline_at < ? THEN 1 ELSE 0 END) AS overdue,
              0 AS recent_completions
         FROM users u
         JOIN tasks t ON t.owner_aad_id = u.aad_id
        GROUP BY u.aad_id, u.display_name
       HAVING open_count > 0`,
    )
      .bind(todayStart.toISOString(), todayEnd.toISOString(), todayStart.toISOString())
      .all<UserWithWork>();
    return rows.results;
  }

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT u.aad_id, u.display_name,
            SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open_count,
            0 AS due_today,
            SUM(CASE WHEN t.status IN ('open','in_progress')
                      AND t.deadline_at IS NOT NULL
                      AND t.deadline_at < ? THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN t.status = 'done'
                      AND t.updated_at >= ? THEN 1 ELSE 0 END) AS recent_completions
       FROM users u
       JOIN tasks t ON t.owner_aad_id = u.aad_id
      GROUP BY u.aad_id, u.display_name
     HAVING open_count > 0 OR recent_completions > 0`,
  )
    .bind(todayStart.toISOString(), todayStart.toISOString())
    .all<UserWithWork>();
  return rows.results;
}

interface UserTaskRow {
  title: string;
  deadline_at: string | null;
  priority: string;
  status: string;
}

async function fetchUserTasks(
  env: Env,
  aadId: string,
): Promise<UserTaskRow[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT title, deadline_at, priority, status
       FROM tasks
      WHERE owner_aad_id = ?
        AND status IN ('open','in_progress','blocked','done')
      ORDER BY
        CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1
                    WHEN 'open' THEN 2 ELSE 3 END,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                      WHEN 'normal' THEN 2 ELSE 3 END,
        deadline_at IS NULL,
        deadline_at
      LIMIT ?`,
  )
    .bind(aadId, MAX_TASKS_IN_PROMPT)
    .all<UserTaskRow>();
  return rows.results;
}

async function composeBrief(
  env: Env,
  router: Router,
  kind: BriefKind,
  user: UserWithWork,
  tasks: UserTaskRow[],
  log: Logger,
): Promise<string> {
  const taskLines = tasks
    .map(
      (t) =>
        `- [${t.status}] ${t.title}${t.deadline_at ? ` (due ${t.deadline_at})` : ""} [${t.priority}]`,
    )
    .join("\n");

  const basePrompt =
    kind === "morning"
      ? "You are Arcadia. Write a short morning brief — 4–6 lines, plain prose. Lead with what matters today. Name overdue items. Be direct, no filler, no headers."
      : "You are Arcadia. Write a short evening wrap-up — 4–6 lines, plain prose. Lead with what got done. Call out anything blocked or slipping. No headers, no filler.";
  const system = await injectCharter(env, basePrompt);

  try {
    const reply = await router.complete({
      system,
      messages: [
        {
          role: "user",
          content: `For ${user.display_name ?? user.aad_id}.
Open: ${user.open_count}; due today: ${user.due_today}; overdue: ${user.overdue}; completed today: ${user.recent_completions}.

Tasks:
${taskLines}`,
        },
      ],
      tier: "balanced",
      maxTokens: 350,
    });
    return reply.text.trim();
  } catch (e) {
    log.warn("brief_compose_failed", {
      kind,
      userAadId: user.aad_id,
      error: String(e),
    });
    return fallbackBrief(kind, user);
  }
}

function fallbackBrief(kind: BriefKind, user: UserWithWork): string {
  const who = user.display_name ?? "you";
  if (kind === "morning") {
    const parts = [`Morning, ${who}.`];
    if (user.overdue > 0)
      parts.push(`${user.overdue} item(s) overdue — clear those first.`);
    if (user.due_today > 0)
      parts.push(`${user.due_today} due today.`);
    parts.push(`${user.open_count} open total.`);
    return parts.join(" ");
  }
  const parts = [`End of day, ${who}.`];
  if (user.recent_completions > 0)
    parts.push(`${user.recent_completions} done.`);
  if (user.overdue > 0)
    parts.push(`${user.overdue} still overdue.`);
  parts.push(`${user.open_count} open going into tomorrow.`);
  return parts.join(" ");
}
