// Dispatcher — next-action dispatch and escalation enforcement (§4 Phase 3).
//
// Two jobs:
//  1. Dispatch: when work is marked done, the next task is offered
//     immediately, matched on skill and priority. If someone has no
//     assignment for more than 4 working hours, the LEAD gets pinged — not
//     the person. Staff sitting idle is a management failure, not a personal
//     one, and the ping goes where the fix is.
//  2. Enforcement: stages cannot be skipped, each has an SLA whose breach
//     escalates to that reviewer's lead, reviewer approval is a signed
//     certification, and a stage that rubber-stamps gets flagged as
//     ineffective.
//
// Deliberately last in the build order — Arcadia needs a proven memory layer
// before she is trusted to route people.

import { Agent, getAgentByName } from "agents";
import { notify } from "../integrations/notify";
import { appendAudit } from "../lib/audit";
import { canAdvance, hoursSince, nextStage, stageByKey, STAGES } from "../dispatch/stages";

const IDLE_HOURS_LIMIT = 4;

interface AssignableRow {
  id: string;
  title: string;
  priority: number;
  required_skills: string;
  project_id: string | null;
}

interface StaffRow {
  email: string;
  skills: string;
  lead_email: string | null;
}

export interface DispatchOffer {
  taskId: string;
  title: string;
  matchedSkills: string[];
}

export class Dispatcher extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  async onStart() {
    // Hourly during the working day: idle checks and SLA sweeps.
    await this.schedule("0 12-22 * * 1-5", "sweep");
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Offer the next task to a person, matched on skill then priority. Offering
   * is not assigning: Arcadia surfaces the best next action and the human
   * takes it (§1).
   */
  async offerNext(email: string): Promise<DispatchOffer | undefined> {
    const staff = await this.env.DB.prepare(
      `SELECT email, skills, lead_email FROM users WHERE lower(email) = ?1 AND active = 1`
    )
      .bind(email.toLowerCase())
      .first<StaffRow>();
    if (!staff) return undefined;
    const skills = new Set<string>(this.parseArray(staff.skills).map((s) => s.toLowerCase()));

    const candidates = (
      await this.env.DB.prepare(
        `SELECT id, title, priority, required_skills, project_id FROM work_items
          WHERE status = 'ready' AND (assigned_to IS NULL OR lower(assigned_to) = ?1)
          ORDER BY priority DESC, created_at ASC
          LIMIT 25`
      )
        .bind(email.toLowerCase())
        .all<AssignableRow>()
    ).results;

    let best: { row: AssignableRow; matched: string[] } | undefined;
    for (const row of candidates) {
      const required = this.parseArray(row.required_skills).map((s) => s.toLowerCase());
      const matched = required.filter((r) => skills.has(r));
      // Every required skill must be covered; among those, highest priority
      // wins (the query is already priority-ordered, so first match is best).
      if (required.length === 0 || matched.length === required.length) {
        best = { row, matched };
        break;
      }
    }
    if (!best) return undefined;

    await this.env.DB.prepare(
      `UPDATE work_items SET status = 'offered', assigned_to = ?2, offered_at = datetime('now'),
         updated_at = datetime('now') WHERE id = ?1`
    )
      .bind(best.row.id, email.toLowerCase())
      .run();
    await appendAudit(this.env.DB, {
      actor: "dispatcher",
      action: "task_offered",
      subject: email,
      detail: `${best.row.title} (priority ${best.row.priority})`,
    });
    return { taskId: best.row.id, title: best.row.title, matchedSkills: best.matched };
  }

  /** Marking work done immediately offers the next thing. */
  async completeAndDispatch(taskId: string, email: string): Promise<DispatchOffer | undefined> {
    await this.env.DB.prepare(
      `UPDATE work_items SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?1 AND lower(assigned_to) = ?2`
    )
      .bind(taskId, email.toLowerCase())
      .run();
    await appendAudit(this.env.DB, { actor: email, action: "task_completed", subject: taskId });
    return this.offerNext(email);
  }

  // -------------------------------------------------------------------------
  // Enforcement
  // -------------------------------------------------------------------------

