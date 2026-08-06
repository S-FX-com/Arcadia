// D1-backed ApprovalQueue (Cloudflare OS gatekeeper semantics, §types.ts).
//
// Observations append to gk_observations and are awaited before any data
// returns to the caller. Actions land in gk_actions as 'pending' and move
// through decided → applied only with recorded authorization — a live side
// effect without a named human behind it never leaves this file. Both tables
// are append-mostly and queryable from the dashboard, so what Arcadia read
// and did on whose behalf is reviewable after the fact, exactly like the OS
// Gatekeeper action log.

import type {
  ActionAuthorization,
  ActionDescription,
  ApprovalQueue,
  GatekeeperContext,
  ObservationDescription,
} from "./types";
import { GatekeeperDeniedError } from "./types";

export class D1GatekeeperQueue implements ApprovalQueue {
  constructor(
    private readonly db: D1Database,
    /** Which gatekeeper this queue serves: 'wordpress' | 'graph' | …. */
    readonly gatekeeper: string,
    /** The single scoped resource the session was minted for. */
    readonly resource: string,
    readonly ctx: GatekeeperContext
  ) {}

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    // Single-tenant staff surface: no observation is blocked today, but every
    // one is on the record BEFORE data flows. When an OS deployment fronts
    // Arcadia, its observer checks slot in here.
    await this.db
      .prepare(
        `INSERT INTO gk_observations (gatekeeper, resource, session_id, actor, title, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        this.gatekeeper,
        this.resource,
        this.ctx.sessionId,
        this.ctx.actor,
        description.title.slice(0, 200),
        description.description.slice(0, 1000)
      )
      .run();
  }

  /** Stable per-session action id — retry-safe inside durable workflow steps. */
  private actionId(actionKey: string): string {
    return `${this.ctx.sessionId}#${actionKey}`;
  }

  async submitAction(actionKey: string, description: ActionDescription): Promise<void> {
    // INSERT OR IGNORE: a retried workflow step re-submits the same key and
    // must not duplicate the row or reset an already-decided action.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO gk_actions
           (id, gatekeeper, resource, session_id, actor, action_kind, title, detail, auto_approvable)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        this.actionId(actionKey),
        this.gatekeeper,
        this.resource,
        this.ctx.sessionId,
        this.ctx.actor,
        description.actionKind?.tag ?? "unclassified",
        description.title.slice(0, 200),
        description.description.slice(0, 1000),
        description.autoApprovable ? 1 : 0
      )
      .run();
  }

  /**
   * Record the decision that authorizes a submitted action. Auto-approvable
   * actions (not client-visible: drafts, memory facts) pass with no evidence;
   * anything else must carry ActionAuthorization or the action stays pending
   * — visible on the dashboard as blocked — and this throws.
   */
  async recordDecision(actionKey: string, authorization?: ActionAuthorization): Promise<void> {
    const id = this.actionId(actionKey);
    const row = await this.db
      .prepare(`SELECT status, auto_approvable FROM gk_actions WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; auto_approvable: number }>();
    if (!row) {
      throw new GatekeeperDeniedError(`action ${id} was never submitted`, this.gatekeeper);
    }
    if (row.status === "applied" || row.status === "approved") return; // retry of a decided action
    if (!authorization && row.auto_approvable !== 1) {
      throw new GatekeeperDeniedError(
        `action ${id} requires recorded human authorization and none was provided`,
        this.gatekeeper
      );
    }
    const decidedBy =
      authorization?.kind === "human_approval"
        ? authorization.decidedBy
        : authorization?.kind === "dispatch_rule"
          ? authorization.onBehalfOf
          : null;
    await this.db
      .prepare(
        `UPDATE gk_actions
            SET status = 'approved', auth_evidence = ?2, decided_by = ?3, decided_at = datetime('now')
          WHERE id = ?1 AND status = 'pending'`
      )
      .bind(id, JSON.stringify(authorization ?? { kind: "auto_approvable" }), decidedBy)
      .run();
  }

  async recordApplied(actionKey: string, result: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE gk_actions SET status = 'applied', result = ?2, applied_at = datetime('now')
          WHERE id = ?1 AND status = 'approved'`
      )
      .bind(this.actionId(actionKey), result.slice(0, 500))
      .run();
  }

  async recordFailed(actionKey: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE gk_actions SET status = 'failed', result = ?2
          WHERE id = ?1 AND status IN ('pending', 'approved')`
      )
      .bind(this.actionId(actionKey), error.slice(0, 500))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Dashboard queries.
// ---------------------------------------------------------------------------

export interface ObservationRow {
  seq: number;
  gatekeeper: string;
  resource: string;
  session_id: string;
  actor: string;
  title: string;
  detail: string | null;
  created_at: string;
}

export interface ActionRow {
  id: string;
  gatekeeper: string;
  resource: string;
  actor: string;
  action_kind: string;
  title: string;
  status: string;
  decided_by: string | null;
  result: string | null;
  created_at: string;
}

export async function recentObservations(db: D1Database, limit = 30): Promise<ObservationRow[]> {
  const res = await db
    .prepare(`SELECT * FROM gk_observations ORDER BY seq DESC LIMIT ?1`)
    .bind(limit)
    .all<ObservationRow>();
  return res.results;
}

export async function recentActions(db: D1Database, limit = 30): Promise<ActionRow[]> {
  const res = await db
    .prepare(
      `SELECT id, gatekeeper, resource, actor, action_kind, title, status, decided_by, result, created_at
         FROM gk_actions ORDER BY created_at DESC LIMIT ?1`
    )
    .bind(limit)
    .all<ActionRow>();
  return res.results;
}

/** Actions submitted but never authorized — enforcement working, not noise. */
export async function blockedActions(db: D1Database): Promise<ActionRow[]> {
  const res = await db
    .prepare(
      `SELECT id, gatekeeper, resource, actor, action_kind, title, status, decided_by, result, created_at
         FROM gk_actions WHERE status IN ('pending', 'failed') ORDER BY created_at DESC LIMIT 25`
    )
    .all<ActionRow>();
  return res.results;
}
