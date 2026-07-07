// Org registry — continuous enumeration of the tenant into D1.
//
// The v2 producers tried to discover sites/drives by json_extract over
// documents.uri, which never matched (the URI is a plain path). This
// module instead walks Microsoft Graph app-only and registers first-class
// rows: users, sites, drives, teams+channels, and chats — the same way
// channels are registered from bot conversationUpdate events, but for the
// whole tenant rather than only where the bot is installed.
//
// Every Graph call goes through the shared client (app-only token) and
// pagination is handled by graphAllPages, so nextLink/deltaLink follow-ups
// actually work. Each sub-sync is independent and fail-soft; syncRegistry
// runs them all and records one ingest_runs row for observability.
//
// The pure upsert helpers (upsert*Row) are exported so they can be
// integration-tested directly against D1 without a live Graph, and the
// sync functions accept an injectable `deps` seam so a throwing graph fn
// can be substituted in tests.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import {
  graph,
  GraphError,
  graphAllPages,
  type GraphAllPagesOptions,
  type GraphRequest,
} from "./client";
import { loadDeltaToken, saveDeltaToken, tokenFromDeltaLink } from "./delta";

// ---------------------------------------------------------------------------
// Injectable Graph seam
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  graphAllPages: <T = unknown>(
    env: Env,
    req: GraphRequest,
    opts?: GraphAllPagesOptions,
  ) => Promise<{ items: T[]; deltaLink?: string }>;
  graph: <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;
}

const defaultDeps: RegistryDeps = { graphAllPages, graph };

// ---------------------------------------------------------------------------
// Graph resource shapes (only the fields we persist)
// ---------------------------------------------------------------------------

interface GraphUser {
  id?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  "@removed"?: unknown;
}

interface GraphSite {
  id?: string;
  displayName?: string;
  webUrl?: string;
}

interface GraphDrive {
  id?: string;
  driveType?: string;
  name?: string;
}

interface GraphGroup {
  id?: string;
  displayName?: string;
}

interface GraphChannel {
  id?: string;
  displayName?: string;
}

interface GraphChat {
  id?: string;
  chatType?: string;
  topic?: string;
}

const USER_DRIVE_CURSOR_KEY = "registry:drives:user_cursor";
const USER_DRIVE_BATCH = 100;
const CHAT_USER_BATCH = 50;

// ===========================================================================
// Pure upsert helpers (exported for direct D1 integration tests)
// ===========================================================================

export interface UserRow {
  aadId: string;
  tenantId: string;
  upn?: string | null;
  displayName?: string | null;
  mail?: string | null;
}

/**
 * Upsert a user. On conflict only display_name/mail/upn are refreshed —
 * is_admin, profile_json, active_client_id and last_seen_at are owned by
 * other flows and must never be clobbered by registry enumeration.
 */
export async function upsertUserRow(env: Env, row: UserRow): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO users (aad_id, tenant_id, upn, display_name, mail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(aad_id) DO UPDATE SET
       display_name = excluded.display_name,
       mail         = excluded.mail,
       upn          = excluded.upn`,
  )
    .bind(
      row.aadId,
      row.tenantId,
      row.upn ?? null,
      row.displayName ?? null,
      row.mail ?? null,
    )
    .run();
}

export interface SiteRow {
  siteId: string;
  tenantId: string;
  displayName?: string | null;
  webUrl?: string | null;
}

export async function upsertSiteRow(env: Env, row: SiteRow): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO sites (site_id, tenant_id, display_name, web_url, last_synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET
       display_name   = excluded.display_name,
       web_url        = excluded.web_url,
       last_synced_at = excluded.last_synced_at`,
  )
    .bind(
      row.siteId,
      row.tenantId,
      row.displayName ?? null,
      row.webUrl ?? null,
      new Date().toISOString(),
    )
    .run();
}

export interface DriveRow {
  driveId: string;
  tenantId: string;
  ownerType: "user" | "site" | "group";
  ownerId: string;
  driveType?: string | null;
  displayName?: string | null;
}

