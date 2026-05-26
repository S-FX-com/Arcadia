// Per-user active Client.
//
// Reads + writes users.active_client_id with entitlement enforcement
// at the seam: a user can only switch to a Client they're a member of.

import type { Env } from "../env";
import type { AccessContext } from "../acl/types";
import { ClientMembership } from "./membership";

export class ActiveClient {
  private readonly membership: ClientMembership;
  constructor(private readonly env: Env) {
    this.membership = new ClientMembership(env);
  }

  async get(aadId: string): Promise<string | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT active_client_id FROM users WHERE aad_id = ?`,
    )
      .bind(aadId)
      .first<{ active_client_id: string | null }>();
    return row?.active_client_id ?? null;
  }

  /**
   * Set the active Client for a user. The caller must already be
   * authorised — for normal users, pass their own aadId and a clientId
   * the user can see. For admin overrides (admin sets another user's
   * active Client) bypass entitlement by passing { bypassEntitlement: true }.
   */
  async set(
    aadId: string,
    clientId: string | null,
    ctx: AccessContext,
    opts: { bypassEntitlement?: boolean } = {},
  ): Promise<void> {
    if (clientId !== null && !opts.bypassEntitlement) {
      const allowed = await this.membership.canAccess(clientId, ctx);
      if (!allowed) throw new Error("forbidden");
    }
    await this.upsertUser(aadId, ctx.tenantId);
    await this.env.ARCADIA_DB.prepare(
      `UPDATE users SET active_client_id = ? WHERE aad_id = ?`,
    )
      .bind(clientId, aadId)
      .run();
  }

  async clear(aadId: string): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `UPDATE users SET active_client_id = NULL WHERE aad_id = ?`,
    )
      .bind(aadId)
      .run();
  }

  /**
   * Ensure a users row exists so the UPDATE actually targets a row.
   * Session callers might be hitting the system before ingest has seen
   * them. A minimal row is enough for the active-client pointer.
   */
  private async upsertUser(
    aadId: string,
    tenantId: string | undefined,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO users (aad_id, tenant_id) VALUES (?, ?)`,
    )
      .bind(aadId, tenantId ?? "")
      .run();
  }
}
