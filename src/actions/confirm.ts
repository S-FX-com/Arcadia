// Delegated confirmation of a ladder-gated action.
//
// A 'confirm'-level verb, when first attempted, writes an
// 'awaiting_confirmation' row to action_log and stops (framework.ts). A
// human then approves or rejects it — from an Adaptive Card
// (src/runtime/invoke-dispatch.ts) or an MCP client (confirm_action). This
// module is that second half:
//
//   approve → reconstruct the verb + scope + params from the logged row and
//             re-run executeAction with { confirmed:true, idempotencyKey }.
//             The idempotency key (= the awaiting row's action id) makes a
//             double-approve a no-op: the second call replays the prior
//             outcome instead of executing again.
//   reject  → flip the awaiting row to 'rejected'. No side effect.
//
// confirmAction never sees a delegated user token — a card/cron path is
// app-only. Verbs that require OBO (send_mail, schedule_meeting) therefore
// cannot be confirmed here; they must be confirmed through a token-bearing
// path. We fail those closed with a clear error rather than let the verb's
// own execute() return the opaque 'delegated_required'.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import {
  executeAction,
  type ActionScope,
  type ExecuteOutcome,
} from "./framework";
import { verbs } from "./verbs/index";

export type ConfirmDecision = "approve" | "reject";

/** Verbs that act AS the user via On-Behalf-Of and so need a user token. */
const OBO_REQUIRED_VERBS: ReadonlySet<string> = new Set([
  "send_mail",
  "schedule_meeting",
]);

interface AwaitingRow {
  id: string;
  verb: string;
  scope_type: string;
  scope_id: string;
  params_json: string;
  status: string;
  level: string;
}

/**
 * Resolve a pending confirmation. Defensive: a missing row, a non-pending
 * row, an unknown verb, or an OBO-required verb all yield a 'failed' outcome
 * with a descriptive message rather than throwing.
 */
export async function confirmAction(
  env: Env,
  log: Logger,
  actionId: string,
  actorAadId: string,
  decision: ConfirmDecision,
): Promise<ExecuteOutcome> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT id, verb, scope_type, scope_id, params_json, status, level
       FROM action_log WHERE id = ? LIMIT 1`,
  )
    .bind(actionId)
    .first<AwaitingRow>();

  if (!row) {
    log.warn("confirm_action_missing", { actionId });
    return {
      status: "failed",
      actionId,
      level: "observe",
      description: `action ${actionId} not found`,
      result: { ok: false, error: "action_not_found" },
    };
  }

  const scope: ActionScope = {
    type: row.scope_type as ActionScope["type"],
    id: row.scope_id,
  };
  const description = describeRow(row);

  if (row.status !== "awaiting_confirmation") {
    log.info("confirm_action_not_pending", {
      actionId,
      status: row.status,
    });
    return {
      status: "failed",
      actionId,
      level: row.level as ExecuteOutcome["level"],
      description,
      result: {
        ok: false,
        error: `not_awaiting_confirmation: status=${row.status}`,
      },
    };
  }

  if (decision === "reject") {
    await env.ARCADIA_DB.prepare(
      `UPDATE action_log SET status = 'rejected' WHERE id = ?`,
    )
      .bind(actionId)
      .run();
    log.info("confirm_action_rejected", { actionId, verb: row.verb });
    return {
      status: "rejected",
      actionId,
      level: row.level as ExecuteOutcome["level"],
      description,
    };
  }

  // decision === "approve"
  if (OBO_REQUIRED_VERBS.has(row.verb)) {
    log.warn("confirm_action_obo_blocked", { actionId, verb: row.verb });
    return {
      status: "failed",
      actionId,
      level: row.level as ExecuteOutcome["level"],
      description,
      result: {
        ok: false,
        error:
          "delegated_confirmation_requires_token: " +
          `${row.verb} acts on behalf of the user and cannot be confirmed ` +
          "from a card/cron path; confirm it through a token-bearing path",
      },
    };
  }

  const verb = verbs[row.verb];
  if (!verb) {
    log.error("confirm_action_unknown_verb", { actionId, verb: row.verb });
    return {
      status: "failed",
      actionId,
      level: row.level as ExecuteOutcome["level"],
      description,
      result: { ok: false, error: `unknown_verb: ${row.verb}` },
    };
  }

  let params: unknown;
  try {
    params = JSON.parse(row.params_json);
  } catch (e) {
    return {
      status: "failed",
      actionId,
      level: row.level as ExecuteOutcome["level"],
      description,
      result: { ok: false, error: `corrupt_params: ${String(e)}` },
    };
  }

  // Re-run the ladder with confirmed:true so it executes, keyed on the
  // awaiting row's id so a repeat approval replays instead of re-executing.
  return executeAction(
    { env, log, actorAadId },
    verb,
    scope,
    params,
    { confirmed: true, idempotencyKey: actionId },
  );
}

/** Best-effort one-line description reconstructed from the logged row. */
function describeRow(row: AwaitingRow): string {
  const verb = verbs[row.verb];
  if (verb) {
    try {
      return verb.describe(verb.parse(JSON.parse(row.params_json)));
    } catch {
      // fall through to the generic form
    }
  }
  return `${row.verb} on ${row.scope_type}:${row.scope_id}`;
}