export async function upsertDriveRow(env: Env, row: DriveRow): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO drives
       (drive_id, tenant_id, owner_type, owner_id, drive_type, display_name, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(drive_id) DO UPDATE SET
       owner_type     = excluded.owner_type,
       owner_id       = excluded.owner_id,
       drive_type     = excluded.drive_type,
       display_name   = excluded.display_name,
       last_synced_at = excluded.last_synced_at`,
  )
    .bind(
      row.driveId,
      row.tenantId,
      row.ownerType,
      row.ownerId,
      row.driveType ?? null,
      row.displayName ?? null,
      new Date().toISOString(),
    )
    .run();
}

export interface ChannelRow {
  channelId: string;
  teamId: string;
  tenantId: string;
  displayName?: string | null;
}

/**
 * Upsert a channel discovered via Graph enumeration. New rows get an empty
 * service_url — the real serviceUrl only arrives on a bot conversationUpdate,
 * and proactive posting already no-ops where it is empty. On conflict we
 * refresh only topology/display_name and never touch service_url,
 * conversation_id or enabled.
 */
export async function upsertChannelRow(
  env: Env,
  row: ChannelRow,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO channels (channel_id, team_id, tenant_id, service_url, display_name)
     VALUES (?, ?, ?, '', ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       team_id      = excluded.team_id,
       tenant_id    = excluded.tenant_id,
       display_name = excluded.display_name`,
  )
    .bind(row.channelId, row.teamId, row.tenantId, row.displayName ?? null)
    .run();
}

export type ChatType = "oneOnOne" | "group" | "meeting";

export function mapChatType(raw: string | undefined): ChatType {
  if (raw === "oneOnOne" || raw === "group" || raw === "meeting") return raw;
  return "group";
}

export interface ChatRow {
  chatId: string;
  tenantId: string;
  chatType: ChatType;
  displayName?: string | null;
}

/**
 * Upsert a chat. New rows get an empty service_url (see upsertChannelRow).
 * On conflict we refresh chat_type/display_name only — service_url and
 * last_seen_at are left intact.
 */
