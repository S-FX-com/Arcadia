// Hermes — content publishing sub-agent (Phase 1a, §4). Owns the publish
// workflow lifecycle: scheduled runs, the human approval gate, and the
// controls (kill switch, rate ceiling, draft-first). Built first because it
// exercises the whole plumbing chain on a low-stakes artifact.

import { Agent } from "agents";
import { appendAudit } from "../lib/audit";
import { checkRateCeiling, killSwitch } from "../lib/controls";
import type { PublishParams, PublishProgress } from "../schema/types";

export interface HermesState {
  lastRunAt?: string;
  lastOutcome?: string;
  lastProgress?: PublishProgress;
}

export class Hermes extends Agent<Env, HermesState> {
  initialState: HermesState = {};

  async onStart() {
    // SDK scheduling, not raw cron (§2). Cron schedules are idempotent by
    // default, so re-registering on every wake is safe. Times are UTC:
    // "0 14 * * 1-5" ≈ 9-10am America/New_York.
    const cron = this.env.HERMES_CRON ?? "0 14 * * 1-5";
    // Idempotency dedupes per expression — if HERMES_CRON changed, the old
    // row would keep firing alongside the new one. Cancel drifted rows first.
    for (const s of await this.listSchedules({ type: "cron" })) {
      if (s.callback === "runScheduledPublish" && s.type === "cron" && s.cron !== cron) {
        await this.cancelSchedule(s.id);
      }
    }
    await this.schedule(cron, "runScheduledPublish");
    // Weekly retention pass — the workflow tracking table grows unbounded.
    await this.schedule("0 3 * * 0", "pruneWorkflowHistory");
  }

  /** Wakes the instance so onStart registers schedules. Called by bootstrap cron. */
  ping(): string {
    return "ok";
  }

  async runScheduledPublish(): Promise<void> {
    const started = await this.startPublish({});
    this.setState({
      ...this.state,
      lastRunAt: new Date().toISOString(),
      lastOutcome: started.startedWorkflowId ?? started.skipped ?? "unknown",
    });
  }

  /** Manual run from the dashboard. */
  async triggerPublish(requestedTopicId: string | undefined, requestedBy: string): Promise<string> {
    const started = await this.startPublish({
      ...(requestedTopicId ? { requestedTopicId } : {}),
      requestedBy,
    });
    if (!started.startedWorkflowId) {
      throw new Error(`publish run not started: ${started.skipped}`);
    }
    return started.startedWorkflowId;
  }

  private async startPublish(
    params: PublishParams
  ): Promise<{ startedWorkflowId?: string; skipped?: string }> {
    // Kill switch is checked here AND at workflow start — a run scheduled
    // before the switch was thrown must not slip through (§4 controls).
    const ks = await killSwitch(this.env);
    if (ks.engaged) {
      await appendAudit(this.env.DB, {
        actor: "hermes",
        action: "run_skipped",
        detail: `kill switch engaged by ${ks.by ?? "unknown"}${ks.reason ? `: ${ks.reason}` : ""}`,
      });
      return { skipped: "kill_switch" };
    }
    const rate = await checkRateCeiling(this.env);
    if (rate.exceeded) {
      await appendAudit(this.env.DB, {
        actor: "hermes",
        action: "run_skipped",
        detail: `rate ceiling: ${rate.publishedToday}/${rate.perDay} today, ${rate.publishedThisWeek}/${rate.perWeek} this week`,
      });
      return { skipped: "rate_ceiling" };
    }
    // Tracking rows are updated by best-effort callbacks — refresh from the
    // Workflows API first so a dead instance can't wedge the guard forever.
    for (const wf of this.getWorkflows({ status: ["queued", "running", "waiting"] }).workflows) {
      try {
        await this.getWorkflowStatus(wf.workflowName, wf.workflowId);
      } catch {
        // instance unknown to the API — leave the row; retention will prune it
      }
    }
    const active = this.getWorkflows({ status: ["queued", "running", "waiting"] });
    if (active.workflows.length > 0) {
      await appendAudit(this.env.DB, {
        actor: "hermes",
        action: "run_skipped",
        detail: `publish workflow already active: ${active.workflows[0]?.workflowId}`,
      });
      return { skipped: "already_running" };
    }

    const workflowId = await this.runWorkflow<PublishParams>("PUBLISH_WORKFLOW", params, {
      metadata: { kind: "hermes_publish" },
    });
    await appendAudit(this.env.DB, {
      actor: params.requestedBy ?? "hermes",
      action: params.requestedBy ? "publish_run_triggered" : "publish_run_scheduled",
      workflowId,
    });
    return { startedWorkflowId: workflowId };
  }

