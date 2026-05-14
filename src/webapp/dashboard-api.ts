// /api/webapp/dashboard — the home-screen rollup.
//
//   GET /api/webapp/dashboard
//
// Aggregates the data the dashboard tab needs in a single round-trip:
//   - me                Session basics
//   - tasks             open + in_progress + blocked, owned by viewer
//   - dueToday          subset of tasks
//   - overdue           subset of tasks
//   - recentDigests     last 5 digests in viewer's tenant channels
//   - latestBrief       most recent brief targeted at this user
//   - activeRoutines    routines owned by viewer
//
// All ACL is per-viewer. The query is a few small SELECTs — no AI
// calls, so cron-cheap and dashboard-fast.

import type { Env } from "../env";
import { TaskStore } from "../tasks/store";
import { RoutineStore } from "../routines/store";
import type { Session } from "./auth";

interface DashboardRow {
  display_name: string | null;
  channel_id: string;
  id: string;
  posted_at: string;
}

export async function handleDashboard(
  _request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const tasks = new TaskStore(env);
  const routines = new RoutineStore(env);

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 3600 * 1000);
  const nowIso = new Date().toISOString();

  const ownedOpen = await tasks.list({
    ownerAadId: session.aadId,
    status: ["open", "in_progress", "blocked"],
    limit: 100,
  });

  const dueToday = ownedOpen.filter(
    (t) =>
      t.deadlineAt !== undefined &&
      t.deadlineAt >= todayStart.toISOString() &&
      t.deadlineAt < todayEnd.toISOString(),
  );
  const overdue = ownedOpen.filter(
    (t) => t.deadlineAt !== undefined && t.deadlineAt < nowIso,
  );

  const digestRows = await env.ARCADIA_DB.prepare(
    `SELECT d.id, d.channel_id, d.posted_at, c.display_name
       FROM digests d
       JOIN channels c ON c.channel_id = d.channel_id
      WHERE c.tenant_id = ?
      ORDER BY d.posted_at DESC
      LIMIT 5`,
  )
    .bind(session.tenantId)
    .all<DashboardRow>();

  const latestBrief = await env.ARCADIA_DB.prepare(
    `SELECT id, kind, body, posted_at FROM briefs
      WHERE target_kind = 'user' AND target_id = ?
      ORDER BY posted_at DESC LIMIT 1`,
  )
    .bind(session.aadId)
    .first<{
      id: string;
      kind: string;
      body: string;
      posted_at: string;
    }>();

  const activeRoutines = await routines.listByOwner(session.aadId, true);

  return Response.json({
    me: {
      aadId: session.aadId,
      tenantId: session.tenantId,
      ...(session.name ? { name: session.name } : {}),
      ...(session.upn ? { upn: session.upn } : {}),
    },
    tasks: {
      open: ownedOpen.filter((t) => t.status === "open").length,
      inProgress: ownedOpen.filter((t) => t.status === "in_progress").length,
      blocked: ownedOpen.filter((t) => t.status === "blocked").length,
      total: ownedOpen.length,
    },
    dueToday,
    overdue,
    recentDigests: digestRows.results.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      channelDisplayName: r.display_name,
      postedAt: r.posted_at,
    })),
    latestBrief,
    activeRoutines: activeRoutines.map((r) => ({
      id: r.id,
      name: r.name,
      trigger: r.trigger,
    })),
  });
}
