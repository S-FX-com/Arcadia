// Arcadia — root agent. She surfaces and attributes; humans decide and sign.
// Phase 1a scope: doctrine staging → ratification plumbing and a status
// surface for the dashboard. Ask Arcadia (Teams) arrives in Phase 2.

import { Agent } from "agents";
import { ModelRouter } from "../ai/router";
import { ARCADIA_SYSTEM_CORE } from "../integrations/anthropic";
import { appendAudit } from "../lib/audit";
import { VOICE_RULES } from "../lib/brand";
import { checkRateCeiling, killSwitch, type KillSwitchState, type RateCheck } from "../lib/controls";
import { DOCTRINE_CANONICAL, DOCTRINE_STAGING } from "../memory/driver";
import { SelfHostedMemoryDriver } from "../memory/self-hosted";
import type { RatifyParams } from "../schema/types";
import type { SitePlanParams } from "../workflows/siteplan";

export interface ArcadiaState {
  lastStatusAt?: string;
}

export interface AskResult {
  escalated: boolean;
  answer: string;
  citations: string[];
  gapId?: string;
}

/** One turn of an Ask Arcadia conversation (src/approval/chat.tsx). */
export interface ChatTurn {
  role: "user" | "arcadia";
  content: string;
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
    await this.decide(workflowId, true, email, reason);
  }

  async rejectRatify(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.decide(workflowId, false, email, reason);
  }

  /**
   * Site planning (§4 Phase 4). Crawl → diagnose → nav → page specs, then
   * pause for Melina/Diego review. Arcadia never sends it to a client (§8).
   */
  async startSitePlan(
    rootUrl: string,
    requestedBy: string,
    client?: string,
    specLimit?: number
  ): Promise<string> {
    const workflowId = await this.runWorkflow<SitePlanParams>(
      "SITEPLAN_WORKFLOW",
      {
        rootUrl,
        requestedBy,
        ...(client ? { client } : {}),
        ...(specLimit ? { specLimit } : {}),
      },
      { metadata: { kind: "site_plan" } }
    );
    await appendAudit(this.env.DB, {
      actor: requestedBy,
      action: "site_plan_started",
      subject: rootUrl,
      workflowId,
    });
    return workflowId;
  }

  /** Site plans use the same approval envelope as everything else. */
  async approveSitePlan(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.decide(workflowId, true, email, reason);
  }

  async rejectSitePlan(workflowId: string, email: string, reason?: string): Promise<void> {
    await this.decide(workflowId, false, email, reason);
  }

  private async decide(workflowId: string, approved: boolean, email: string, reason?: string): Promise<void> {
    const pending = await this.env.DB
      .prepare(`SELECT id FROM approvals WHERE workflow_id = ?1 AND status = 'pending'`)
      .bind(workflowId)
      .first<{ id: string }>();
    if (!pending) throw new Error(`no pending approval for workflow ${workflowId}`);
    const tracked = this.getWorkflow(workflowId);
    if (!tracked) throw new Error(`workflow ${workflowId} not tracked by Arcadia`);

    // Event first, record second — and metadata.email on both outcomes.
    await this.sendWorkflowEvent(tracked.workflowName, workflowId, {
      type: "approval",
      payload: { approved, reason: reason ?? `${approved ? "ratified" : "rejected"} by ${email}`, metadata: { email } },
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
      action: approved ? "doctrine_approved" : "doctrine_rejected",
      workflowId,
      detail: reason,
    });
  }

  /**
   * Ask Arcadia (§4 Phase 2). Recalls from canonical doctrine only — staging
   * is a queue, not a memory (§5.2). Below the confidence floor she escalates
   * and queues the gap rather than improvising a Shane opinion (§5.6.7).
   *
   * `history` carries earlier turns of the same conversation. It widens the
   * recall query as well as the prompt: a follow-up ("and deferred payment?")
   * embeds to nothing on its own, so searching it alone would escalate a
   * question doctrine actually covers.
   */
  async ask(question: string, askedBy: string, history: ChatTurn[] = []): Promise<AskResult> {
    const driver = new SelfHostedMemoryDriver(this.env);
    const canonical = await driver.getProfile(DOCTRINE_CANONICAL);
    const priorQuestions = history
      .filter((t) => t.role === "user")
      .slice(-2)
      .map((t) => t.content);
    const recalled = await canonical.recall([...priorQuestions, question].join("\n"), { limit: 6 });

    if (recalled.belowConfidenceFloor) {
      const gapId = await this.queueGap(question, askedBy);
      await appendAudit(this.env.DB, {
        actor: "arcadia",
        action: "ask_escalated",
        subject: askedBy,
        detail: `no doctrine cleared the confidence floor: "${question.slice(0, 200)}" → gap ${gapId}`,
      });
      return { escalated: true, answer: "", citations: [], gapId };
    }

    const ai = new ModelRouter(this.env);
    const doctrineBlock = recalled.memories
      .map((m, i) => `[${i + 1}] (${m.id}) ${m.content}`)
      .join("\n");
    const transcript = history
      .map((t) => `${t.role === "user" ? "Staff" : "Arcadia"}: ${t.content}`)
      .join("\n");
    const answer = await ai.text("synthesis", {
      system: `${ARCADIA_SYSTEM_CORE}\n\n${VOICE_RULES}\n\nAnswer ONLY from the doctrine entries provided. Cite the entries you used by their bracket number. If the entries do not actually answer the question, reply with exactly: INSUFFICIENT_DOCTRINE`,
      prompt: `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}Question: ${question}\n\nDoctrine entries:\n${doctrineBlock}`,
      metadata: { job: "ask-arcadia" },
    });

    if (answer.trim().includes("INSUFFICIENT_DOCTRINE")) {
      const gapId = await this.queueGap(question, askedBy);
      await appendAudit(this.env.DB, {
        actor: "arcadia",
        action: "ask_escalated",
        subject: askedBy,
        detail: `recall hit but doctrine did not cover it: "${question.slice(0, 200)}" → gap ${gapId}`,
      });
      return { escalated: true, answer: "", citations: [], gapId };
    }

    const citations = recalled.memories.map((m) => m.id);
    // Every output logs which doctrine entries informed it (§5.6.6).
    await appendAudit(this.env.DB, {
      actor: "arcadia",
      action: "ask_answered",
      subject: askedBy,
      doctrineEntries: citations,
      detail: question.slice(0, 300),
    });
    return { escalated: false, answer, citations };
  }

  /**
   * Capture channel D — gap interrogation (§5.5). The highest-value channel:
   * every question Arcadia cannot answer becomes a question for Shane, and
   * his answer becomes permanent doctrine. Every gap closes once, forever.
   */
  private async queueGap(question: string, askedBy: string): Promise<string> {
    const existing = await this.env.DB.prepare(
      `SELECT id FROM doctrine_gaps WHERE lower(question) = lower(?1) AND status = 'open'`
    )
      .bind(question)
      .first<{ id: string }>();
    if (existing) {
      await this.env.DB.prepare(`UPDATE doctrine_gaps SET times_asked = times_asked + 1 WHERE id = ?1`)
        .bind(existing.id)
        .run();
      return existing.id;
    }
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO doctrine_gaps (id, question, asked_by) VALUES (?1, ?2, ?3)`
    )
      .bind(id, question, askedBy)
      .run();
    return id;
  }

  /** Shane answers a gap; the answer enters staging for ratification. */
  async answerGap(gapId: string, answer: string, answeredBy: string): Promise<string> {
    const gap = await this.env.DB.prepare(`SELECT question FROM doctrine_gaps WHERE id = ?1 AND status = 'open'`)
      .bind(gapId)
      .first<{ question: string }>();
    if (!gap) throw new Error(`no open gap ${gapId}`);
    const { stagingMemoryId, workflowId } = await this.proposeDoctrine(
      `${gap.question} — ${answer}`,
      answeredBy,
      `gap:${gapId}`
    );
    await this.env.DB.prepare(
      `UPDATE doctrine_gaps SET status = 'answered', answered_by = ?2, answered_at = datetime('now'),
         staging_memory_id = ?3 WHERE id = ?1`
    )
      .bind(gapId, answeredBy, stagingMemoryId)
      .run();
    return workflowId;
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
