// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — SharePoint producer (followed sites' default doc library)
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

const SP_OFFICE_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

interface Site { id: string; webUrl?: string; displayName?: string }
interface DriveItem {
	id: string;
	name?: string;
	webUrl?: string;
	file?: { mimeType?: string };
	folder?: object;
	"@microsoft.graph.downloadUrl"?: string;
	"@removed"?: { reason?: string };
}
interface FollowedResp { value: Site[] }
interface DeltaResp {
	value: DriveItem[];
	"@odata.nextLink"?: string;
	"@odata.deltaLink"?: string;
}

function relPath(absolute: string): string {
	return absolute.replace(/^https:\/\/[^/]+\/(?:v1\.0|beta)/, "");
}

export const sharepointProducer: Producer = {
	resourceKey: () => "sharepoint:followed",
	resourceType: "sharepoint_item",
	fetchPage: async (ctx: ProducerContext, previousLink: string | null): Promise<ProducerPage> => {
		// Multi-site behaviour: on the first pass we list followed sites and
		// stash the first one's drive delta cursor; subsequent passes follow
		// that cursor. Cross-site rotation is left as a future enhancement —
		// the current cursor scheme handles a single primary site.
		let path = previousLink;
		if (!path) {
			const followed = await fetch(`${GRAPH.BASE_URL}/me/followedSites?$top=10`, {
				headers: { Authorization: `Bearer ${ctx.accessToken}` },
			});
			if (!followed.ok) throw new Error(`followedSites fetch failed ${followed.status}`);
			const list = (await followed.json()) as FollowedResp;
			const first = list.value[0];
			if (!first) return { changes: [], cursor: "sharepoint:none", done: true };
			path = `/sites/${encodeURIComponent(first.id)}/drive/root/delta`;
		}

		const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) throw new Error(`sharepoint delta failed ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as DeltaResp;

		const changes: ProducedChange[] = [];
		for (const item of body.value) {
			if (item["@removed"]) {
				changes.push({ message: { kind: "remove", resourceType: "sharepoint_item", resourceId: item.id } });
				continue;
			}
			if (item.folder || !item.file) continue;
			const mime = item.file.mimeType ?? null;
			const isOffice = !!mime && SP_OFFICE_MIMES.has(mime);
			// As with OneDrive: route Office formats through Graph's PDF
			// conversion so the PDF parser handles them.
			const contentUri = isOffice
				? `${GRAPH.BASE_URL}/sites/${encodeURIComponent(item.id.split(",")[0] ?? "")}/drive/items/${encodeURIComponent(item.id)}/content?format=pdf`
				: item["@microsoft.graph.downloadUrl"];
			if (!contentUri) continue;
			changes.push({
				message: {
					kind: "upsert",
					resourceType: "sharepoint_item",
					resourceId: item.id,
					contentUri,
					accessToken: ctx.accessToken,
					mime: isOffice ? "application/pdf" : mime,
					...(item.name ? { title: item.name } : {}),
				},
				// SharePoint ACLs are not derived here; the consumer/cron is
				// responsible for calling /drives/{id}/items/{id}/permissions
				// when populating resource_acl. Leaving principals empty
				// means the consumer won't write ACL rows automatically and
				// strict-mode recall will hide the doc until ACLs are set.
				principals: [{ aadId: ctx.userAadId, kind: "user" }],
			});
		}

		const next = body["@odata.nextLink"];
		const delta = body["@odata.deltaLink"];
		const cursor = next ?? delta ?? path;
		return { changes, cursor: relPath(cursor), done: !next };
	},
};
