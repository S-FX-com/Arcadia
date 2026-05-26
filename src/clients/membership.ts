// Client membership resolver.
//
// "Can this user see Client X?" reduces to a ResourceAcl check against
// resource_type='client'. The typical grant shape is
// (principal_type='group', principal_id=<m365-group-backing-the-team>),
// so Teams team membership is the source of truth and we lean on the
// group_membership cache already refreshed by acl/group-membership.ts.
//
// Admins (users.is_admin = 1) bypass — they always see every Client.

import type { Env } from "../env";
import { ResourceAcl } from "../acl/resource-acl";
import type { AccessContext } from "../acl/types";
import { ClientStore } from "./store";
import type { Client } from "./types";

export class ClientMembership {
  private readonly acl: ResourceAcl;
  private readonly store: ClientStore;
  constructor(private readonly env: Env) {
    this.acl = new ResourceAcl(env);
    this.store = new ClientStore(env);
  }

  async canAccess(clientId: string, ctx: AccessContext): Promise<boolean> {
    if (await this.isAdmin(ctx.viewerAadId)) return true;
    return this.acl.canAccess("client", clientId, ctx);
  }

  /** All active Clients visible to this viewer, alphabetical by display name. */
  async listForViewer(ctx: AccessContext): Promise<Client[]> {
    const all = await this.store.list("active");
    if (all.length === 0) return [];

    if (await this.isAdmin(ctx.viewerAadId)) return all;

    const candidates = all.map((c) => ({
      resourceType: "client" as const,
      resourceId: c.id,
    }));
    const allowed = await this.acl.filterAccessible(candidates, ctx);
    const allowedIds = new Set(allowed.map((a) => a.resourceId));
    return all.filter((c) => allowedIds.has(c.id));
  }

  async grantUser(clientId: string, userAadId: string): Promise<void> {
    await this.acl.grant("client", clientId, {
      type: "user",
      id: userAadId,
    });
  }

  async grantGroup(clientId: string, groupId: string): Promise<void> {
    await this.acl.grant("client", clientId, {
      type: "group",
      id: groupId,
    });
  }

  async revokeUser(clientId: string, userAadId: string): Promise<void> {
    await this.acl.revoke("client", clientId, {
      type: "user",
      id: userAadId,
    });
  }

  async revokeGroup(clientId: string, groupId: string): Promise<void> {
    await this.acl.revoke("client", clientId, {
      type: "group",
      id: groupId,
    });
  }

  async grantsFor(clientId: string) {
    return this.acl.principalsFor("client", clientId);
  }

  async isAdmin(aadId: string): Promise<boolean> {
    if (aadId && aadId === this.env.ADMIN_USER_AAD_ID) return true;
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT is_admin FROM users WHERE aad_id = ?`,
    )
      .bind(aadId)
      .first<{ is_admin: number }>();
    return row?.is_admin === 1;
  }
}
