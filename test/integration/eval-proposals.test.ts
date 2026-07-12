// Integration tests for the eval → proposal bridge (src/eval/propose.ts,
// EXECUTION-PLAN §Phase 4). A failing eval run should generate a PROPOSED
// remedy in the operator review queue (src/learning/proposals.ts), and a
// second run must dedupe rather than pile up duplicates.
//
// The deep-tier router is injected (ProposeDeps.router seam) so the test
// makes no network calls and the drafted clause is deterministic.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import type { CompleteResponse } from "../../src/ai/types";
import { logger } from "../../src/lib/logger";
import { proposeFromEvalRun } from "../../src/eval/propose";
import type { RunSummary } from "../../src/eval/types";

const testEnv = env as unknown as Env;
const log = logger();

// A router stub that always returns a JSON clause, recording call count.
function fakeRouter() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    router: {
      async complete(): Promise<CompleteResponse> {
        calls += 1;
        return {
          text: JSON.stringify({
            clause: "Arcadia's flagship product is the Aegis platform.",
            correction: "The recalled owner is stale; the current owner is Dana.",
          }),
          model: "fake-deep",
          tier: "deep",
        };
      },
    },
  };
}

function failingSummary(tag: string, caseId: string): RunSummary {
  const now = new Date().toISOString();
  return {
    runId: crypto.randomUUID(),
    startedAt: now,
    finishedAt: now,
    pass_rate: 0,
    model: "anthropic",
    passingThreshold: 0.7,
    total: 1,
    passed: 0,
    failed: 1,
    results: [
      {
        caseId,
        caseName: `case ${caseId}`,
        prompt: "What is Arcadia's flagship product?",
        expected: "Names the Aegis platform as the flagship product.",
        reply: "I'm not sure which product you mean.",
        model: "anthropic",
        tier: "balanced",
        score: 0.1,
        rationale: "Missed the expected product name entirely.",
        passed: false,
        durationMs: 5,
        tags: [tag],
      },
    ],
  };
}

async function countCharterProposals(tag: string): Promise<number> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM improvement_proposals
       WHERE kind = 'charter_amendment'
         AND json_extract(payload_json, '$.failingTag') = ?`,
  )
    .bind(tag)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("proposeFromEvalRun — charter_amendment from a failing case", () => {
  it("creates a charter_amendment proposal tagged with the failing tag", async () => {
    const tag = "eval-prop-flagship";
    const stub = fakeRouter();

    const ids = await proposeFromEvalRun(
      testEnv,
      failingSummary(tag, "eval-prop-case-1"),
      null,
      log,
      { router: stub.router },
    );

    expect(ids.length).toBe(1);
    expect(stub.calls).toBe(1);

    const proposal = await testEnv.ARCADIA_DB.prepare(
      `SELECT kind, origin, status, payload_json FROM improvement_proposals WHERE id = ?`,
    )
      .bind(ids[0])
      .first<{
        kind: string;
        origin: string;
        status: string;
        payload_json: string;
      }>();
    expect(proposal?.kind).toBe("charter_amendment");
    expect(proposal?.origin).toBe("eval");
    expect(proposal?.status).toBe("pending");

    const payload = JSON.parse(proposal?.payload_json ?? "{}") as {
      failingTag: string;
      suggestedClause: string;
      caseIds: string[];
    };
    expect(payload.failingTag).toBe(tag);
    expect(payload.suggestedClause).toContain("Aegis");
    expect(payload.caseIds).toContain("eval-prop-case-1");
  });

  it("dedupes a repeated failure on the same tag (no second proposal row)", async () => {
    const tag = "eval-prop-dedupe";
    const stub = fakeRouter();

    const first = await proposeFromEvalRun(
      testEnv,
      failingSummary(tag, "eval-prop-dedupe-a"),
      null,
      log,
      { router: stub.router },
    );
    const second = await proposeFromEvalRun(
      testEnv,
      failingSummary(tag, "eval-prop-dedupe-b"),
      null,
      log,
      { router: stub.router },
    );

    // Same proposal id returned both times; exactly one row for the tag.
    expect(second[0]).toBe(first[0]);
    expect(await countCharterProposals(tag)).toBe(1);
  });

  it("no failing cases → no proposals", async () => {
    const now = new Date().toISOString();
    const summary: RunSummary = {
      runId: crypto.randomUUID(),
      startedAt: now,
      finishedAt: now,
      pass_rate: 1,
      model: "anthropic",
      passingThreshold: 0.7,
      total: 1,
      passed: 1,
      failed: 0,
      results: [
        {
          caseId: "eval-prop-pass",
          caseName: "passing case",
          prompt: "ok?",
          expected: "Confirms.",
          reply: "yes",
          model: "anthropic",
          tier: "fast",
          score: 1,
          rationale: "all good",
          passed: true,
          durationMs: 2,
          tags: ["eval-prop-pass-tag"],
        },
      ],
    };
    const stub = fakeRouter();
    const ids = await proposeFromEvalRun(testEnv, summary, null, log, {
      router: stub.router,
    });
    expect(ids).toEqual([]);
    expect(stub.calls).toBe(0);
  });
});
