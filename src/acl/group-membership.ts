// AAD group membership cache + refresh.
//
// The cache lives in the `group_membership` table. ACL checks read
// from there hot; this module owns the cold-path refresh that walks
// Microsoft Graph's transitiveMembers and reconciles the table.
//
// `refresh(env)` runs on the "0 */6 * * *" cron (see
// runtime/cron-dispatcher.ts). It refreshes every group that is
// referenced in resource_acl plus any explicitly tracked group. For
// each, it pulls /groups/{id}/transitiveMembers in pages, replaces
// the cached membership, and stamps refreshed_at.
//
// Group membership is intentionally idempotent: every refresh tears
// down the existing row set for that group and replaces it. There's no
// partial-state risk because resource_acl checks tolerate stale data
// up to ~6h.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { graph } from "../graph/client";

export interface GroupRefreshResult {
  groupsRefreshed: number;
  membersWritten: number;
  failures: number;
}

interface MemberPage {
  value: { id: string; "@odata.type"?: string }[];
  "@odata.nextLink"?: string;
}

export class GroupMembership {
  constructor(private readonly env: Env) {}

  async isMember(groupId: string, memberAadId: string): Promise<boolean> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT 1 AS x FROM group_membership
        WHERE group_id = ? AND member_aad_id = ? LIMIT 1`,
    )
      .bind(groupId, memberAadId)
      .first<{ x: number }>();
    return row !== null;
  }

  async groupsOf(memberAadId: string): Promise<string[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT group_id FROM group_membership WHERE member_aad_id = ?`,
    )
      .bind(memberAadId)
      .all<{ group_id: string }>();
    return rows.results.map((r) => r.group_id);
  }

  async membersOf(groupId: string): Promise<string[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT member_aad_id FROM group_membership WHERE group_id = ?`,
    )
      .bind(groupId)
      .all<{ member_aad_id: string }>();
    return rows.results.map((r) => r.member_aad_id);
  }
}

export async function refreshGroupMembership(
  env: Env,
  log: Logger,
): Promise<GroupRefreshResult> {
  const groupRows = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT principal_id AS group_id FROM resource_acl
      WHERE principal_type = 'group'`,
  ).all<{ group_id: string }>();

  const result: GroupRefreshResult = {
    groupsRefreshed: 0,
    membersWritten: 0,
    failures: 0,
  };

  for (const r of groupRows.results) {
    try {
      const written = await refreshOne(env, r.group_id, log);
      result.membersWritten += written;
      result.groupsRefreshed += 1;
    } catch (e) {
      result.failures += 1;
      log.warn("group_refresh_failed", {
        groupId: r.group_id,
        error: String(e),
      });
    }
  }

  log.info("group_refresh", result);
  return result;
}

async function refreshOne(
  env: Env,
  groupId: string,
  _log: Logger,
): Promise<number> {
  const members: string[] = [];
  let nextUrl: string | undefined;
  do {
    const page: MemberPage = nextUrl
      ? await graph<MemberPage>(env, { path: nextUrl })
      : await graph<MemberPage>(env, {
          path: `/groups/${groupId}/transitiveMembers/microsoft.graph.user`,
          query: { $top: 100, $select: "id" },
        });
    for (const m of page.value) {
      if (m.id) members.push(m.id);
    }
    nextUrl = page["@odata.nextLink"];
  } while (nextUrl);

  await env.ARCADIA_DB.prepare(
    `DELETE FROM group_membership WHERE group_id = ?`,
  )
    .bind(groupId)
    .run();

  const now = new Date().toISOString();
  // Chunk inserts so we don't hit D1's per-statement parameter limit.
  const chunkSize = 100;
  for (let i = 0; i < members.length; i += chunkSize) {
    const chunk = members.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "(?, ?, ?)").join(",");
    const binds: string[] = [];
    for (const m of chunk) {
      binds.push(groupId, m, now);
    }
    await env.ARCADIA_DB.prepare(
      `INSERT OR REPLACE INTO group_membership (group_id, member_aad_id, refreshed_at)
       VALUES ${placeholders}`,
    )
      .bind(...binds)
      .run();
  }

  return members.length;
}
