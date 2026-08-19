// Arcadia — root agent. She surfaces and attributes; humans decide and sign.
// Phase 1a scope: doctrine staging → ratification plumbing and a status
// surface for the dashboard. Ask Arcadia (Teams) arrives in Phase 2.

import { Agent } from "agents";
import { ModelRouter } from "../ai/router";
import { appendAudit } from "../lib/audit";
import { askSystemPrompt, askUserPrompt, decideAskMode, type AnswerMode } from "../lib/ask";
import type { ChatTurn } from "../lib/ask-types";
import { looksLikeDoctrineQuestion } from "../lib/question";
import { snapshotUserWork } from "../gatekeepers/user-graph";
import { DOCTRINE_CANONICAL, DOCTRINE_STAGING } from "../memory/driver";
import { SelfHostedMemoryDriver } from "../memory/self-hosted";
import type { RatifyParams } from "../schema/types";
import type { SeedParams } from "../workflows/seed";
import type { SitePlanParams } from "../workflows/siteplan";

export interface ArcadiaState {
  lastStatusAt?: string;
}

export interface AskResult {
  escalated: boolean;
  mode: AnswerMode;
  answer: string;
  citations: string[];
  gapId?: string;
  /**
   * The input was not a doctrine question — a greeting, a test, small talk.
   * She still answers. A gap is only queued when Inferred and the filter
   * says this is a real operating question (doctrine §12.3–12.4).
   */
  notAQuestion?: boolean;
}

export type { ChatTurn } from "../lib/ask-types";

export interface ArcadiaStatus {
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
    return { pendingApprovals: pending?.n ?? 0 };
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

  /**
   * Capture channel C — bulk seed (§5.5). Pushes documents through the §5.3
   * pipeline into staging so doctrine has day-one coverage instead of arriving
   * one typed entry at a time. Nothing reaches canonical from here.
   */
  async startDoctrineSeed(params: SeedParams): Promise<string> {
    const workflowId = await this.runWorkflow<SeedParams>("SEED_WORKFLOW", params, {
      metadata: { kind: "doctrine_seed" },
    });
    // seed_runs.source is constrained to 'paste' | 'r2', and SQLite cannot
    // widen a CHECK in place — writing 'upload' would fail on every database
    // created before uploads existed, after the workflow had already started.
    // An upload stages its parts exactly as a paste does, so it records as
    // 'paste'; the audit row below carries how it actually arrived.
    const source = params.source === "upload" ? "paste" : params.source;
    const documents = params.documents ?? (params.prefix ? [params.prefix] : []);
    await this.env.DB.prepare(
      `INSERT INTO seed_runs (id, requested_by, source, documents) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(workflowId, params.requestedBy, source, JSON.stringify(documents))
      .run();
    await appendAudit(this.env.DB, {
      actor: params.requestedBy,
      action: "doctrine_seed_started",
      subject: params.prefix ?? `${documents.length} document(s)`,
      workflowId,
      detail: `${params.source}: ${documents.join(", ").slice(0, 400) || "—"}`,
    });
    return workflowId;
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
   * Ask Arcadia (doctrine §12.3). Recalls from canonical doctrine. The
   * confidence floor picks Cited vs Inferred — it does not decide whether
   * she answers. Inferred answers are usable; they are labeled and logged
   * as gap candidates so Shane reviews patterns, not one-off chats.
   *
   * `history` widens recall for follow-ups. `aadId` (when present) lets her
   * read that Specialist's own M365 snapshot through the user-graph gatekeeper.
   */
  async ask(
    question: string,
    askedBy: string,
    history: ChatTurn[] = [],
    opts: { aadId?: string } = {}
  ): Promise<AskResult> {
    const driver = new SelfHostedMemoryDriver(this.env);
    const canonical = await driver.getProfile(DOCTRINE_CANONICAL);
    const priorQuestions = history
      .filter((t) => t.role === "user")
      .slice(-2)
      .map((t) => t.content);
    const recalled = await canonical.recall([...priorQuestions, question].join("\n"), {
      limit: 6,
      topicKeyFrom: question,
    });

    const mode = decideAskMode(recalled);
    const workContext = opts.aadId ? await snapshotUserWork(this.env, askedBy, opts.aadId) : "";

    const ai = new ModelRouter(this.env);
    const answer = await ai.text("synthesis", {
      system: askSystemPrompt(mode),
      prompt: askUserPrompt({ question, history, recalled, workContext }),
      metadata: { job: "ask-arcadia", mode },
    });

    const citations = recalled.memories.map((m) => m.id);
    let gapId: string | undefined;
    let notAQuestion = false;

    if (mode === "inferred") {
      const verdict = await looksLikeDoctrineQuestion(ai, question, history);
      if (verdict.isQuestion) {
        gapId = await this.queueGap(question, askedBy);
        await appendAudit(this.env.DB, {
          actor: "arcadia",
          action: "ask_inferred",
          subject: askedBy,
          doctrineEntries: citations,
          detail: `${verdict.reason ?? "inferred"}: "${question.slice(0, 200)}"${gapId ? ` → gap ${gapId}` : ""}`,
        });
      } else {
        notAQuestion = true;
        await appendAudit(this.env.DB, {
          actor: "arcadia",
          action: "ask_not_a_question",
          subject: askedBy,
          detail: `"${question.slice(0, 200)}" — ${verdict.reason ?? "not a doctrine question"}. Answered Inferred; no gap queued.`,
        });
      }
    } else {
      await appendAudit(this.env.DB, {
        actor: "arcadia",
        action: "ask_answered",
        subject: askedBy,
        doctrineEntries: citations,
        detail: question.slice(0, 300),
      });
    }

    return {
      escalated: false,
      mode,
      answer,
      citations,
      ...(gapId ? { gapId } : {}),
      ...(notAQuestion ? { notAQuestion } : {}),
    };
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
