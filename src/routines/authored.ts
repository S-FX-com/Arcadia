// Arcadia-authored routines — skill acquisition (EXECUTION-PLAN §Phase 5).
//
// When Arcadia notices a repeated pattern she could automate (e.g. from
// consolidation or curiosity), she doesn't switch on a new routine herself.
// She DRAFTS one: proposeRoutine validates the definition, stores it
// DISABLED, and files an improvement_proposal (kind='routine') for the
// operator to review. Arcadia proposes; Shane ratifies (SOUL.md + D5).
//
// Approval → enable is already wired: the proposals approve endpoint
// (src/webapp/proposals-api.ts, kind 'routine') reads payload.routineId and
// flips routines.enabled = 1. Nothing here activates the routine.
//
// Auto-wiring from curiosity/heartbeat is intentionally NOT done here —
// those modules are owned elsewhere and hooking them risks a conflict. This
// module only exposes proposeRoutine; a producer can call it when a clean
// hook exists.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { RoutineStore } from "./store";
import { safeParseDefinition } from "./definition";
import { ProposalStore } from "../learning/proposals";

export type ProposeRoutineResult =
  | {
      ok: true;
      routineId: string;
      proposalId: string;
      /** Approval → enable is handled by the proposals approve endpoint. */
      note: string;
    }
  | { ok: false; error: string };

/**
 * Draft a routine Arcadia noticed would help: validate it, store it
 * disabled, and file a pending 'routine' proposal. Returns an error result
 * (creating nothing) when the definition is invalid.
 */
export async function proposeRoutine(
  env: Env,
  log: Logger,
  def: unknown,
  authoredReason: string,
): Promise<ProposeRoutineResult> {
  const parsed = safeParseDefinition(def);
  if (!parsed.ok) {
    log.warn("propose_routine_invalid", { error: parsed.error });
    return { ok: false, error: `invalid_routine: ${parsed.error}` };
  }

  // Owner is the operator — the routine is theirs to ratify and run.
  const ownerAadId = env.ADMIN_USER_AAD_ID;

  // Store DISABLED: a proposed routine never runs until approved.
  const routine = await new RoutineStore(env).create(
    ownerAadId,
    parsed.data,
    false,
  );

  const proposalId = await new ProposalStore(env).create({
    kind: "routine",
    origin: "consolidation",
    title: `Routine: ${parsed.data.name}`,
    rationale: authoredReason,
    payload: {
      routineId: routine.id,
      def: parsed.data,
      reason: authoredReason,
    },
  });

  log.info("propose_routine_created", {
    routineId: routine.id,
    proposalId,
    name: parsed.data.name,
  });

  return {
    ok: true,
    routineId: routine.id,
    proposalId,
    note: "routine stored disabled; approval via the proposals approve endpoint enables it",
  };
}
