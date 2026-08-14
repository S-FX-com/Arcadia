// Bulk seed workflow (capture channel C, §5.5). A doctrine import is dozens of
// model calls across pass A, pass B and verification — far too much for one
// request, and far too expensive to redo from the top when call 40 of 60 times
// out. One durable step per part: a failed part retries alone.
//
// There is no approval gate here, and that is deliberate. The workflow writes
// only to sfx-doctrine-staging, which auto-writes (§5.2). Canonical stays
// promotion-only; a human ratifies each entry from the doctrine surface.

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { Arcadia } from "../agents/arcadia";
import { appendAudit } from "../lib/audit";
import { ingestPart, listRunParts, readPart, stageFromR2Prefix, type PartResult } from "../memory/seed";
import type { PublishProgress } from "../schema/types";

const IO_RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
/** Three model calls per chunk, five chunks per part — this needs room. */
const LLM_RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

export interface SeedParams {
  source: "paste" | "r2";
  requestedBy: string;
  /** Document names already staged as parts (source="paste"). */
  documents?: string[];
  /** R2 prefix holding raw documents to stage (source="r2"). */
  prefix?: string;
  /**
   * Folder the parts were written under before the workflow existed. A pasted
   * document has to be staged by the request that starts the run — the
   * workflow id does not exist yet, and staging afterwards would race the
   * first step.
   */
  stagedRunId?: string;
}

export class SeedWorkflow extends AgentWorkflow<Arcadia, SeedParams, PublishProgress, Env> {
  async run(event: AgentWorkflowEvent<SeedParams>, step: AgentWorkflowStep) {
    try {
      return await this.seed(event, step);
    } catch (err) {
      // A run left at 'running' forever reads as "still working" on the
      // doctrine surface. Name the failure instead.
      const reason = err instanceof Error ? err.message : "seed run failed";
      await this.env.DB.prepare(
        `UPDATE seed_runs SET status = 'failed', finished_at = datetime('now'), detail = ?1 WHERE id = ?2`
      )
        .bind(reason.slice(0, 500), this.workflowId)
        .run();
      await step.reportError(reason);
      throw err;
    }
  }

  private async seed(event: AgentWorkflowEvent<SeedParams>, step: AgentWorkflowStep) {
    const env = this.env;
    const runId = this.workflowId;
    const { source, requestedBy, prefix } = event.payload;
    // Where the parts live: the pre-workflow folder for a paste, this run's
    // own folder for an R2 batch it stages itself.
    const folder = source === "paste" ? (event.payload.stagedRunId ?? runId) : runId;

    const prepared = await step.do("prepare-parts", IO_RETRY, async () => {
      if (source === "r2") {
        if (!prefix) throw new Error("an r2 seed run needs a prefix");
        const staged = await stageFromR2Prefix(env, folder, prefix);
        if (staged.parts === 0) throw new Error(`no readable documents under "${prefix}"`);
        return staged;
      }
      const keys = await listRunParts(env, folder);
      if (keys.length === 0) throw new Error("no staged parts for this run");
      return { documents: event.payload.documents ?? [], parts: keys.length };
    });

    await env.DB.prepare(
      `UPDATE seed_runs SET parts_total = ?1, documents = ?2 WHERE id = ?3`
    )
      .bind(prepared.parts, JSON.stringify(prepared.documents), runId)
      .run();

    const keys = await step.do("list-parts", IO_RETRY, async () => listRunParts(env, folder));

    let written = 0;
    let duplicates = 0;
    let conflicts = 0;

    for (const [i, key] of keys.entries()) {
      await this.reportProgress({
        step: "seed",
        status: "running",
        percent: keys.length ? i / keys.length : 0,
        message: `part ${i + 1}/${keys.length}`,
      });

      const result = await step.do(`seed-part-${i}`, LLM_RETRY, async (): Promise<PartResult> => {
        const part = await readPart(env, key);
        if (!part) return { written: 0, duplicates: 0, conflicts: [] };
        const outcome = await ingestPart(env, runId, part);

        // Contradiction halts (§5.6.2). A conflicting candidate is never
        // silently dropped — both versions are recorded for a human to choose
        // between, because an unsurfaced conflict is lost doctrine.
        for (const conflict of outcome.conflicts) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO seed_conflicts
               (id, run_id, topic_key, existing_id, existing_text, incoming_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
          )
            .bind(
              crypto.randomUUID(),
              runId,
              conflict.topicKey,
              conflict.existingId,
              conflict.existingText.slice(0, 2000),
              conflict.incomingText.slice(0, 2000)
            )
            .run();
        }
        return outcome;
      });

      written += result.written;
      duplicates += result.duplicates;
      conflicts += result.conflicts.length;

      await env.DB.prepare(
        `UPDATE seed_runs SET parts_done = ?1, written = ?2, duplicates = ?3, conflicts = ?4 WHERE id = ?5`
      )
        .bind(i + 1, written, duplicates, conflicts, runId)
        .run();
    }

    await step.do("finish", IO_RETRY, async () => {
      await env.DB.prepare(
        `UPDATE seed_runs SET status = 'done', finished_at = datetime('now'), detail = ?1 WHERE id = ?2`
      )
        .bind(`${written} staged, ${duplicates} duplicates, ${conflicts} conflicts`, runId)
        .run();
      await appendAudit(env.DB, {
        actor: requestedBy,
        action: "doctrine_seeded",
        subject: runId,
        workflowId: runId,
        detail: `${prepared.documents.length} document(s) → ${written} staged candidates, ${duplicates} duplicates, ${conflicts} conflicts. Awaiting ratification.`,
      });
    });

    await step.reportComplete({ written, duplicates, conflicts });
    return { written, duplicates, conflicts };
  }
}
