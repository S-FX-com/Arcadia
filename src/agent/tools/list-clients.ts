// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_clients
//
// Returns the catalog of defined Clients so the agent can match a user's
// reference (e.g. "the Acme account") to a known client id before grounding.
// Read-only; no ACL filter — Client definitions are tenant-scoped metadata,
// not message bodies. Source-level ACL is enforced inside get_client_context
// when individual channels/chats/sites are accessed.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { ClientRow } from "../../types.js";
import type { Tool } from "./types.js";

const Input = z.object({
	nameFilter: z
		.string()
		.optional()
		.describe("Optional case-insensitive substring to narrow the list. Use the literal name the user said."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max clients to return. Default 25."),
});

export const listClientsTool: Tool<z.infer<typeof Input>> = {
	name: "list_clients",
	description:
		"List all Clients defined in this tenant. Call this BEFORE answering any question that names a specific client, so you can resolve the name to a client id and decide between CLIENT MODE and 'offer to define a new client'.",
	schema: Input,
	handler: async ({ nameFilter, limit }, { env }) => {
		const cap = limit ?? 25;
		const rows = await env.ARCADIA_DB.prepare(
			"SELECT id, name, description, index_status FROM clients ORDER BY name ASC LIMIT ?",
		)
			.bind(Math.min(cap * 4, 200))
			.all<Pick<ClientRow, "id" | "name" | "description" | "index_status">>();

		let results = rows.results ?? [];
		if (nameFilter && nameFilter.trim().length > 0) {
			const needle = nameFilter.trim().toLowerCase();
			results = results.filter((r) => r.name.toLowerCase().includes(needle));
		}
		results = results.slice(0, cap);

		if (results.length === 0) {
			return {
				content: nameFilter
					? `No Client matches "${nameFilter}". The user is referencing a client that has not been defined. Offer to define it via /clients/new?name=${encodeURIComponent(nameFilter)} and stop — do not invent client details.`
					: "No Clients are defined in this tenant yet. Suggest the user create one at /clients/new.",
			};
		}

		const lines = results.map(
			(r) =>
				`- id=${r.id} | name="${r.name}" | status=${r.index_status}${r.description ? ` | ${r.description}` : ""}`,
		);
		return {
			content: `Defined Clients (${results.length}):\n${lines.join("\n")}\n\nIf one of these matches the user's reference, call get_client_context with its id. If none matches and the user clearly named a client not on this list, offer to define it.`,
		};
	},
};
