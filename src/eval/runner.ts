// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Nightly eval runner (Phase 6)
//
// Walks the frozen cases under evals/cases/ (bundled into the Worker at
// build time as static assets), invokes the Phase 2 agent per case, and
// scores the response with a Workers AI judge model. Results land in
// eval_runs + eval_case_results so the operator can chart pass-rate
// drift over time and block promotion on regressions.
//
// Designed to be invoked from a dedicated cron slot (e.g. "0 4 * * *"
// — 4am UTC). The slot needs to be added to wrangler.toml.
// ─────────────────────────────────────────────────────────────────────────────

import { runAgent } from "../agent/loop.js";
import { runAI } from "../ai/gateway.js";
import { extractCFAIText } from "../ai/router.js";
import { createLogger } from "../lib/logger.js";
import type { Env } from "../types.js";

const log = createLogger({ component: "eval-runner" });

const JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const PASS_THRESHOLD_DEFAULT = 0.7;

export interface EvalCase {
	name: string;
	prompt: string;
	expected: string;
	user_aad_id: string;
	tags?: string[];
}

interface JudgeResponse {
	score: number;
	rationale: string;
}

/**
 * Eval cases are passed in by the caller (the cron loads them from a
 * KV blob or imports them as a static JSON array — bundling decision
 * is left to ops since it depends on dataset size).
 */
export async function runEvalSuite(cases: EvalCase[], judgePrompt: string, env: Env): Promise<{ runId: number; passed: number; total: number }> {
	const startedAt = Math.floor(Date.now() / 1000);
	const passThreshold = parseFloat((env as Env & { EVAL_PASS_THRESHOLD?: string }).EVAL_PASS_THRESHOLD ?? `${PASS_THRESHOLD_DEFAULT}`);

	const ins = await env.ARCADIA_DB.prepare(
		`INSERT INTO eval_runs (started_at, judge_model, cases_total) VALUES (?, ?, ?)`,
	)
		.bind(startedAt, JUDGE_MODEL, cases.length)
		.run();
	const runId = (ins.meta?.last_row_id as number | undefined) ?? 0;

	let passed = 0;

	for (const c of cases) {
		try {
			const agentOut = await runAgent({
				systemPrompt: "You are Arcadia. Answer the question using your tools and the asking user's M365 data.",
				userMessage: c.prompt,
				userAadId: c.user_aad_id,
				env,
			});

			const judge = await scoreWithJudge(c, agentOut.text, judgePrompt, env);
			const ok = judge.score >= passThreshold ? 1 : 0;
			if (ok) passed++;

			await env.ARCADIA_DB.prepare(
				`INSERT INTO eval_case_results (run_id, case_name, prompt, expected, actual, judge_score, judge_rationale, passed, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(runId, c.name, c.prompt, c.expected, agentOut.text, judge.score, judge.rationale, ok, Math.floor(Date.now() / 1000))
				.run();
		} catch (err) {
			log.warn("eval_case_failed", { case: c.name }, err);
			await env.ARCADIA_DB.prepare(
				`INSERT INTO eval_case_results (run_id, case_name, prompt, expected, actual, judge_score, judge_rationale, passed, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
			)
				.bind(runId, c.name, c.prompt, c.expected, `ERROR: ${err instanceof Error ? err.message : String(err)}`, 0, "exception during run", Math.floor(Date.now() / 1000))
				.run();
		}
	}

	const finishedAt = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`UPDATE eval_runs SET finished_at = ?, cases_passed = ? WHERE id = ?`,
	)
		.bind(finishedAt, passed, runId)
		.run();

	log.info("eval_run_complete", { runId, passed, total: cases.length, threshold: passThreshold });
	return { runId, passed, total: cases.length };
}

async function scoreWithJudge(c: EvalCase, actual: string, judgePrompt: string, env: Env): Promise<JudgeResponse> {
	const userBlock = `Question:\n${c.prompt}\n\nExpected answer (high-level):\n${c.expected}\n\nAssistant's actual answer:\n${actual}`;
	const result = await runAI(
		env,
		JUDGE_MODEL as Parameters<Ai["run"]>[0],
		{
			messages: [
				{ role: "system", content: judgePrompt },
				{ role: "user",   content: userBlock },
			],
			max_tokens: 256,
		} as Parameters<Ai["run"]>[1],
	);
	const text = extractCFAIText(result) ?? "";
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return { score: 0, rationale: "judge returned non-JSON" };
	try {
		const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
		const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
		return { score, rationale: parsed.rationale ?? "" };
	} catch {
		return { score: 0, rationale: "judge JSON parse failed" };
	}
}