export async function upsertChatRow(env: Env, row: ChatRow): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO chats (chat_id, tenant_id, service_url, chat_type, display_name)
     VALUES (?, ?, '', ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       chat_type    = excluded.chat_type,
       display_name = excluded.display_name`,
  )
    .bind(row.chatId, row.tenantId, row.chatType, row.displayName ?? null)
    .run();
}

// ===========================================================================
// Sync functions
// ===========================================================================

/**
 * Delta-walk /users into the users table. Uses a tenant-scoped delta cursor
 * so subsequent runs only see changes. @removed entries are left in place
 * (soft — we skip rather than delete).
 */
export async function syncUsers(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<number> {
  const cursor = await loadDeltaToken(env, "users", "tenant");
  const query: Record<string, string> = {
    $select: "id,displayName,mail,userPrincipalName,accountEnabled",
  };
  if (cursor) query.$deltatoken = cursor;

  const { items, deltaLink } = await deps.graphAllPages<GraphUser>(env, {
    path: "/users/delta",
    query,
  });

  let count = 0;
  for (const u of items) {
    if (!u.id || u["@removed"] !== undefined) continue;
    await upsertUserRow(env, {
      aadId: u.id,
      tenantId: env.GRAPH_TENANT_ID,
      upn: u.userPrincipalName ?? null,
      displayName: u.displayName ?? null,
      mail: u.mail ?? null,
    });
    count += 1;
  }

  const newToken = tokenFromDeltaLink(deltaLink);
  if (newToken) await saveDeltaToken(env, "users", "tenant", newToken);

  log.info("registry_users_synced", { upserts: count });
  return count;
}

/** Enumerate SharePoint sites (/sites?search=*) into the sites table. */
export async function syncSites(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<number> {
  const { items } = await deps.graphAllPages<GraphSite>(env, {
    path: "/sites",
    query: { search: "*" },
  });

  let count = 0;
  for (const s of items) {
    if (!s.id) continue;
    await upsertSiteRow(env, {
      siteId: s.id,
      tenantId: env.GRAPH_TENANT_ID,
      displayName: s.displayName ?? null,
      webUrl: s.webUrl ?? null,
    });
    count += 1;
  }

  log.info("registry_sites_synced", { upserts: count });
  return count;
}

/**
 * Register drives for every known site (all of them each run) plus a rolling
 * batch of user OneDrives (cap USER_DRIVE_BATCH per run, cursor in KV so runs
 * rotate through the whole directory). Missing/forbidden drives are skipped.
 */
export async function syncDrives(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<number> {
  let count = 0;

  const sites = await env.ARCADIA_DB.prepare(
    `SELECT site_id FROM sites`,
  ).all<{ site_id: string }>();

  for (const site of sites.results) {
    const { items } = await deps.graphAllPages<GraphDrive>(env, {
      path: `/sites/${site.site_id}/drives`,
    });
    for (const d of items) {
      if (!d.id) continue;
      await upsertDriveRow(env, {
        driveId: d.id,
        tenantId: env.GRAPH_TENANT_ID,
        ownerType: "site",
        ownerId: site.site_id,
        driveType: d.driveType ?? null,
        displayName: d.name ?? null,
      });
      count += 1;
    }
  }

  const cursor = (await env.ARCADIA_CACHE.get(USER_DRIVE_CURSOR_KEY)) ?? "";
  const users = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users WHERE aad_id > ? ORDER BY aad_id LIMIT ?`,
  )
    .bind(cursor, USER_DRIVE_BATCH)
    .all<{ aad_id: string }>();

  for (const user of users.results) {
    try {
      const drive = await deps.graph<GraphDrive>(env, {
        path: `/users/${user.aad_id}/drive`,
      });
      if (!drive?.id) continue;
      await upsertDriveRow(env, {
        driveId: drive.id,
        tenantId: env.GRAPH_TENANT_ID,
        ownerType: "user",
        ownerId: user.aad_id,
        driveType: drive.driveType ?? null,
        displayName: drive.name ?? null,
      });
      count += 1;
    } catch (e) {
      // A user with no provisioned OneDrive (or no license) returns 404/403 —
      // skip silently. Anything else is unexpected and aborts this sub-sync.
      if (e instanceof GraphError && (e.status === 404 || e.status === 403)) {
        log.debug("registry_user_drive_skipped", {
          aadId: user.aad_id,
          status: e.status,
        });
        continue;
      }
      throw e;
    }
  }

  const last = users.results.at(-1)?.aad_id;
  const nextCursor =
    users.results.length < USER_DRIVE_BATCH || !last ? "" : last;
  await env.ARCADIA_CACHE.put(USER_DRIVE_CURSOR_KEY, nextCursor);

  log.info("registry_drives_synced", {
    upserts: count,
    userCursorAdvanced: nextCursor !== "",
  });
  return count;
}

/**
 * Enumerate Teams-provisioned groups and their channels into the channels
 * table. The resourceProvisioningOptions/Any(...) filter needs an advanced
 * query (ConsistencyLevel: eventual + $count=true).
 */
