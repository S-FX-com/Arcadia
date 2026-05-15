// Per-resource ACL grants.
//
// Two query shapes:
//
//   canAccess(env, resourceType, resourceId, viewer)
//     Is the viewer authorised to see this resource?
//
//   filterAccessible(env, viewer, candidates)
//     Pre-filter a batch of (type, id) pairs in one round-trip.
//
// Strict mode rules:
//
//   1. If the resource has zero ACL rows, it's open inside the tenant
//      — anyone whose tenantId matches the viewer's. (This keeps
//      day-zero deployments usable; explicit grants override.)
//
//   2. If any row matches the viewer directly (principal_type='user'
//      AND principal_id=viewer), allow.
//
//   3. If any row is (tenant, viewer.tenantId), allow.
//
//   4. For each (group, group_id) row, consult group_membership; if
//      the viewer is a member, allow.
//
//   5. Otherwise deny.

import type { Env } from "../env";
import type {
  AccessContext,
  Grant,
  Principal,
  ResourceType,
} from "./types";

export class ResourceAcl {
  constructor(private readonly env: Env) {}

  async grant(
    resourceType: ResourceType | string,
    resourceId: string,
    principal: Principal,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `INSERT OR REPLACE INTO resource_acl
         (resource_type, resource_id, principal_type, principal_id, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        resourceType,
        resourceId,
        principal.type,
        principal.id,
        new Date().toISOString(),
      )
      .run();
  }

  async revoke(
    resourceType: ResourceType | string,
    resourceId: string,
    principal: Principal,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `DELETE FROM resource_acl
        WHERE resource_type = ? AND resource_id = ?
          AND principal_type = ? AND principal_id = ?`,
    )
      .bind(resourceType, resourceId, principal.type, principal.id)
      .run();
  }

  async principalsFor(
    resourceType: ResourceType | string,
    resourceId: string,
  ): Promise<Grant[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT principal_type, principal_id, granted_at
         FROM resource_acl
        WHERE resource_type = ? AND resource_id = ?`,
    )
      .bind(resourceType, resourceId)
      .all<{
        principal_type: string;
        principal_id: string;
        granted_at: string;
      }>();

    return rows.results.map((r) => ({
      resourceType,
      resourceId,
      principal: {
        type: r.principal_type as Principal["type"],
        id: r.principal_id,
      },
      grantedAt: r.granted_at,
    }));
  }

  async canAccess(
    resourceType: ResourceType | string,
    resourceId: string,
    ctx: AccessContext,
  ): Promise<boolean> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT principal_type, principal_id FROM resource_acl
        WHERE resource_type = ? AND resource_id = ?`,
    )
      .bind(resourceType, resourceId)
      .all<{ principal_type: string; principal_id: string }>();

    // Empty ACL = open within tenant.
    if (rows.results.length === 0) return true;

    const groupIds: string[] = [];
    for (const r of rows.results) {
      if (r.principal_type === "user" && r.principal_id === ctx.viewerAadId)
        return true;
      if (r.principal_type === "tenant" && r.principal_id === ctx.tenantId)
        return true;
      if (r.principal_type === "group") groupIds.push(r.principal_id);
    }

    if (groupIds.length === 0) return false;
    return isMemberOfAny(this.env, groupIds, ctx.viewerAadId);
  }

  /** Bulk-filter a candidate list down to what `ctx.viewerAadId` can see. */
  async filterAccessible<T extends { resourceType: string; resourceId: string }>(
    candidates: T[],
    ctx: AccessContext,
  ): Promise<T[]> {
    if (candidates.length === 0) return [];

    // Build map of (type|id) -> grants for the candidate set.
    const grants = await this.bulkGrants(candidates);
    const groupCache = new Map<string, boolean>();
    const out: T[] = [];

    for (const c of candidates) {
      const key = `${c.resourceType}|${c.resourceId}`;
      const list = grants.get(key) ?? [];
      if (list.length === 0) {
        out.push(c);
        continue;
      }

      let allow = false;
      const candidateGroupIds: string[] = [];
      for (const g of list) {
        if (g.type === "user" && g.id === ctx.viewerAadId) {
          allow = true;
          break;
        }
        if (g.type === "tenant" && g.id === ctx.tenantId) {
          allow = true;
          break;
        }
        if (g.type === "group") candidateGroupIds.push(g.id);
      }

      if (!allow && candidateGroupIds.length > 0) {
        for (const gid of candidateGroupIds) {
          const cached = groupCache.get(gid);
          if (cached === true) {
            allow = true;
            break;
          }
          if (cached === false) continue;
          const member = await isMemberOf(this.env, gid, ctx.viewerAadId);
          groupCache.set(gid, member);
          if (member) {
            allow = true;
            break;
          }
        }
      }

      if (allow) out.push(c);
    }
    return out;
  }

  private async bulkGrants(
    candidates: { resourceType: string; resourceId: string }[],
  ): Promise<Map<string, Principal[]>> {
    // Group by resourceType so we can run one query per type with an
    // IN-list of ids. Each D1 query has a parameter limit; chunking to
    // 100 ids per query is conservative.
    const byType = new Map<string, Set<string>>();
    for (const c of candidates) {
      let set = byType.get(c.resourceType);
      if (!set) {
        set = new Set<string>();
        byType.set(c.resourceType, set);
      }
      set.add(c.resourceId);
    }

    const out = new Map<string, Principal[]>();

    for (const [type, idSet] of byType) {
      const ids = [...idSet];
      const chunkSize = 100;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = await this.env.ARCADIA_DB.prepare(
          `SELECT resource_id, principal_type, principal_id
             FROM resource_acl
            WHERE resource_type = ? AND resource_id IN (${placeholders})`,
        )
          .bind(type, ...chunk)
          .all<{
            resource_id: string;
            principal_type: string;
            principal_id: string;
          }>();

        for (const r of rows.results) {
          const key = `${type}|${r.resource_id}`;
          let list = out.get(key);
          if (!list) {
            list = [];
            out.set(key, list);
          }
          list.push({
            type: r.principal_type as Principal["type"],
            id: r.principal_id,
          });
        }
      }
    }

    return out;
  }
}

async function isMemberOf(
  env: Env,
  groupId: string,
  memberAadId: string,
): Promise<boolean> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM group_membership
      WHERE group_id = ? AND member_aad_id = ? LIMIT 1`,
  )
    .bind(groupId, memberAadId)
    .first<{ x: number }>();
  return row !== null;
}

async function isMemberOfAny(
  env: Env,
  groupIds: string[],
  memberAadId: string,
): Promise<boolean> {
  if (groupIds.length === 0) return false;
  const placeholders = groupIds.map(() => "?").join(",");
  const row = await env.ARCADIA_DB.prepare(
    `SELECT 1 AS x FROM group_membership
      WHERE member_aad_id = ?
        AND group_id IN (${placeholders})
      LIMIT 1`,
  )
    .bind(memberAadId, ...groupIds)
    .first<{ x: number }>();
  return row !== null;
}
