import { z } from "zod";
import { recallMemories } from "../../memory/long-term.js";
import type { Tool } from "./types.js";

const Input = z.object({
	query: z.string().min(1).describe("Natural-language query to search Arcadia's long-term memory."),
	limit: z.number().int().min(1).max(20).optional().describe("Max memories to return. Default 5."),
});

export const searchMemoryTool: Tool<z.infer<typeof Input>> = {
	name: "search_memory",
	description: "Search Arcadia's long-term memory of facts, decisions, and observations. Filters automatically by the asking user's M365 permissions.",
	schema: Input,
	handler: async ({ query, limit }, { env, userAadId }) => {
		const memories = await recallMemories(query, env, limit ?? 5, { aclUserAadId: userAadId });
		if (memories.length === 0) {
			return { content: "No matching memories found." };
		}
		const lines = memories.map((m, i) => `${i + 1}. [${m.category}] ${m.content} (importance ${m.importance.toFixed(2)})`);
		return { content: lines.join("\n") };
	},
};
