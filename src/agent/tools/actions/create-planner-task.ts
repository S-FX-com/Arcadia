import { z } from "zod";
import type { Tool } from "../types.js";
import { getDelegatedAccessToken, graphPostAs } from "./util.js";

const Input = z.object({
	planId: z.string().min(1).describe("Planner plan id to create the task in."),
	title: z.string().min(1).max(255),
	bucketId: z.string().optional(),
	dueIso: z.string().datetime().optional().describe("ISO 8601 due date."),
	assigneeAadId: z.string().optional().describe("AAD object id of the assignee. Omit to leave unassigned."),
});

export const createPlannerTaskTool: Tool<z.infer<typeof Input>> = {
	name: "create_planner_task",
	description: "Create a new Planner task AS THE ASKING USER. Returns the new task id.",
	schema: Input,
	handler: async ({ planId, title, bucketId, dueIso, assigneeAadId }, { env, userAadId }) => {
		const token = await getDelegatedAccessToken(userAadId, env);
		if (!token) {
			return { content: "needs_auth: no valid delegated token. Ask the user to sign in to Arcadia and retry." };
		}
		const body: Record<string, unknown> = {
			planId,
			title,
			...(bucketId ? { bucketId } : {}),
			...(dueIso ? { dueDateTime: dueIso } : {}),
		};
		if (assigneeAadId) {
			body.assignments = { [assigneeAadId]: { "@odata.type": "#microsoft.graph.plannerAssignment", orderHint: " !" } };
		}
		const out = await graphPostAs("/planner/tasks", body, token);
		if (!out.ok) {
			return { content: `Create failed (${out.status}): ${out.error.slice(0, 500)}` };
		}
		const created = out.json as { id?: string };
		return { content: `Created Planner task ${created.id ?? "(no id)"}.` };
	},
};
