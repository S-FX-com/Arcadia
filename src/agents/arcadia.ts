// Arcadia — root agent. She surfaces and attributes; humans decide and sign.
// Phase 1a scope: doctrine staging → ratification plumbing and a status
// surface for the dashboard. Ask Arcadia (Teams) arrives in Phase 2.

import { Agent } from "agents";
import { appendAudit } from "../lib/audit";
import { checkRateCeiling, killSwitch, type KillSwitchState, type RateCheck } from "../lib/controls";
import { DOCTRINE_STAGING } from "../memory/driver";
import { SelfHostedMemoryDriver } from "../memory/self-hosted";
import type { RatifyParams } from "../schema/types";

export interface ArcadiaState {
  lastStatusAt?: string;
}

export interface ArcadiaStatus {
  killSwitch: KillSwitchState;
  rate: RateCheck;
  pendingApprovals: number;
}

export class Arcadia extends Agent<Env, ArcadiaState> {
  initialState: ArcadiaState = {};

  ping(): string {
    return "ok";
  }

  async getStatus(): Promise<ArcadiaStatus> {
    const pending = await this.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)
      .first<{ n: number }>();
    return {
      killSwitch: await killSwitch(this.env),
      rate: await checkRateCeiling(this.env),
      pendingApprovals: pending?.n ?? 0,
    };
  }

  /**
   * Capture a doctrine candidate: auto-write to staging, then open a
   * ratification workflow. Doctrine never auto-commits (§5.6.1) — the
   * candidate reaches canonical only through a human tap.
   */
  async proposeDoctrine(
    content: string,
    proposedBy: string,
    source?: string
  ): Promise<{ stagingMemoryId: string; workflowId: string }> {
    const driver = new SelfHostedMemoryDriver(this.env);
    const staging = await driver.getProfile(DOCTRINE_STAGING);
    const memory = await staging.remember({ content, sessionId: source ?? "manual" });
    const workflowId = await this.runWorkflow<RatifyParams>(
      "RATIFY_WORKFLOW",
      { stagingMemoryId: memory.id, proposedBy },
      { metadata: { kind: "doctrine_ratify" } }
    );
    await appendAudit(this.env.DB, {
      actor: proposedBy,
      action: "doctrine_proposed",
      subject: memory.id,
      workflowId,
      detail: content.slice(0, 300),
    });
    return { stagingMemoryId: memory.id, workflowId };
  }

  async approveRatify(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.recordDecision(workflowId, "approved", email, reason);
    await this.approveWorkflow(workflowId, {
      reason: reason ?? `ratified by ${email}`,
      metadata: { email },
    });
  }

  async rejectRatify(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.recordDecision(workflowId, "rejected", email, reason);
    await this.rejectWorkflow(workflowId, { reason: reason ?? `rejected by ${email}` });
  }

  private async recordDecision(
    workflowId: string,
    status: "approved" | "rejected",
    email: string,
    reason?: string
  ): Promise<void> {
    const res = await this.env.DB
      .prepare(
        `UPDATE approvals SET status = ?1, decided_by = ?2, decided_at = datetime('now')
         WHERE workflow_id = ?3 AND status = 'pending'`
      )
      .bind(status, email, workflowId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      throw new Error(`no pending approval for workflow ${workflowId}`);
    }
    await appendAudit(this.env.DB, {
      actor: email,
      action: `doctrine_${status}`,
      workflowId,
      detail: reason,
    });
  }

  /** Ask Arcadia ships in Phase 2 with the memory core (§4). */
  async ask(_question: string): Promise<never> {
    throw new Error("Ask Arcadia arrives in Phase 2 — the memory core is not live yet");
  }

  override async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    await this.env.DB
      .prepare(`UPDATE approvals SET status = 'expired' WHERE workflow_id = ?1 AND status = 'pending'`)
      .bind(workflowId)
      .run();
    await appendAudit(this.env.DB, {
      actor: "arcadia",
      action: "workflow_error",
      workflowId,
      detail: error.slice(0, 500),
    });
  }
}
