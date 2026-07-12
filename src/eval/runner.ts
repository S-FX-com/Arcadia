// Eval runner.
//
// Pulls every row in `eval_cases`, runs each prompt through the same
// path the Teams + webapp surface uses (memory recall → AI router),
// then asks the judge to score it. Per-case results are aggregated
// into an `eval_runs` row; the JSON summary is returned for the
// nightly cron + the gate.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { MemoryStore } from "../memory/store";
import { judge } from "./judge";
import type { CaseResult, EvalCase, RunSummary } from "./types";

const SYSTEM_PROMPT =
  "You are Arcadia, a Microsoft 365 AI operations layer. Reply in your own voice — direct, specific, no filler. Cite ownership signals when relevant. Use the recalled context only when it actually answers the question.";

const PASS_THRESHOLD = 0.7;

interface CaseRow {
  id: string;
  kind: string;
  tags: string | null;
  input_json: string;
  expected_json: string | null;
}

export async function runEvals(
  env: Env,
  log: Logger,
  options: { kind?: string; limit?: number } = {},
): Promise<RunSummary> {
  const cases = await loadCases(env, options);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  log.info("eval_start", { runId, count: cases.length });

  await env.ARCADIA_DB.prepare(
    `INSERT INTO eval_runs (id, started_at, model) VALUES (?, ?, ?)`,
  )
    .bind(runId, startedAt, "anthropic")
    .run();

  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runOne(env, c, log));
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const pass_rate = results.length === 0 ? 1 : passed / results.length;
  const finishedAt = new Date().toISOString();

  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt,
    pass_rate,
    model: "anthropic",
    passingThreshold: PASS_THRESHOLD,
    total: results.length,
    passed,
    failed,
    results,
  };

  await env.ARCADIA_DB.prepare(
    `UPDATE eval_runs
        SET finished_at = ?, pass_rate = ?, summary_json = ?
      WHERE id = ?`,
  )
    .bind(finishedAt, pass_rate, JSON.stringify(summary), runId)
    .run();

  log.info("eval_finish", {
    runId,
    pass_rate,
    passed,
    failed,
    total: results.length,
  });
  return summary;
}

async function loadCases(
  env: Env,
  options: { kind?: string; limit?: number },
): Promise<EvalCase[]> {
  const stmt = options.kind
    ? env.ARCADIA_DB.prepare(
        `SELECT id, kind, tags, input_json, expected_json
           FROM eval_cases WHERE kind = ?
           ORDER BY id`,
      ).bind(options.kind)
    : env.ARCADIA_DB.prepare(
        `SELECT id, kind, tags, input_json, expected_json
           FROM eval_cases ORDER BY id`,
      );

  const rows = await stmt.all<CaseRow>();
  const cases: EvalCase[] = [];
  for (const r of rows.results) {
    try {
      const input = JSON.parse(r.input_json) as {
        name?: string;
        prompt?: string;
        user_aad_id?: string;
        tenant_id?: string;
        scope_type?: string;
        scope_id?: string;
      };
      const expected = r.expected_json
        ? (JSON.parse(r.expected_json) as { expected?: string }).expected ??
          ""
        : "";
      if (!input.prompt) continue;
      cases.push({
        id: r.id,
        name: input.name ?? r.id,
        prompt: input.prompt,
        expected,
        ...(input.user_aad_id ? { userAadId: input.user_aad_id } : {}),
        ...(input.tenant_id ? { tenantId: input.tenant_id } : {}),
        ...(input.scope_type ? { scopeType: input.scope_type } : {}),
        ...(input.scope_id ? { scopeId: input.scope_id } : {}),
        ...(r.tags ? { tags: r.tags.split(",").map((t) => t.trim()) } : {}),
      });
    } catch {
      // skip malformed row
    }
  }
  if (options.limit && options.limit > 0) {
    return cases.slice(0, options.limit);
  }
  return cases;
}

async function runOne(
  env: Env,
  c: EvalCase,
  log: Logger,
): Promise<CaseResult> {
  const start = Date.now();
  try {
    const memory = new MemoryStore(env);
    const recall = c.userAadId
      ? await memory.recall(c.prompt, {
          limit: 5,
          viewer: c.userAadId,
          ...(c.tenantId ? { tenantId: c.tenantId } : {}),
          ...(c.scopeType
            ? { scopeType: c.scopeType as never }
            : {}),
          ...(c.scopeId ? { scopeId: c.scopeId } : {}),
        })
      : [];

    const context = recall
      .map((h) => `(${h.memory.kind}) ${h.memory.content}`)
      .join("\n");
    const recalledMemoryIds = recall.map((h) => h.memory.id);

    const router = new Router(env);
    const reply = await router.complete({
      system: SYSTEM_PROMPT,
      messages: [
        ...(context
          ? [{ role: "user" as const, content: `Context:\n${context}` }]
          : []),
        { role: "user" as const, content: c.prompt },
      ],
      tier: "balanced",
      maxTokens: 600,
    });

    const verdict = await judge(env, c.prompt, c.expected, reply.text);
    const passed = verdict.score >= PASS_THRESHOLD;
    return {
      caseId: c.id,
      caseName: c.name,
      prompt: c.prompt,
      expected: c.expected,
      reply: reply.text,
      model: reply.model,
      tier: reply.tier,
      score: verdict.score,
      rationale: verdict.rationale,
      passed,
      durationMs: Date.now() - start,
      ...(c.tags ? { tags: c.tags } : {}),
      ...(recalledMemoryIds.length ? { recalledMemoryIds } : {}),
    };
  } catch (e) {
    log.warn("eval_case_failed", { caseId: c.id, error: String(e) });
    return {
      caseId: c.id,
      caseName: c.name,
      prompt: c.prompt,
      expected: c.expected,
      reply: `(error: ${String(e)})`,
      model: "unknown",
      tier: "unknown",
      score: 0,
      rationale: "exception",
      passed: false,
      durationMs: Date.now() - start,
      ...(c.tags ? { tags: c.tags } : {}),
    };
  }
}
