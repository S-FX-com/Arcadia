import { z } from "zod";
import type { Tool } from "../types.js";
import { getDelegatedAccessToken, graphPostAs } from "./util.js";

const Input = z.object({
	subject: z.string().min(1).max(255),
	startIso: z.string().datetime(),
	endIso: z.string().datetime(),
	timezone: z.string().optional(),
	bodyText: z.string().max(20000).optional(),
	attendees: z.array(z.string().email()).max(50).optional(),
	location: z.string().max(255).optional(),
});

export const createEventTool: Tool<z.infer<typeof Input>> = {
	name: "create_event",
	description: "Create a calendar event AS THE ASKING USER. Optionally invites attendees.",
	schema: Input,
	handler: async ({ subject, startIso, endIso, timezone, bodyText, attendees, location }, { env, userAadId }) => {
		const token = await getDelegatedAccessToken(userAadId, env);
		if (!token) {
			return { content: "needs_auth: no valid delegated token. Ask the user to sign in to Arcadia and retry." };
		}
		const tz = timezone ?? "UTC";
		const body = {
			subject,
			start: { dateTime: startIso, timeZone: tz },
			end:   { dateTime: endIso,   timeZone: tz },
			...(bodyText ? { body: { contentType: "Text", content: bodyText } } : {}),
			...(location ? { location: { displayName: location } } : {}),
			...(attendees && attendees.length > 0
				? { attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: "required" })) }
				: {}),
		};
		const out = await graphPostAs("/me/events", body, token);
		if (!out.ok) {
			return { content: `Create failed (${out.status}): ${out.error.slice(0, 500)}` };
		}
		const created = out.json as { id?: string; webLink?: string };
		return { content: `Created event ${created.id ?? "(no id)"}${created.webLink ? ` (${created.webLink})` : ""}.` };
	},
};