  /**
   * Advance work to the next stage. Refuses skipped stages, requires the
   * stage's checklist to have been signed, and records how long the review
   * actually took so pass-through detection has something to measure.
   */
  async advance(
    workItemId: string,
    toStage: string,
    reviewer: string
  ): Promise<{ advanced: boolean; reason?: string }> {
    const item = await this.env.DB.prepare(
      `SELECT id, title, stage, stage_entered_at, project_id FROM work_items WHERE id = ?1`
    )
      .bind(workItemId)
      .first<{ id: string; title: string; stage: string; stage_entered_at: string; project_id: string | null }>();
    if (!item) return { advanced: false, reason: "work item not found" };

    const check = canAdvance(item.stage, toStage);
    if (!check.ok) {
      await appendAudit(this.env.DB, {
        actor: reviewer,
        action: "stage_skip_refused",
        subject: workItemId,
        detail: `${item.stage} → ${toStage}: ${check.reason}`,
      });
      return { advanced: false, ...(check.reason ? { reason: check.reason } : {}) };
    }

    const current = stageByKey(item.stage);
    // Reviewer approval is itself a signed certification (§4 Phase 3): the
    // stage cannot be left until the checklist that gates it is signed.
    if (current?.checklist) {
      const signed = await this.env.DB.prepare(
        `SELECT id FROM certifications WHERE checklist = ?1 AND stage = ?2
           AND (project_id IS ?3 OR project_id = ?3) AND lower(signed_by) = ?4
         ORDER BY signed_at DESC LIMIT 1`
      )
        .bind(current.checklist, item.stage, item.project_id, reviewer.toLowerCase())
        .first<{ id: string }>();
      if (!signed) {
        return {
          advanced: false,
          reason: `${current.label} requires you to sign the ${current.checklist} checklist before this can advance`,
        };
      }
    }

    const heldSeconds = Math.max(0, Math.round((Date.now() - Date.parse(item.stage_entered_at)) / 1000));
    await this.env.DB.prepare(
      `INSERT INTO stage_transitions (id, work_item_id, from_stage, to_stage, reviewer, held_seconds)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(crypto.randomUUID(), workItemId, item.stage, toStage, reviewer.toLowerCase(), heldSeconds)
      .run();
    await this.env.DB.prepare(
      `UPDATE work_items SET stage = ?2, stage_entered_at = datetime('now'), sla_escalated = 0,
         updated_at = datetime('now') WHERE id = ?1`
    )
      .bind(workItemId, toStage)
      .run();
    await appendAudit(this.env.DB, {
      actor: reviewer,
      action: "stage_advanced",
      subject: workItemId,
      detail: `${item.stage} → ${toStage} after ${heldSeconds}s`,
    });

    if (current && heldSeconds < current.minReviewSeconds) {
      await this.flagPassThrough(current.key, reviewer, workItemId, heldSeconds);
    }
    return { advanced: true };
  }

  /**
   * Pass-through detection (§4 Phase 3): a stage that approves in under N
   * seconds, or approves work that later fails downstream, is ineffective.
   * This is the direct instrument for a QA gate that forwards instead of
   * filters.
   */
  private async flagPassThrough(
    stage: string,
    reviewer: string,
    workItemId: string,
    heldSeconds: number
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO pass_through_flags (id, stage, reviewer, work_item_id, reason, detail)
       VALUES (?1, ?2, ?3, ?4, 'fast_approval', ?5)`
    )
      .bind(
        crypto.randomUUID(),
        stage,
        reviewer.toLowerCase(),
        workItemId,
        `approved in ${heldSeconds}s, under the ${stageByKey(stage)?.minReviewSeconds ?? 0}s floor for a real review`
      )
      .run();
    await appendAudit(this.env.DB, {
      actor: "dispatcher",
      action: "pass_through_flagged",
      subject: reviewer,
      detail: `${stage} approved ${workItemId} in ${heldSeconds}s`,
    });
  }

  /**
   * Work that failed downstream implicates every stage that passed it. The
   * earlier gates approved something that later broke — that is the second
   * pass-through signal, and it is the more damning one.
   */
  async recordDownstreamFailure(workItemId: string, detail: string): Promise<void> {
    const transitions = (
      await this.env.DB.prepare(
        `SELECT from_stage, reviewer FROM stage_transitions WHERE work_item_id = ?1 ORDER BY created_at`
      )
        .bind(workItemId)
        .all<{ from_stage: string; reviewer: string }>()
    ).results;
    for (const t of transitions) {
      await this.env.DB.prepare(
        `INSERT INTO pass_through_flags (id, stage, reviewer, work_item_id, reason, detail)
         VALUES (?1, ?2, ?3, ?4, 'downstream_failure', ?5)`
      )
        .bind(crypto.randomUUID(), t.from_stage, t.reviewer, workItemId, detail.slice(0, 500))
        .run();
    }
    await appendAudit(this.env.DB, {
      actor: "dispatcher",
      action: "downstream_failure",
      subject: workItemId,
      detail: `${detail.slice(0, 300)} — implicates ${transitions.length} prior stage(s)`,
    });
  }

