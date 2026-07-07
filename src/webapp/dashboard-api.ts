// /api/webapp/dashboard — the home-screen rollup.
//
//   GET /api/webapp/dashboard
//
// Aggregates the data the dashboard tab needs in a single round-trip:
//   - me                Session basics
//   - activeClient      Selected Client (display + scope), or null
//   - tasks             open + in_progress + blocked, owned by viewer
//   - dueToday          subset of tasks
//   - overdue           subset of tasks
//   - recentDigests     last 5 digests (scoped to active Client when set;
//                       otherwise admin sees tenant-wide, non-admins are
//                       limited to channels they can access via derived ACL
//                       grants — default-deny per EXECUTION-PLAN D2)
//   - latestBrief       most recent brief targeted at this user
//   - activeRoutines    routines owned by viewer
//
// Tasks, briefs, and routines are keyed to the viewer's aad id. Digests
// are viewer-scoped per fetchRecentDigests (tenant-wide only for admins).
// The query is a few small SELECTs — no AI calls, so cron-cheap and
// dashboard-fast.

import type { Env } from "../env";
import {
  ClientScopeResolver,
  ClientStore,
  type ClientScope,
} from "../clients";
import { TaskStore } from "../tasks/store";
import { RoutineStore } from "../routines/store";
import { ResourceAcl } from "../acl/resource-acl";
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

  const activeClient = await loadActiveClient(env, session);

  const ownedOpen = await tasks.list({
    ownerAadId: session.aadId,
    status: ["open", "in_progress", "blocked"],
    limit: 100,
  });

  const scopedOpen = activeClient
    ? filterTasksByScope(ownedOpen, activeClient.scope)
    : ownedOpen;

  const dueToday = scopedOpen.filter(
    (t) =>
      t.deadlineAt !== undefined &&
      t.deadlineAt >= todayStart.toISOString() &&
      t.deadlineAt < todayEnd.toISOString(),
  );
  const overdue = scopedOpen.filter(
    (t) => t.deadlineAt !== undefined && t.deadlineAt < nowIso,
  );

  const digestRows = await fetchRecentDigests(env, session, activeClient);

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
    activeClient: activeClient
      ? {
          id: activeClient.client.id,
          displayName: activeClient.client.displayName,
          slug: activeClient.client.slug,
          scope: activeClient.scope,
        }
      : null,
    tasks: {
      open: scopedOpen.filter((t) => t.status === "open").length,
      inProgress: scopedOpen.filter((t) => t.status === "in_progress").length,
      blocked: scopedOpen.filter((t) => t.status === "blocked").length,
      total: scopedOpen.length,
    },
    dueToday,
    overdue,
    recentDigests: digestRows.map((r) => ({
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

interface ActiveClientCtx {
  client: { id: string; displayName: string; slug: string };
  scope: ClientScope;
}

async function loadActiveClient(
  env: Env,
  session: Session,
): Promise<ActiveClientCtx | null> {
  if (!session.activeClientId) return null;
  const store = new ClientStore(env);
  const client = await store.byId(session.activeClientId);
  if (!client) return null;
  const resolver = new ClientScopeResolver(env);
  const scope = await resolver.resolve(session.activeClientId);
  return {
    client: {
      id: client.id,
      displayName: client.displayName,
      slug: client.slug,
    },
    scope,
  };
}

function filterTasksByScope<
  T extends {
    channelId?: string;
    chatId?: string;
  },
>(tasks: T[], scope: ClientScope): T[] {
  const channels = new Set(scope.channelIds);
  const chats = new Set(scope.chatIds);
  return tasks.filter(
    (t) =>
      (t.channelId !== undefined && channels.has(t.channelId)) ||
      (t.chatId !== undefined && chats.has(t.chatId)),
  );
}

async function fetchRecentDigests(
  env: Env,
  session: Session,
  active: ActiveClientCtx | null,
): Promise<DashboardRow[]> {
  if (active) {
    if (active.scope.channelIds.length === 0) return [];
    const placeholders = active.scope.channelIds.map(() => "?").join(",");
    const rows = await env.ARCADIA_DB.prepare(
      `SELECT d.id, d.channel_id, d.posted_at, c.display_name
         FROM digests d
         JOIN channels c ON c.channel_id = d.channel_id
        WHERE d.channel_id IN (${placeholders})
        ORDER BY d.posted_at DESC
        LIMIT 5`,
    )
      .bind(...active.scope.channelIds)
      .all<DashboardRow>();
    return rows.results;
  }

  // Admins see every digest in the tenant.
  if (session.isAdmin) {
    const rows = await env.ARCADIA_DB.prepare(
      `SELECT d.id, d.channel_id, d.posted_at, c.display_name
         FROM digests d
         JOIN channels c ON c.channel_id = d.channel_id
        WHERE c.tenant_id = ?
        ORDER BY d.posted_at DESC
        LIMIT 5`,
    )
      .bind(session.tenantId)
      .all<DashboardRow>();
    return rows.results;
  }

  // Non-admins (P2): scope to channels the viewer can access via derived
  // ACL grants. Candidate set = channels with a digest posted in the last
  // 30 days; filterAccessible trims to what this viewer may see (default-
  // deny for channels with no derived grant). Empty set → no digests.
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const candidateRows = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT d.channel_id
       FROM digests d
       JOIN channels c ON c.channel_id = d.channel_id
      WHERE c.tenant_id = ? AND d.posted_at >= ?`,
  )
    .bind(session.tenantId, since)
    .all<{ channel_id: string }>();
  if (candidateRows.results.length === 0) return [];

  const acl = new ResourceAcl(env);
  const allowed = await acl.filterAccessible(
    candidateRows.results.map((r) => ({
      resourceType: "channel",
      resourceId: r.channel_id,
    })),
    { viewerAadId: session.aadId, tenantId: session.tenantId },
  );
  const channelIds = allowed.map((a) => a.resourceId);
  if (channelIds.length === 0) return [];

  const placeholders = channelIds.map(() => "?").join(",");
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT d.id, d.channel_id, d.posted_at, c.display_name
       FROM digests d
       JOIN channels c ON c.channel_id = d.channel_id
      WHERE d.channel_id IN (${placeholders})
      ORDER BY d.posted_at DESC
      LIMIT 5`,
  )
    .bind(...channelIds)
    .all<DashboardRow>();
  return rows.results;
}
