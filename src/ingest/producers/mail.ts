// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Mail producer (inbox delta)
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

interface MailMessage {
	id: string;
	subject?: string;
	bodyPreview?: string;
	body?: { contentType?: string; content?: string };
	webLink?: string;
	"@removed"?: { reason?: string };
}

interface DeltaResp {
	value: MailMessage[];
	"@odata.nextLink"?: string;
	"@odata.deltaLink"?: string;
}

const INITIAL_PATH = "/me/mailFolders('inbox')/messages/delta?$select=id,subject,bodyPreview,body,webLink";

function relPath(absolute: string): string {
	return absolute.replace(/^https:\/\/[^/]+\/(?:v1\.0|beta)/, "");
}

export const mailProducer: Producer = {
	resourceKey: () => "mail:inbox",
	resourceType: "mail_message",
	fetchPage: async (ctx: ProducerContext, previousLink: string | null): Promise<ProducerPage> => {
		const path = previousLink ?? INITIAL_PATH;
		const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) {
			throw new Error(`mail delta failed ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as DeltaResp;
		const changes: ProducedChange[] = [];

		for (const m of body.value) {
			if (m["@removed"]) {
				changes.push({
					message: { kind: "remove", resourceType: "mail_message", resourceId: m.id },
				});
				continue;
			}
			// Mail content arrives inline in the delta; we can fetch a richer
			// version if needed via a follow-up GET. For now, write the body
			// preview and let the consumer parse via the HTML parser.
			const html = m.body?.contentType === "html" ? m.body.content ?? "" : `<pre>${(m.body?.content ?? m.bodyPreview ?? "").replace(/[<>&]/g, "")}</pre>`;
			const dataUri = `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`;
			changes.push({
				message: {
					kind: "upsert",
					resourceType: "mail_message",
					resourceId: m.id,
					contentUri: dataUri,
					accessToken: ctx.accessToken,
					mime: "text/html",
					...(m.subject ? { title: m.subject } : {}),
				},
				// Caller (driver) attaches principals = [self] for personal mail.
				principals: [{ aadId: ctx.userAadId, kind: "user" }],
			});
		}

		const next = body["@odata.nextLink"];
		const delta = body["@odata.deltaLink"];
		const cursor = next ?? delta ?? path;
		return { changes, cursor: relPath(cursor), done: !next };
	},
};