  /** Ineffectiveness per reviewer per stage, for the founder digest. */
  async passThroughRates(): Promise<
    Array<{ stage: string; reviewer: string; approvals: number; flags: number; rate: number }>
  > {
    const rows = (
      await this.env.DB.prepare(
        `SELECT t.from_stage AS stage, t.reviewer,
                COUNT(*) AS approvals,
                (SELECT COUNT(*) FROM pass_through_flags f
                  WHERE f.reviewer = t.reviewer AND f.stage = t.from_stage) AS flags
           FROM stage_transitions t
          GROUP BY t.from_stage, t.reviewer
          ORDER BY flags DESC`
      ).all<{ stage: string; reviewer: string; approvals: number; flags: number }>()
    ).results;
    return rows.map((r) => ({
      ...r,
      rate: r.approvals > 0 ? r.flags / r.approvals : 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Sweep: idle staff and SLA breaches
  // -------------------------------------------------------------------------

  async sweep(): Promise<{ idlePinged: number; slaBreached: number }> {
    let idlePinged = 0;
    let slaBreached = 0;

    // Idle staff: no assignment for more than 4 working hours pings the LEAD.
    const idle = (
      await this.env.DB.prepare(
        `SELECT u.email, u.lead_email, u.pod,
                (SELECT MAX(COALESCE(w.offered_at, w.completed_at)) FROM work_items w
                  WHERE lower(w.assigned_to) = lower(u.email)) AS last_touch
           FROM users u
          WHERE u.active = 1 AND u.role = 'specialist'`
      ).all<{ email: string; lead_email: string | null; pod: string | null; last_touch: string | null }>()
    ).results;

    for (const person of idle) {
      const open = await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM work_items
          WHERE lower(assigned_to) = lower(?1) AND status IN ('offered','in_progress')`
      )
        .bind(person.email)
        .first<{ n: number }>();
      if ((open?.n ?? 0) > 0) continue;

      const idleHours = person.last_touch ? hoursSince(person.last_touch) : Number.POSITIVE_INFINITY;
      if (idleHours < IDLE_HOURS_LIMIT) continue;

      // Try to offer something before escalating — surfacing work beats
      // reporting idleness.
      const offer = await this.offerNext(person.email);
      if (offer) continue;

      const lead = person.lead_email;
      await notify(this.env, {
        kind: "dispatch",
        subject: `${person.email} has had no assignment for ${Number.isFinite(idleHours) ? Math.floor(idleHours) : "over 4"} hours`,
        body: `${person.email} has no open assignment and there is nothing in the queue matching their skills.\n\nThis goes to you, not to them: staff sitting idle without explicit instruction is a management gap, not a personal failing. Give them the next thing.`,
        owner: lead ?? undefined,
        lead: lead ?? undefined,
        pod: person.pod ?? undefined,
        to: lead ? [lead] : [],
        publicBoard: false,
      });
      idlePinged++;
    }

    // SLA breaches escalate to the REVIEWER's lead.
    const inReview = (
      await this.env.DB.prepare(
        `SELECT id, title, stage, stage_entered_at, assigned_to FROM work_items
          WHERE status IN ('offered','in_progress') AND sla_escalated = 0 AND stage != 'development'`
      ).all<{ id: string; title: string; stage: string; stage_entered_at: string; assigned_to: string | null }>()
    ).results;

    for (const item of inReview) {
      const stage = stageByKey(item.stage);
      if (!stage || stage.slaHours === 0) continue;
      const held = hoursSince(item.stage_entered_at);
      if (held < stage.slaHours) continue;

      const reviewer = await this.reviewerFor(stage.reviewerRole);
      const reviewerLead = reviewer
        ? (
            await this.env.DB.prepare(`SELECT lead_email FROM users WHERE lower(email) = ?1`)
              .bind(reviewer.toLowerCase())
              .first<{ lead_email: string | null }>()
          )?.lead_email
        : null;

      await notify(this.env, {
        kind: "sla_breach",
        subject: `SLA breach: "${item.title}" has sat at ${stage.label} for ${Math.floor(held)}h (limit ${stage.slaHours}h)`,
        body: `"${item.title}" entered ${stage.label} at ${item.stage_entered_at} and has not moved.\n\nReviewer: ${reviewer ?? "unassigned"}\nEscalated to: ${reviewerLead ?? "no lead on record"}\n\nThe breach is the reviewer's, so it goes to their lead. Next stage cannot start until this one signs.`,
        owner: reviewer ?? undefined,
        lead: reviewerLead ?? undefined,
        to: [reviewerLead, reviewer].filter((e): e is string => !!e),
        publicBoard: true,
      });
      await this.env.DB.prepare(`UPDATE work_items SET sla_escalated = 1 WHERE id = ?1`).bind(item.id).run();
      slaBreached++;
    }

    await appendAudit(this.env.DB, {
      actor: "dispatcher",
      action: "dispatch_sweep",
      detail: `${idlePinged} idle pinged, ${slaBreached} SLA breaches escalated`,
    });
    return { idlePinged, slaBreached };
  }

  private async reviewerFor(role: string): Promise<string | undefined> {
    const row = await this.env.DB.prepare(
      `SELECT email FROM user_capabilities WHERE capability = ?1 LIMIT 1`
    )
      .bind(`stage:${role}`)
      .first<{ email: string }>();
    return row?.email;
  }

  private parseArray(json: string): string[] {
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  /** Stage definitions, for the dashboard. */
  stages(): typeof STAGES {
    return STAGES;
  }

  override async onRequest(_request: Request): Promise<Response> {
    return Response.json({ error: "use the dashboard or RPC" }, { status: 404 });
  }
}

export { getAgentByName };
