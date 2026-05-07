// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Calendar producer (next 30 days)
//
// Calendar doesn't expose a true delta on /me/calendar/events, so this
// producer sweeps a rolling 30-day window each pass. It's safe because
// the consumer uses content_sha256 for re-ingest dedup.
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

interface Event {
	id: string;
	subject?: string;
	bodyPreview?: string;
	body?: { contentType?: string; content?: string };
	start?: { dateTime?: string };
	end?: { dateTime?: string };
	location?: { displayName?: string };
	webLink?: string;
}

interface Resp { value: Event[] }

export const calendarProducer: Producer = {
	resourceKey: () => "calendar:me",
	resourceType: "calendar_event",
	fetchPage: async (ctx: ProducerContext, _previousLink: string | null): Promise<ProducerPage> => {
		const start = new Date(Date.now() - 7 * 86400_000).toISOString();
		const end = new Date(Date.now() + 30 * 86400_000).toISOString();
		const path = `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=100&$select=id,subject,bodyPreview,body,start,end,location,webLink`;
		const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) throw new Error(`calendar fetch failed ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as Resp;

		const changes: ProducedChange[] = body.value.map((ev) => {
			const text = `Subject: ${ev.subject ?? ""}
Start: ${ev.start?.dateTime ?? ""}
End: ${ev.end?.dateTime ?? ""}
Location: ${ev.location?.displayName ?? ""}

${ev.bodyPreview ?? ""}`;
			const dataUri = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(text)))}`;
			return {
				message: {
					kind: "upsert",
					resourceType: "calendar_event",
					resourceId: ev.id,
					contentUri: dataUri,
					accessToken: ctx.accessToken,
					mime: "text/plain",
					...(ev.subject ? { title: ev.subject } : {}),
				},
				principals: [{ aadId: ctx.userAadId, kind: "user" }],
			};
		});

		// No real cursor; return a stable opaque token.
		return { changes, cursor: "calendar:swept", done: true };
	},
};
