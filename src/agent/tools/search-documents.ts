import { z } from "zod";
import { semanticRecall } from "../../memory/vectors.js";
import type { Tool } from "./types.js";

const Input = z.object({
	query: z.string().min(1).describe("Natural-language query for semantic search across indexed documents and memories."),
	limit: z.number().int().min(1).max(20).optional().describe("Max results to return. Default 8."),
});

export const searchDocumentsTool: Tool<z.infer<typeof Input>> = {
	name: "search_documents",
	description: "Semantic vector search across all indexed M365 content (documents, channel messages, mail). ACL-filtered.",
	schema: Input,
	handler: async ({ query, limit }, { env, userAadId }) => {
		const matches = await semanticRecall(query, env, limit ?? 8, { aclUserAadId: userAadId });
		if (matches.length === 0) {
			return { content: "No matching documents found." };
		}
		const lines = matches.map((m, i) => `${i + 1}. [score=${m.score.toFixed(3)}] memory_id=${m.memoryId} (${m.metadata.category}, wing=${m.metadata.wing})`);
		const citations = matches
			.filter((m) => m.metadata.sourceResourceType && m.metadata.sourceResourceId)
			.map((m) => ({
				resourceType: m.metadata.sourceResourceType!,
				resourceId: m.metadata.sourceResourceId!,
			}));
		return { content: lines.join("\n"), citations };
	},
};
