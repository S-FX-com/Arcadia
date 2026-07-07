// Integration tests for Arcadia-authored routines (EXECUTION-PLAN §Phase 5,
// skill acquisition). proposeRoutine validates a drafted routine, stores it
// DISABLED, and files a pending 'routine' improvement_proposal for the
// operator to ratify. Approval → enable is handled by the proposals approve
// endpoint (covered by proposals-api.test.ts), not here.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { proposeRoutine } from "../../src/routines/authored";
import { RoutineStore } from "../../src/routines/store";
import { ProposalStore } from "../../src/learning/proposals";

const testEnv = env as unknown as Env;
const log = logger();

function validDef(name: string): unknown {
  return {
    name,
    description: "Drafted by Arcadia after noticing a pattern.",
    trigger: { kind: "cron", cron: "0 8 * * 1" },
    steps: [
      { kind: "ai_complete", prompt: "Draft the weekly summary.", as: "draft" },
    ],
  };
}

describe("proposeRoutine", () => {
  it("valid def → disabled routine + pending 'routine' proposal", async () => {
    const name = `authored-${crypto.randomUUID()}`;
    const result = await proposeRoutine(
      testEnv,
      log,
      validDef(name),
      "seen this every Monday for a month",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const routine = await new RoutineStore(testEnv).byId(result.routineId);
    expect(routine).not.toBeNull();
    expect(routine?.name).toBe(name);
    // Stored disabled — it must not run until approved.
    expect(routine?.enabled).toBe(false);
    expect(routine?.ownerAadId).toBe(testEnv.ADMIN_USER_AAD_ID);

    const proposal = await new ProposalStore(testEnv).byId(result.proposalId);
    expect(proposal).not.toBeNull();
    expect(proposal?.kind).toBe("routine");
    expect(proposal?.status).toBe("pending");
    const payload = proposal?.payload as { routineId?: string } | null;
    expect(payload?.routineId).toBe(result.routineId);
  });

  it("invalid def → rejected, nothing created", async () => {
    const store = new RoutineStore(testEnv);
    const before = await store.listByOwner(testEnv.ADMIN_USER_AAD_ID);

    // Missing required `steps` (and `trigger`) → schema rejects it.
    const result = await proposeRoutine(
      testEnv,
      log,
      { name: "broken", trigger: { kind: "manual" } },
      "should not persist",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid_routine");

    // No new routine row was written for the operator.
    const after = await store.listByOwner(testEnv.ADMIN_USER_AAD_ID);
    expect(after.length).toBe(before.length);
  });
});
