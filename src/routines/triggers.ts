// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Routine trigger router (Phase 4)
//
// dispatchCronRoutines() is meant to be called from the existing 6h
// cron slot (or a dedicated minute slot once one is added). It walks
// enabled routines whose trigger.kind === 'cron' and whose schedule
// matches "now", and runs each via the executor.
//
// Cron expression matching is intentionally simple (whole-minute, UTC,
// supports the standard 5-field cron) to avoid pulling in a parser
// dependency. Operators that want fancier expressions can run the
// router on a finer cadence and accept that resolution.
// ─────────────────────────────────────────────────────────────────────────────

import { executeRoutine } from "./executor.js";
import { createLogger } from "../lib/logger.js";
import type { RoutineRow, Trigger } from "./types.js";
import type { Env } from "../types.js";

const log = createLogger({ component: "routine-triggers" });

export async function dispatchCronRoutines(env: Env, ctx?: ExecutionContext, now: Date = new Date()): Promise<{ matched: number; ran: number; failed: number }> {
	const rows = await env.ARCADIA_DB.prepare(
		`SELECT * FROM routines WHERE enabled = 1`,
	).all<RoutineRow>();

	let matched = 0;
	let ran = 0;
	let failed = 0;

	for (const row of rows.results) {
		let trigger: Trigger;
		try { trigger = JSON.parse(row.trigger_json) as Trigger; } catch { continue; }
		if (trigger.kind !== "cron") continue;
		if (!cronMatches(trigger.expr, now)) continue;
		matched++;
		try {
			const result = await executeRoutine(row, env, ctx);
			if (result.status === "success") ran++; else failed++;
		} catch (err) {
			log.warn("routine_dispatch_failed", { routineId: row.id }, err);
			failed++;
		}
	}

	log.info("routine_cron_dispatch", { matched, ran, failed });
	return { matched, ran, failed };
}

/**
 * Match a 5-field cron expression (minute, hour, day-of-month, month,
 * day-of-week) against a Date. Each field accepts:
 *   *               — any value
 *   number          — literal
 *   a,b,c           — set
 *   a-b             — range
 *   * /n            — every n
 * Whole-minute resolution; UTC. Sufficient for the routines use case;
 * not a full RFC reimplementation.
 */
export function cronMatches(expr: string, d: Date): boolean {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
	return (
		matchField(min,  d.getUTCMinutes(),    0, 59) &&
		matchField(hour, d.getUTCHours(),      0, 23) &&
		matchField(dom,  d.getUTCDate(),       1, 31) &&
		matchField(mon,  d.getUTCMonth() + 1,  1, 12) &&
		matchField(dow,  d.getUTCDay(),        0, 6)
	);
}

function matchField(field: string, value: number, min: number, max: number): boolean {
	for (const part of field.split(",")) {
		if (matchOne(part, value, min, max)) return true;
	}
	return false;
}

function matchOne(part: string, value: number, min: number, max: number): boolean {
	if (part === "*") return true;
	const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
	if (stepMatch) {
		const range = stepMatch[1]!;
		const step = parseInt(stepMatch[2]!, 10);
		const lo = range === "*" ? min : parseInt(range.split("-")[0]!, 10);
		const hi = range === "*" ? max : parseInt(range.split("-")[1] ?? range, 10);
		if (value < lo || value > hi) return false;
		return (value - lo) % step === 0;
	}
	const rangeMatch = part.match(/^(\d+)-(\d+)$/);
	if (rangeMatch) {
		const lo = parseInt(rangeMatch[1]!, 10);
		const hi = parseInt(rangeMatch[2]!, 10);
		return value >= lo && value <= hi;
	}
	const literal = parseInt(part, 10);
	if (Number.isNaN(literal)) return false;
	return value === literal;
}
