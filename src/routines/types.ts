// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Routine types (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const TriggerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("cron"),         expr: z.string().min(1) }),
	z.object({ kind: z.literal("graph_event"),  resource: z.string().min(1), changeType: z.enum(["created", "updated", "deleted"]) }),
	z.object({ kind: z.literal("chat_intent"),  pattern: z.string().min(1) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const StepSchema = z.object({
	tool: z.string().min(1),
	args: z.record(z.unknown()).optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const RoutineDefinitionSchema = z.object({
	name: z.string().min(1).max(120),
	description: z.string().max(500).optional(),
	trigger: TriggerSchema,
	steps: z.array(StepSchema).min(1).max(20),
	enabled: z.boolean().optional(),
});
export type RoutineDefinition = z.infer<typeof RoutineDefinitionSchema>;

export interface RoutineRow {
	id: string;
	owner_aad_id: string;
	name: string;
	description: string | null;
	trigger_json: string;
	steps_json: string;
	enabled: number;
	created_at: number;
	updated_at: number;
	last_run_at: number | null;
}

export interface RoutineRunRow {
	id: number;
	routine_id: string;
	started_at: number;
	finished_at: number | null;
	status: "running" | "success" | "failed";
	steps_completed: number;
	log_json: string | null;
}

export interface StepResult {
	tool: string;
	ok: boolean;
	output?: string;
	error?: string;
	durationMs: number;
}
