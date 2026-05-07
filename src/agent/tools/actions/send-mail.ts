import { z } from "zod";
import type { Tool } from "../types.js";
import { getDelegatedAccessToken, graphPostAs } from "./util.js";

const Input = z.object({
	to: z.array(z.string().email()).min(1).max(20).describe("Recipient email addresses."),
	cc: z.array(z.string().email()).max(20).optional(),
	subject: z.string().min(1).max(255),
	body: z.string().min(1).max(20000).describe("Email body. Plain text only; HTML not supported here."),
});

export const sendMailTool: Tool<z.infer<typeof Input>> = {
	name: "send_mail",
	description: "Send an email AS THE ASKING USER via Microsoft Graph. Use sparingly — this is a side-effect; users see it in their Sent folder.",
	schema: Input,
	handler: async ({ to, cc, subject, body }, { env, userAadId }) => {
		const token = await getDelegatedAccessToken(userAadId, env);
		if (!token) {
			return { content: "needs_auth: no valid delegated token. Ask the user to sign in to Arcadia and retry." };
		}
		const message = {
			message: {
				subject,
				body: { contentType: "Text", content: body },
				toRecipients: to.map((address) => ({ emailAddress: { address } })),
				...(cc && cc.length > 0 ? { ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } : {}),
			},
			saveToSentItems: true,
		};
		const out = await graphPostAs("/me/sendMail", message, token);
		if (!out.ok) {
			return { content: `Send failed (${out.status}): ${out.error.slice(0, 500)}` };
		}
		return { content: `Sent to ${to.join(", ")}.` };
	},
};
