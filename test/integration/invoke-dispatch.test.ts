import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import {
  dispatchInvoke,
  type InvokeActivity,
} from "../../src/runtime/invoke-dispatch";
import { TaskStore } from "../../src/tasks/store";
import { executeAction } from "../../src/actions/framework";
import { completeTaskVerb } from "../../src/actions/verbs/complete-task";
import type { Verb } from "../../src/cards/types";

// P6 item 4: Universal-Action verb dispatch against real D1. We build the
// invoke Activity shape the dispatcher expects and assert the D1 side effects
// each handler is responsible for (task status, feedback, ownership_history,
// action_log). No AI / Graph is involved on these verb paths.

const testEnv = env as unknown as Env;
const db = testEnv.ARCADIA_DB;
const log = logger();
const TID = testEnv.GRAPH_TENANT_ID;

function activity(
  verb: Verb,
  data: Record<string, unknown>,
  viewer: string,
): InvokeActivity {
  return {
    type: "invoke",
    name: "adaptiveCard/action",
    conversation: { id: "invoke-conv-1", tenantId: TID },
    from: { aadObjectId: viewer },
    value: { action: { type: "Action.Execute", verb, data } },
  };
}

describe("invoke-dispatch — task_complete", () => {
  it("marks the task done and writes a positive feedback row", async () => {
    const store = new TaskStore(testEnv);
    const task = await store.create({
      title: "Ship the release",
      ownerAadId: "inv-owner",
      createdByAadId: "inv-owner",
    });

    const res = await dispatchInvoke(
      testEnv,
      activity("task_complete", { taskId: task.id }, "inv-owner"),
      log,
    );

    expect(res.type).toBe("application/vnd.microsoft.card.adaptive");

    const fresh = await store.byId(task.id);
    expect(fresh?.status).toBe("done");

    const fb = await db
      .prepare(
        `SELECT signal, note, surface FROM feedback
          WHERE target_kind = 'task' AND target_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(task.id)
      .first<{ signal: string; note: string; surface: string }>();
    expect(fb?.signal).toBe("positive");
    expect(fb?.note).toBe("completed");
    expect(fb?.surface).toBe("task_card");
  });
});

describe("invoke-dispatch — task_reassign_submit", () => {
  it("reassigns ownership and appends an ownership_history row", async () => {
    const store = new TaskStore(testEnv);
    const task = await store.create({
      title: "Draft the roadmap",
      ownerAadId: "inv-from",
      createdByAadId: "inv-from",
    });

    const res = await dispatchInvoke(
      testEnv,
      activity(
        "task_reassign_submit",
        { taskId: task.id, targetAadId: "inv-to", reason: "better fit" },
        "inv-actor",
      ),
      log,
    );

    expect(res.type).toBe("application/vnd.microsoft.card.adaptive");

    const fresh = await store.byId(task.id);
    expect(fresh?.ownerAadId).toBe("inv-to");

    const hist = await db
      .prepare(
        `SELECT from_aad_id, to_aad_id, reason, source FROM ownership_history
          WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(task.id)
      .first<{
        from_aad_id: string | null;
        to_aad_id: string;
        reason: string | null;
        source: string;
      }>();
    expect(hist?.to_aad_id).toBe("inv-to");
    expect(hist?.from_aad_id).toBe("inv-from");
    expect(hist?.reason).toBe("better fit");
    expect(hist?.source).toBe("card_action");
  });
});

describe("invoke-dispatch — action confirm / reject", () => {
  // Mint an 'awaiting_confirmation' action_log row by running the confirm-level
  // complete_task verb through executeAction with no confirmation.
  async function awaitingAction(taskId: string): Promise<string> {
    const outcome = await executeAction(
      { env: testEnv, log, actorAadId: "inv-confirm-actor" },
      completeTaskVerb,
      { type: "tenant", id: "invoke-confirm-scope" },
      { taskId },
    );
    expect(outcome.status).toBe("awaiting_confirmation");
    return outcome.actionId;
  }

  it("action_confirm routes to confirmAction and executes the verb", async () => {
    const store = new TaskStore(testEnv);
    const task = await store.create({
      title: "Confirmable task",
      ownerAadId: "inv-conf-owner",
      createdByAadId: "inv-conf-owner",
    });
    const actionId = await awaitingAction(task.id);

    // Clear today's action budget so the confirmed re-run is not blocked.
    const today = new Date().toISOString().slice(0, 10);
    await testEnv.ARCADIA_CACHE.delete(`actions:budget:${today}`);

    const res = await dispatchInvoke(
      testEnv,
      activity("action_confirm", { actionId }, "inv-approver"),
      log,
    );
    expect(res.type).toBe("application/vnd.microsoft.card.adaptive");

    // confirmAction re-ran executeAction (idempotency_key = actionId) → the
    // verb executed and the task is now done.
    const fresh = await store.byId(task.id);
    expect(fresh?.status).toBe("done");

    const executed = await db
      .prepare(
        `SELECT status FROM action_log WHERE idempotency_key = ? LIMIT 1`,
      )
      .bind(actionId)
      .first<{ status: string }>();
    expect(executed?.status).toBe("executed");
  });

  it("action_reject flips the awaiting row to rejected without executing", async () => {
    const store = new TaskStore(testEnv);
    const task = await store.create({
      title: "Rejectable task",
      ownerAadId: "inv-rej-owner",
      createdByAadId: "inv-rej-owner",
    });
    const actionId = await awaitingAction(task.id);

    const res = await dispatchInvoke(
      testEnv,
      activity("action_reject", { actionId }, "inv-rejecter"),
      log,
    );
    expect(res.type).toBe("application/vnd.microsoft.card.adaptive");

    const row = await db
      .prepare(`SELECT status FROM action_log WHERE id = ?`)
      .bind(actionId)
      .first<{ status: string }>();
    expect(row?.status).toBe("rejected");

    // The verb never ran — the task is still open.
    const fresh = await store.byId(task.id);
    expect(fresh?.status).toBe("open");
  });
});
