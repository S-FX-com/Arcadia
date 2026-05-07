// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Agent tool catalog (Phase 2)
//
// The four bootstrap tools the agent loop ships with. Add new ones here.
// Every read-side tool MUST honour ctx.userAadId for ACL.
// ─────────────────────────────────────────────────────────────────────────────

import { searchMemoryTool } from "./search-memory.js";
import { searchDocumentsTool } from "./search-documents.js";
import { searchTeamsMessagesTool } from "./search-teams-messages.js";
import { getCalendarTool } from "./get-calendar.js";
import { sendMailTool } from "./actions/send-mail.js";
import { postChannelTool } from "./actions/post-channel.js";
import { createPlannerTaskTool } from "./actions/create-planner-task.js";
import { createEventTool } from "./actions/create-event.js";
import type { Tool } from "./types.js";

export const TOOLS: Record<string, Tool> = {
	[searchMemoryTool.name]: searchMemoryTool as unknown as Tool,
	[searchDocumentsTool.name]: searchDocumentsTool as unknown as Tool,
	[searchTeamsMessagesTool.name]: searchTeamsMessagesTool as unknown as Tool,
	[getCalendarTool.name]: getCalendarTool as unknown as Tool,
	[sendMailTool.name]: sendMailTool as unknown as Tool,
	[postChannelTool.name]: postChannelTool as unknown as Tool,
	[createPlannerTaskTool.name]: createPlannerTaskTool as unknown as Tool,
	[createEventTool.name]: createEventTool as unknown as Tool,
};

export function getTool(name: string): Tool | undefined {
	return TOOLS[name];
}

export function listTools(): Tool[] {
	return Object.values(TOOLS);
}
