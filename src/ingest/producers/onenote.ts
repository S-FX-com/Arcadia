// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — OneNote producer (pages across all the user's notebooks)
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

interface Page {
	id: string;
	title?: string;
	lastModifiedDateTime?: string;
	contentUrl?: string;
	links?: { oneNoteWebUrl?: { href?: string } };
}

interface Resp { value: Page[]; "@odata.nextLink"?: string }

const INITIAL_PATH = "/me/onenote/pages?$top=100&$orderby=lastModifiedDateTime desc";

function relPath(absolute: string): string {
	return absolute.replace(/^https:\/\/[^/]+\/(?:v1\.0|beta)/, "");
}

export const onenoteProducer: Producer = {
	resourceKey: () => "onenote:me",
	resourceType: "onenote_page",
	fetchPage: async (ctx: ProducerContext, previousLink: string | null): Promise<ProducerPage> => {
		const path = previousLink ?? INITIAL_PATH;
		const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) throw new Error(`onenote fetch failed ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as Resp;

		const changes: ProducedChange[] = body.value
			.filter((p) => p.contentUrl)
			.map((p) => ({
				message: {
					kind: "upsert",
					resourceType: "onenote_page",
					resourceId: p.id,
					contentUri: p.contentUrl!,
					accessToken: ctx.accessToken,
					// Special MIME so the OneNote parser is selected.
					mime: "application/vnd.arcadia.onenote+html",
					...(p.title ? { title: p.title } : {}),
				},
				principals: [{ aadId: ctx.userAadId, kind: "user" }],
			}));

		const next = body["@odata.nextLink"];
		const cursor = next ? relPath(next) : INITIAL_PATH;
		return { changes, cursor, done: !next };
	},
};
