import { z } from "zod";
import { semanticRecall } from "../../memory/vectors.js";
import { classifyLabel, redactContent } from "../../graph/sensitivity.js";
import type { Tool } from "./types.js";

const Input = z.object({
	query: z.string().min(1).describe("Natural-language query for semantic search across indexed documents and memories."),
	limit: z.number().int().min(1).max(20).optional().describe("Max results to return. Default 8."),
});

interface DocRow { sensitivity_label: string | null; title: string | null; uri: string | null }

export const searchDocumentsTool: Tool<z.infer<typeof Input>> = {
	name: "search_documents",
	description: "Semantic vector search across all indexed M365 content (documents, channel messages, mail). ACL-filtered. Sensitive matches are excerpted; secret matches are redacted to a citation only.",
	schema: Input,
	handler: async ({ query, limit }, { env, userAadId }) => {
		const matches = await semanticRecall(query, env, limit ?? 8, { aclUserAadId: userAadId });
		if (matches.length === 0) {
			return { content: "No matching documents found." };
		}

		// Pull sensitivity labels for each unique source resource so we can
		// redact at the boundary. One batched query keeps the hop cost down.
		const resourceKeys = new Map<string, { type: string; id: string }>();
		for (const m of matches) {
			const t = m.metadata.sourceResourceType, i = m.metadata.sourceResourceId;
			if (t && i) resourceKeys.set(`${t}:${i}`, { type: t, id: i });
		}
		const docByKey = new Map<string, DocRow>();
		if (resourceKeys.size > 0) {
			const pairs = Array.from(resourceKeys.values());
			const placeholders = pairs.map(() => "(?, ?)").join(",");
			const params: string[] = [];
			for (const r of pairs) params.push(r.type, r.id);
			const result = await env.ARCADIA_DB.prepare(
				`SELECT source_resource_type, source_resource_id, sensitivity_label, title, uri
				   FROM documents
				  WHERE (source_resource_type, source_resource_id) IN (${placeholders}) AND deleted_at IS NULL`,
			)
				.bind(...params)
				.all<{ source_resource_type: string; source_resource_id: string; sensitivity_label: string | null; title: string | null; uri: string | null }>();
			for (const row of result.results) {
				docByKey.set(`${row.source_resource_type}:${row.source_resource_id}`, row);
			}
		}

		const lines: string[] = [];
		const out: { content: string; citations: { resourceType: string; resourceId: string; label?: string }[] } = { content: "", citations: [] };

		matches.forEach((m, i) => {
			const t = m.metadata.sourceResourceType;
			const id = m.metadata.sourceResourceId;
			const key = t && id ? `${t}:${id}` : null;
			const doc = key ? docByKey.get(key) : undefined;
			const level = classifyLabel(doc?.sensitivity_label, env);
			const baseLine = `${i + 1}. [score=${m.score.toFixed(3)}] memory_id=${m.memoryId} (${m.metadata.category}, wing=${m.metadata.wing})`;
			const labelTag = doc?.sensitivity_label ? ` [label=${doc.sensitivity_label}]` : "";
			const titleTag = doc?.title ? ` "${doc.title}"` : "";
			lines.push(`${baseLine}${titleTag}${labelTag}`);

			if (level === "secret") {
				const r = redactContent("", level);
				lines.push(`   ${r.content}`);
			}

			if (t && id) {
				out.citations.push({
					resourceType: t,
					resourceId: id,
					...(doc?.title ? { label: doc.title } : {}),
				});
			}
		});

		out.content = lines.join("\n");
		return { content: out.content, citations: out.citations };
	},
};
