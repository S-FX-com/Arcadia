// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — OneDrive producer (root delta)
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import { getTeamsChatPrincipals } from "../../graph/acl.js";
import type { AclPrincipal } from "../../types.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

const OFFICE_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

interface DriveItem {
	id: string;
	name?: string;
	webUrl?: string;
	file?: { mimeType?: string };
	folder?: object;
	"@microsoft.graph.downloadUrl"?: string;
	"@removed"?: { reason?: string };
}

interface DeltaResp {
	value: DriveItem[];
	"@odata.nextLink"?: string;
	"@odata.deltaLink"?: string;
}

const INITIAL_PATH = "/me/drive/root/delta";

function relPath(absolute: string): string {
	return absolute.replace(/^https:\/\/[^/]+\/(?:v1\.0|beta)/, "");
}

export const driveProducer: Producer = {
	resourceKey: () => "drive:root",
	resourceType: "onedrive_item",
	fetchPage: async (ctx: ProducerContext, previousLink: string | null): Promise<ProducerPage> => {
		const path = previousLink ?? INITIAL_PATH;
		const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) throw new Error(`drive delta failed ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as DeltaResp;

		const changes: ProducedChange[] = [];
		const owner: AclPrincipal[] = [{ aadId: ctx.userAadId, kind: "user" }];
		void getTeamsChatPrincipals;  // imported for future shared-folder ACL resolution

		for (const item of body.value) {
			if (item["@removed"]) {
				changes.push({ message: { kind: "remove", resourceType: "onedrive_item", resourceId: item.id } });
				continue;
			}
			// Skip folders — only files have downloadable content.
			if (item.folder || !item.file) continue;
			const mime = item.file.mimeType ?? null;
			const isOffice = !!mime && OFFICE_MIMES.has(mime);
			// For Office formats, hop through Graph's PDF conversion so the
			// PDF parser can handle the result. For everything else, use the
			// pre-signed downloadUrl directly.
			const contentUri = isOffice
				? `${GRAPH.BASE_URL}/me/drive/items/${encodeURIComponent(item.id)}/content?format=pdf`
				: item["@microsoft.graph.downloadUrl"];
			if (!contentUri) continue;
			changes.push({
				message: {
					kind: "upsert",
					resourceType: "onedrive_item",
					resourceId: item.id,
					contentUri,
					accessToken: ctx.accessToken,
					mime: isOffice ? "application/pdf" : mime,
					...(item.name ? { title: item.name } : {}),
				},
				principals: owner,
			});
		}

		const next = body["@odata.nextLink"];
		const delta = body["@odata.deltaLink"];
		const cursor = next ?? delta ?? path;
		return { changes, cursor: relPath(cursor), done: !next };
	},
};
