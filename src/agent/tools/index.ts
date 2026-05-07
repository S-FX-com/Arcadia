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
import type { Tool } from "./types.js";

export const TOOLS: Record<string, Tool> = {
	[searchMemoryTool.name]: searchMemoryTool as unknown as Tool,
	[searchDocumentsTool.name]: searchDocumentsTool as unknown as Tool,
	[searchTeamsMessagesTool.name]: searchTeamsMessagesTool as unknown as Tool,
	[getCalendarTool.name]: getCalendarTool as unknown as Tool,
};

export function getTool(name: string): Tool | undefined {
	return TOOLS[name];
}

export function listTools(): Tool[] {
	return Object.values(TOOLS);
}
