// Shared types + fetchers for the Client source-binding UI.
// One source binding ties a client umbrella to a Teams channel, a Teams chat,
// a SharePoint site, or a Planner plan. The client_sources table is the
// canonical store; the agent's get_client_context tool reads from it.

export type ClientSourceType = "channel" | "chat" | "sharepoint-site" | "planner-plan";

export interface PickerSource {
	sourceType: ClientSourceType;
	sourceId: string;
	sourceName: string;
	teamId?: string | null;
	/** Free-form metadata persisted with the binding (e.g. team name for channels). */
	metadata?: Record<string, unknown>;
}

export interface UserTeam { id: string; displayName: string }
export interface UserChannel { id: string; displayName: string; description?: string | null }
export interface UserChat { id: string; topic?: string | null; chatType: string }
export interface SharePointSite { id: string; displayName: string; webUrl?: string }
export interface PlannerPlan { id: string; title: string; owner: string }

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

export async function loadTeams(): Promise<UserTeam[]> {
	const body = await getJson<{ teams: UserTeam[] }>("/api/webapp/context/teams");
	return body.teams ?? [];
}

export async function loadChannels(teamId: string): Promise<UserChannel[]> {
	const body = await getJson<{ channels: UserChannel[] }>(`/api/webapp/context/channels/${teamId}`);
	return body.channels ?? [];
}

export async function loadChats(): Promise<UserChat[]> {
	const body = await getJson<{ chats: UserChat[] }>("/api/webapp/context/chats");
	return body.chats ?? [];
}

export async function loadSharePoint(): Promise<SharePointSite[]> {
	const body = await getJson<{ sites: SharePointSite[] }>("/api/webapp/context/sharepoint");
	return body.sites ?? [];
}

export async function loadPlannerPlans(): Promise<PlannerPlan[]> {
	const body = await getJson<{ plans: PlannerPlan[]; tasks: unknown[] }>("/api/webapp/context/planner");
	return body.plans ?? [];
}

export function chatLabel(c: UserChat): string {
	if (c.topic && c.topic.trim().length > 0) return c.topic;
	if (c.chatType === "oneOnOne") return "1:1 chat";
	if (c.chatType === "group") return "Group chat";
	return c.chatType;
}

/** POST one source binding to /api/webapp/clients/:id/sources. */
export async function attachSource(clientId: string, src: PickerSource): Promise<void> {
	const res = await fetch(`/api/webapp/clients/${clientId}/sources`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "include",
		body: JSON.stringify({
			sourceType: src.sourceType,
			sourceId: src.sourceId,
			sourceName: src.sourceName,
			teamId: src.teamId ?? null,
			metadata: src.metadata ?? null,
		}),
	});
	if (!res.ok && res.status !== 409) {
		const text = await res.text().catch(() => "");
		throw new Error(`Attach failed (${res.status}): ${text}`);
	}
}

export async function detachSource(clientId: string, sourceRowId: string): Promise<void> {
	const res = await fetch(`/api/webapp/clients/${clientId}/sources/${sourceRowId}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`Detach failed (${res.status})`);
}
