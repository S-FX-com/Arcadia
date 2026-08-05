// Doctrine ratification (§5.6.1) — the most important control in the system.
// Staging → human tap → canonical. Doctrine never auto-commits; every
// canonical entry carries who ratified it.

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Arcadia } from "../agents/arcadia";
import { appendAudit } from "../lib/audit";
import { DOCTRINE_CANONICAL, DOCTRINE_STAGING, type Memory } from "../memory/driver";
import type { PublishProgress, RatifyParams } from "../schema/types";

const NET_RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

interface ApprovalPayload {
  approved: boolean;
  reason?: string;
  metadata?: { email?: string };
}

export class RatifyWorkflow extends AgentWorkflow<Arcadia, RatifyParams, PublishProgress, Env> {
  async run(event: AgentWorkflowEvent<RatifyParams>, step: AgentWorkflowStep) {
    const env = this.env;
    const workflowId = this.workflowId;
    const { stagingMemoryId, proposedBy } = event.payload;

    const candidate = await step.do("load-candidate", NET_RETRY, async (): Promise<Memory> => {
      const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
      const memory = await staging.getMemory(stagingMemoryId);
      if (!memory) throw new Error(`staging memory ${stagingMemoryId} not found`);
      // RPC returns carry a disposer; rebuild a plain serializable object.
      return {
        id: memory.id,
        profile: memory.profile,
        content: memory.content,
        kind: memory.kind,
        topicKey: memory.topicKey,
        provenance: memory.provenance,
        createdAt: memory.createdAt,
      };
    });

    await step.do("raise-approval", NET_RETRY, async () => {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO approvals (id, workflow_id, kind, subject, summary)
         VALUES (?1, ?2, 'doctrine_ratify', ?3, ?4)`
      )
        .bind(`apr_${workflowId}`, workflowId, stagingMemoryId, candidate.content.slice(0, 200))
        .run();
    });
    await this.reportProgress({
      step: "ratify",
      status: "pending",
      waitingForApproval: true,
      message: `doctrine candidate from ${proposedBy}: ${candidate.content.slice(0, 120)}`,
    });

    const approvalEvent = (await step.waitForEvent("wait-for-approval", {
      type: "approval",
      timeout: "30 days",
    })) as { payload: ApprovalPayload };
    const payload = approvalEvent.payload;
    const decidedBy = payload.metadata?.email ?? "unknown";

    if (!payload.approved) {
      await step.do("handle-rejection", NET_RETRY, async () => {
        // Staging is a queue, not a memory (§5.2) — a rejected candidate
        // leaves the queue (tombstoned, never hard-deleted).
        const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
        await staging.forgetMemory(stagingMemoryId);
        await appendAudit(env.DB, {
          actor: decidedBy,
          action: "doctrine_rejected_handled",
          subject: stagingMemoryId,
          workflowId,
          detail: payload.reason,
        });
      });
      await step.reportComplete({ ratified: false, by: decidedBy });
      return { ratified: false };
    }

    const promotion = await step.do("promote", NET_RETRY, async (): Promise<{ conflictWith: string | null }> => {
      const canonical = await getAgentByName(env.MemoryProfile, DOCTRINE_CANONICAL);
      const outcome = await canonical.promoteMemory(candidate, decidedBy);
      if (outcome.status === "conflict") {
        // Contradiction halts (§5.6.2): surface both versions, no silent
        // overwrite — and no workflow error, which would strand the
        // candidate invisibly. It stays in staging for explicit resolution.
        await appendAudit(env.DB, {
          actor: "arcadia",
          action: "doctrine_conflict",
          subject: stagingMemoryId,
          workflowId,
          detail: `HALT: canonical ${outcome.existing.id} ("${outcome.existing.content.slice(0, 120)}") conflicts with candidate ("${candidate.content.slice(0, 120)}") on topic "${candidate.topicKey}". A human must supersede explicitly.`,
        });
        return { conflictWith: outcome.existing.id };
      }
      const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
      await staging.forgetMemory(stagingMemoryId);
      await appendAudit(env.DB, {
        actor: decidedBy,
        action: "doctrine_ratified",
        subject: stagingMemoryId,
        workflowId,
        detail: candidate.content.slice(0, 300),
      });
      return { conflictWith: null };
    });

    if (promotion.conflictWith) {
      await step.reportComplete({ ratified: false, conflictWith: promotion.conflictWith });
      return { ratified: false, conflictWith: promotion.conflictWith };
    }
    await step.reportComplete({ ratified: true, by: decidedBy });
    return { ratified: true };
  }
}