export async function syncTeamsAndChannels(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<number> {
  const { items: teams } = await deps.graphAllPages<GraphGroup>(env, {
    path: "/groups",
    query: {
      $filter: "resourceProvisioningOptions/Any(x:x eq 'Team')",
      $select: "id,displayName",
      $count: "true",
    },
    headers: { ConsistencyLevel: "eventual" },
  });

  let count = 0;
  for (const team of teams) {
    if (!team.id) continue;
    const { items: channels } = await deps.graphAllPages<GraphChannel>(env, {
      path: `/teams/${team.id}/channels`,
    });
    for (const ch of channels) {
      if (!ch.id) continue;
      await upsertChannelRow(env, {
        channelId: ch.id,
        teamId: team.id,
        tenantId: env.GRAPH_TENANT_ID,
        displayName: ch.displayName ?? null,
      });
      count += 1;
    }
  }

  log.info("registry_teams_synced", { teams: teams.length, upserts: count });
  return count;
}

/**
 * Populate the chats table for the most-recently-active users. Graph has no
 * tenant-wide chat list, so we walk per-user chats for the top-N users by
 * last_seen_at (falling back to registered_at).
 */
export async function syncChats(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<number> {
  const users = await env.ARCADIA_DB.prepare(
    `SELECT aad_id FROM users
      ORDER BY (last_seen_at IS NULL), last_seen_at DESC, registered_at DESC
      LIMIT ?`,
  )
    .bind(CHAT_USER_BATCH)
    .all<{ aad_id: string }>();

  let count = 0;
  for (const user of users.results) {
    try {
      const { items } = await deps.graphAllPages<GraphChat>(env, {
        path: `/users/${user.aad_id}/chats`,
        query: { $top: "50", $select: "id,chatType,topic" },
      });
      for (const c of items) {
        if (!c.id) continue;
        await upsertChatRow(env, {
          chatId: c.id,
          tenantId: env.GRAPH_TENANT_ID,
          chatType: mapChatType(c.chatType),
          displayName: c.topic ?? null,
        });
        count += 1;
      }
    } catch (e) {
      // Skip users whose chats we can't read (404/403); rethrow anything else.
      if (e instanceof GraphError && (e.status === 404 || e.status === 403)) {
        log.debug("registry_user_chats_skipped", {
          aadId: user.aad_id,
          status: e.status,
        });
        continue;
      }
      throw e;
    }
  }

  log.info("registry_chats_synced", { upserts: count });
  return count;
}

// ===========================================================================
// Orchestration
// ===========================================================================

export interface RegistrySummary {
  processed: number;
  failures: number;
  detail: {
    users: number | null;
    sites: number | null;
    drives: number | null;
    teamsChannels: number | null;
    chats: number | null;
  };
}

/**
 * Run every sub-sync in order, each isolated so one failure does not abort
 * the rest. Records one ingest_runs row (source='registry') and returns the
 * summary. A null count in `detail` means that sub-sync threw.
 */
export async function syncRegistry(
  env: Env,
  log: Logger,
  deps: RegistryDeps = defaultDeps,
): Promise<RegistrySummary> {
  const startedAt = new Date().toISOString();
  const detail: RegistrySummary["detail"] = {
    users: null,
    sites: null,
    drives: null,
    teamsChannels: null,
    chats: null,
  };

  detail.users = await runSub(() => syncUsers(env, log, deps), "users", log);
  detail.sites = await runSub(() => syncSites(env, log, deps), "sites", log);
  detail.drives = await runSub(() => syncDrives(env, log, deps), "drives", log);
  detail.teamsChannels = await runSub(
    () => syncTeamsAndChannels(env, log, deps),
    "teams_channels",
    log,
  );
  detail.chats = await runSub(() => syncChats(env, log, deps), "chats", log);

  const counts = Object.values(detail);
  const processed = counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const failures = counts.filter((c) => c === null).length;
  const summary: RegistrySummary = { processed, failures, detail };

  await env.ARCADIA_DB.prepare(
    `INSERT INTO ingest_runs
       (id, source, started_at, finished_at, processed, failures, detail_json)
     VALUES (?, 'registry', ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      startedAt,
      new Date().toISOString(),
      processed,
      failures,
      JSON.stringify(detail),
    )
    .run();

  log.info("registry_synced", summary);
  return summary;
}

async function runSub(
  fn: () => Promise<number>,
  label: string,
  log: Logger,
): Promise<number | null> {
  try {
    return await fn();
  } catch (e) {
    log.error("registry_sub_failed", { sub: label, error: String(e) });
    return null;
  }
}
