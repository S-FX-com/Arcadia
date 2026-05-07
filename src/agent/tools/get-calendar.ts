import { z } from "zod";
import type { Tool } from "./types.js";

const Input = z.object({
	daysAhead: z.number().int().min(1).max(30).optional().describe("Number of days from today to scan. Default 7."),
});

interface CalendarEvent {
	id: string;
	subject?: string;
	start?: { dateTime?: string };
	end?: { dateTime?: string };
	location?: { displayName?: string };
	organizer?: { emailAddress?: { name?: string } };
}

export const getCalendarTool: Tool<z.infer<typeof Input>> = {
	name: "get_calendar",
	description: "Fetch the asking user's upcoming calendar events from Microsoft Graph (delegated).",
	schema: Input,
	handler: async ({ daysAhead }, { env, userAadId }) => {
		const days = daysAhead ?? 7;
		// Look up the user's most recent webapp session token.
		const row = await env.ARCADIA_DB.prepare(
			`SELECT access_token, token_expiry FROM webapp_sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1`,
		)
			.bind(userAadId)
			.first<{ access_token: string; token_expiry: number }>();
		if (!row || row.token_expiry < Math.floor(Date.now() / 1000)) {
			return { content: "Calendar unavailable: no valid delegated session for this user. Ask them to sign in to Arcadia first." };
		}
		const { decryptToken } = await import("../../webapp/crypto.js");
		const token = await decryptToken(row.access_token, env.WEBAPP_SESSION_SECRET);

		const start = new Date().toISOString();
		const end = new Date(Date.now() + days * 86400_000).toISOString();
		const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$select=id,subject,start,end,location,organizer&$orderby=start/dateTime&$top=50`;
		const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) {
			return { content: `Calendar fetch failed (${res.status}).` };
		}
		const body = (await res.json()) as { value: CalendarEvent[] };
		if (body.value.length === 0) return { content: `No calendar events in the next ${days} days.` };
		const lines = body.value.map((ev) => {
			const when = ev.start?.dateTime?.slice(0, 16).replace("T", " ") ?? "?";
			const where = ev.location?.displayName ? ` @ ${ev.location.displayName}` : "";
			const who = ev.organizer?.emailAddress?.name ? ` (organizer: ${ev.organizer.emailAddress.name})` : "";
			return `- ${when}: ${ev.subject ?? "(no subject)"}${where}${who}`;
		});
		return { content: lines.join("\n") };
	},
};
