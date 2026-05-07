// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Routine executor (Phase 4)
//
// Runs a routine end-to-end:
//   1. Open a routine_runs row in 'running' state.
//   2. Walk steps[] serially. Each step is a tool call against the
//      Phase 2 agent tool registry (read tools) OR an action tool (write
//      tools — sendMail, postToChannel, createPlannerTask, ...) when
//      added later.
//   3. Tool input is validated by the tool's zod schema. Invalid input
//      fails the routine (stop, mark failed); errors thrown by handler
//      fail the routine identically. No partial commit logic — operators
//      design their step lists to be idempotent.
//   4. Close the run row with the per-step log so the UI can render it.
//
// All tools execute as the routine's OWNER (not the user who triggered
// the run). This is intentional: routines are saved by their owner with
// their permissions; running them with anyone else's identity would
// silently leak data across user boundaries.
// ─────────────────────────────────────────────────────────────────────────────

import { getTool } from "../agent/tools/index.js";
import { createLogger } from "../lib/logger.js";
import type { Env } from "../types.js";
import { RoutineDefinitionSchema, type RoutineDefinition, type RoutineRow, type StepResult } from "./types.js";

const log = createLogger({ component: "routine-executor" });

export async function executeRoutine(routine: RoutineRow, env: Env, ctx?: ExecutionContext): Promise<{ runId: number; status: "success" | "failed"; results: StepResult[] }> {
	const def = parseRoutine(routine);

	const startedAt = Math.floor(Date.now() / 1000);
	const runInsert = await env.ARCADIA_DB.prepare(
		`INSERT INTO routine_runs (routine_id, started_at, status, steps_completed) VALUES (?, ?, 'running', 0)`,
	)
		.bind(routine.id, startedAt)
		.run();
	const runId = (runInsert.meta?.last_row_id as number | undefined) ?? 0;

	const results: StepResult[] = [];
	let status: "success" | "failed" = "success";

	for (const step of def.steps) {
		const tool = getTool(step.tool);
		const stepStart = Date.now();
		if (!tool) {
			results.push({ tool: step.tool, ok: false, error: `unknown tool "${step.tool}"`, durationMs: 0 });
			status = "failed";
			break;
		}
		const parsed = tool.schema.safeParse(step.args ?? {});
		if (!parsed.success) {
			results.push({ tool: step.tool, ok: false, error: `invalid args: ${JSON.stringify(parsed.error.issues)}`, durationMs: Date.now() - stepStart });
			status = "failed";
			break;
		}
		try {
			const out = await tool.handler(parsed.data, {
				env,
				userAadId: routine.owner_aad_id,
				...(ctx ? { ctx } : {}),
			});
			results.push({ tool: step.tool, ok: true, output: out.content, durationMs: Date.now() - stepStart });
			await env.ARCADIA_DB.prepare(`UPDATE routine_runs SET steps_completed = steps_completed + 1 WHERE id = ?`).bind(runId).run();
		} catch (err) {
			log.warn("routine_step_failed", { routineId: routine.id, tool: step.tool }, err);
			results.push({ tool: step.tool, ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - stepStart });
			status = "failed";
			break;
		}
	}

	const finishedAt = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`UPDATE routine_runs SET finished_at = ?, status = ?, log_json = ? WHERE id = ?`,
	)
		.bind(finishedAt, status, JSON.stringify(results), runId)
		.run();

	await env.ARCADIA_DB.prepare(`UPDATE routines SET last_run_at = ? WHERE id = ?`).bind(finishedAt, routine.id).run();

	log.info("routine_complete", { routineId: routine.id, runId, status, steps: results.length });
	return { runId, status, results };
}

export function parseRoutine(routine: RoutineRow): RoutineDefinition {
	const def: RoutineDefinition = {
		name: routine.name,
		...(routine.description ? { description: routine.description } : {}),
		trigger: JSON.parse(routine.trigger_json),
		steps: JSON.parse(routine.steps_json),
		enabled: routine.enabled === 1,
	};
	const validated = RoutineDefinitionSchema.parse(def);
	return validated;
}
