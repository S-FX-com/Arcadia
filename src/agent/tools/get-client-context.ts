// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_client_context
//
// Pulls grounded context for a specific Client: name, description, bound
// sources (channels, chats, SharePoint sites, Planner plans) and the top-K
// rolling memories. The agent uses this in CLIENT MODE before answering
// substantive questions about that client.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { ClientRow, ClientSourceRow, ClientMemoryRow } from "../../types.js";
import type { Tool, ToolCitation } from "./types.js";

const Input = z.object({
	clientId: z
		.string()
		.min(1)
		.describe("The client id from list_clients. Required."),
	memoryLimit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max rolling memories to include. Default 15, ordered by importance."),
});

export const getClientContextTool: Tool<z.infer<typeof Input>> = {
	name: "get_client_context",
	description:
		"Load the grounded context for a specific Client: bound Teams channels/chats, SharePoint sites, Planner plans, and the rolling memories Arcadia has accumulated for that client. Call after list_clients once you have a confident name match.",
	schema: Input,
	handler: async ({ clientId, memoryLimit }, { env }) => {
		const client = await env.ARCADIA_DB.prepare(
			"SELECT id, name, description, index_status, memory_summary, index_completed_at FROM clients WHERE id = ?",
		)
			.bind(clientId)
			.first<Pick<ClientRow, "id" | "name" | "description" | "index_status" | "memory_summary" | "index_completed_at">>();

		if (!client) {
			return {
				content: `No Client found with id="${clientId}". Call list_clients again — the id may be stale.`,
			};
		}

		const [sourcesResult, memoriesResult] = await Promise.all([
			env.ARCADIA_DB.prepare(
				"SELECT source_type, source_id, source_name, team_id FROM client_sources WHERE client_id = ? ORDER BY source_type, source_name",
			)
				.bind(clientId)
				.all<Pick<ClientSourceRow, "source_type" | "source_id" | "source_name" | "team_id">>(),
			env.ARCADIA_DB.prepare(
				"SELECT id, category, content, importance FROM client_memories WHERE client_id = ? ORDER BY importance DESC, updated_at DESC LIMIT ?",
			)
				.bind(clientId, memoryLimit ?? 15)
				.all<Pick<ClientMemoryRow, "id" | "category" | "content" | "importance">>(),
		]);

		const sources = sourcesResult.results ?? [];
		const memories = memoriesResult.results ?? [];

		const sections: string[] = [];
		sections.push(`Client: ${client.name}${client.description ? ` — ${client.description}` : ""}`);
		sections.push(
			`Index status: ${client.index_status}${
				client.index_completed_at
					? ` (last indexed ${new Date(client.index_completed_at * 1000).toISOString().slice(0, 10)})`
					: ""
			}`,
		);

		if (client.memory_summary) {
			sections.push(`Rolling summary:\n${client.memory_summary}`);
		}

		if (sources.length > 0) {
			const grouped: Record<string, string[]> = {};
			for (const s of sources) {
				const bucket = grouped[s.source_type] ?? (grouped[s.source_type] = []);
				bucket.push(s.source_name);
			}
			const lines = Object.entries(grouped)
				.map(([t, names]) => `- ${t} (${names.length}): ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, +${names.length - 8} more` : ""}`)
				.join("\n");
			sections.push(`Bound sources:\n${lines}`);
		} else {
			sections.push(
				"Bound sources: none yet. The user should add channels/chats/SharePoint/Planner bindings at /clients/" + clientId + " for grounded answers to be possible.",
			);
		}

		if (memories.length > 0) {
			const lines = memories.map(
				(m, i) => `${i + 1}. [${m.category}] ${m.content} (importance ${m.importance.toFixed(2)})`,
			);
			sections.push(`Top memories:\n${lines.join("\n")}`);
		} else {
			sections.push("No memories recorded yet for this client.");
		}

		const citations: ToolCitation[] = [
			{ resourceType: "client", resourceId: client.id, label: client.name, url: `/clients/${client.id}` },
		];

		return {
			content: sections.join("\n\n"),
			citations,
		};
	},
};
