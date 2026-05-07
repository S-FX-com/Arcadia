import { z } from "zod";
import { loadCachedMessages } from "../../memory/kv.js";
import { getAllChannels } from "../../memory/d1.js";
import { assertCanAccessResource } from "../../graph/acl.js";
import { aclEnforcementMode } from "../../graph/acl.js";
import type { Tool } from "./types.js";

const Input = z.object({
	query: z.string().min(1).describe("Substring to match against cached Teams channel messages."),
	limit: z.number().int().min(1).max(50).optional().describe("Max messages to return. Default 15."),
});

export const searchTeamsMessagesTool: Tool<z.infer<typeof Input>> = {
	name: "search_teams_messages",
	description: "Search recent Teams channel messages cached by Arcadia. Filtered by the asking user's channel ACLs.",
	schema: Input,
	handler: async ({ query, limit }, { env, userAadId }) => {
		const channels = await getAllChannels(env);
		const enforcement = aclEnforcementMode(env);
		const needle = query.toLowerCase();
		const cap = limit ?? 15;
		const hits: Array<{ channel: string; author: string; text: string; ts: string; teamId: string; channelId: string }> = [];

		for (const ch of channels) {
			if (hits.length >= cap) break;
			// ACL gate per channel — if enforcement is off, allow all.
			if (enforcement !== "off") {
				const allowed = await assertCanAccessResource(userAadId, "teams_channel", `${ch.team_id}:${ch.channel_id}`, env);
				if (!allowed) continue;
			}
			const msgs = await loadCachedMessages(ch.team_id, ch.channel_id, env).catch(() => []);
			for (const m of msgs) {
				if (m.text.toLowerCase().includes(needle)) {
					hits.push({ channel: ch.channel_name, author: m.authorName, text: m.text, ts: m.timestamp, teamId: ch.team_id, channelId: ch.channel_id });
					if (hits.length >= cap) break;
				}
			}
		}

		if (hits.length === 0) return { content: "No matching messages." };
		const lines = hits.map((h, i) => `${i + 1}. [${h.ts.slice(0, 10)} ${h.channel}] ${h.author}: ${h.text.slice(0, 200)}`);
		const citations = hits.map((h) => ({
			resourceType: "teams_channel",
			resourceId: `${h.teamId}:${h.channelId}`,
			label: h.channel,
		}));
		return { content: lines.join("\n"), citations };
	},
};
