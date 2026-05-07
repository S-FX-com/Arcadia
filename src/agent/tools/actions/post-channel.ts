import { z } from "zod";
import type { Tool } from "../types.js";
import { getDelegatedAccessToken, graphPostAs } from "./util.js";
import { aclEnforcementMode, assertCanAccessResource } from "../../../graph/acl.js";

const Input = z.object({
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	body: z.string().min(1).max(20000).describe("Message body. Markdown rendered to Teams-supported subset."),
});

export const postChannelTool: Tool<z.infer<typeof Input>> = {
	name: "post_channel",
	description: "Post a message to a Teams channel AS THE ASKING USER. Will refuse to post to channels the asking user does not have access to.",
	schema: Input,
	handler: async ({ teamId, channelId, body }, { env, userAadId }) => {
		const enforcement = aclEnforcementMode(env);
		if (enforcement !== "off") {
			const ok = await assertCanAccessResource(userAadId, "teams_channel", `${teamId}:${channelId}`, env);
			if (!ok) return { content: "Access denied: you don't have permissions on that channel." };
		}
		const token = await getDelegatedAccessToken(userAadId, env);
		if (!token) {
			return { content: "needs_auth: no valid delegated token. Ask the user to sign in to Arcadia and retry." };
		}
		const message = {
			body: { contentType: "html", content: body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") },
		};
		const out = await graphPostAs(`/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`, message, token);
		if (!out.ok) {
			return { content: `Post failed (${out.status}): ${out.error.slice(0, 500)}` };
		}
		return { content: `Posted to channel ${channelId}.` };
	},
};