  // -------------------------------------------------------------------------
  // Approval gate — humans decide and sign. Every decision is attributed.
  // -------------------------------------------------------------------------

  async approvePublish(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.decide(workflowId, true, email, reason);
  }

  async rejectPublish(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.decide(workflowId, false, email, reason);
  }

  private async decide(workflowId: string, approved: boolean, email: string, reason?: string): Promise<void> {
    const pending = await this.env.DB
      .prepare(`SELECT id FROM approvals WHERE workflow_id = ?1 AND status = 'pending'`)
      .bind(workflowId)
      .first<{ id: string }>();
    if (!pending) throw new Error(`no pending approval for workflow ${workflowId}`);
    const tracked = this.getWorkflow(workflowId);
    if (!tracked) throw new Error(`workflow ${workflowId} not tracked by Hermes`);

    // Event first, D1 record second: a failed send must not leave the row
    // claiming a decision the workflow never received. sendWorkflowEvent is
    // used for both outcomes so the deciding email always rides in metadata
    // (rejectWorkflow's payload has no metadata field).
    await this.sendWorkflowEvent(tracked.workflowName, workflowId, {
      type: "approval",
      payload: { approved, reason: reason ?? `${approved ? "approved" : "rejected"} by ${email}`, metadata: { email } },
    });
    await this.env.DB
      .prepare(
        `UPDATE approvals SET status = ?1, decided_by = ?2, decided_at = datetime('now')
         WHERE workflow_id = ?3 AND status = 'pending'`
      )
      .bind(approved ? "approved" : "rejected", email, workflowId)
      .run();
    await appendAudit(this.env.DB, {
      actor: email,
      action: approved ? "publish_approved" : "publish_rejected",
      workflowId,
      detail: reason,
    });
  }

  // -------------------------------------------------------------------------
  // Workflow lifecycle callbacks
  // -------------------------------------------------------------------------

  override async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    this.setState({ ...this.state, lastProgress: progress as PublishProgress });
    await super.onWorkflowProgress?.(workflowName, workflowId, progress);
  }

  override async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    // Belt-and-braces: if the D1 decision write failed after the approval
    // event was delivered, the row is still 'pending' — expire it so the
    // dashboard doesn't offer a decision on a finished workflow.
    await this.env.DB
      .prepare(`UPDATE approvals SET status = 'expired' WHERE workflow_id = ?1 AND status = 'pending'`)
      .bind(workflowId)
      .run();
    await appendAudit(this.env.DB, {
      actor: "hermes",
      action: "workflow_complete",
      workflowId,
      detail: JSON.stringify(result ?? null),
    });
  }

  override async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    // A failed or timed-out run never eats the topic: back to the queue if it
    // was waiting on a human, failed-with-error otherwise.
    await this.env.DB
      .prepare(
        `UPDATE topics SET
           status = CASE WHEN status = 'awaiting_approval' THEN 'queued' ELSE 'failed' END,
           last_error = ?1,
           workflow_id = NULL,
           updated_at = datetime('now')
         WHERE workflow_id = ?2 AND status IN ('awaiting_approval', 'in_progress')`
      )
      .bind(error.slice(0, 500), workflowId)
      .run();
    await this.env.DB
      .prepare(`UPDATE approvals SET status = 'expired' WHERE workflow_id = ?1 AND status = 'pending'`)
      .bind(workflowId)
      .run();
    await appendAudit(this.env.DB, {
      actor: "hermes",
      action: "workflow_error",
      workflowId,
      detail: error.slice(0, 500),
    });
  }

  async pruneWorkflowHistory(): Promise<void> {
    this.deleteWorkflows({
      status: ["complete", "errored", "terminated"],
      createdBefore: new Date(Date.now() - 30 * 86_400_000),
    });
  }
}
