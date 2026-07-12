// Small typed wrapper around the /api/webapp/* surface.
//
// Every call uses credentials: 'include' so the session cookie sealed
// by /api/webapp/auth/exchange flows back on subsequent requests.

import { getApiToken } from "./mgt";
import type {
	ActionLevel,
	ActionLogEntry,
	ActionPolicy,
	ActionScopeType,
	DashboardData,
	MemoryHit,
	OrgPulse,
	Proposal,
	Routine,
	SearchResponse,
	Session,
	SourcesData,
	Task,
} from "./types";

async function http<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const res = await fetch(path, {
		credentials: "include",
		headers: {
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
		...init,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

export const api = {
	async health(): Promise<{ ok: boolean; ts: string }> {
		return http("/api/webapp/health");
	},
	async me(): Promise<{ session: Session }> {
		return http("/api/webapp/me");
	},
	async exchange(token: string): Promise<{ session: Session }> {
		return http("/api/webapp/auth/exchange", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
	},
	async logout(): Promise<void> {
		await http("/api/webapp/auth/logout", { method: "POST" });
	},

	async chat(message: string): Promise<{ reply: string }> {
		return http("/api/webapp/chat", {
			method: "POST",
			body: JSON.stringify({ message }),
		});
	},

	async dashboard(): Promise<DashboardData> {
		return http("/api/webapp/dashboard");
	},

	/**
	 * Admin-only tenant-wide "what is happening right now" synthesis
	 * (src/webapp/org-pulse-api.ts). Returns 403 for non-admins.
	 */
	async orgPulse(): Promise<OrgPulse> {
		return http("/api/webapp/org-pulse");
	},

	async routines(): Promise<{ routines: Routine[] }> {
		return http("/api/webapp/routines");
	},
	async createRoutine(definition: unknown, enabled = true): Promise<{ routine: Routine }> {
		return http("/api/webapp/routines", {
			method: "POST",
			body: JSON.stringify({ definition, enabled }),
		});
	},
	async runRoutine(id: string): Promise<unknown> {
		return http(`/api/webapp/routines/${encodeURIComponent(id)}/run`, {
			method: "POST",
		});
	},
	async setRoutineEnabled(id: string, enabled: boolean): Promise<{ routine: Routine }> {
		return http(`/api/webapp/routines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ enabled }),
		});
	},
	async deleteRoutine(id: string): Promise<void> {
		await http(`/api/webapp/routines/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	async recall(query: string, opts: {
		scopeType?: string;
		scopeId?: string;
		kind?: string;
		limit?: number;
	} = {}): Promise<{ hits: MemoryHit[] }> {
		const params = new URLSearchParams({ query });
		if (opts.scopeType) params.set("scopeType", opts.scopeType);
		if (opts.scopeId) params.set("scopeId", opts.scopeId);
		if (opts.kind) params.set("kind", opts.kind);
		if (opts.limit) params.set("limit", String(opts.limit));
		return http(`/api/webapp/memory?${params}`);
	},
	async forgetMemory(id: string): Promise<void> {
		await http(`/api/webapp/memory/${encodeURIComponent(id)}/forget`, {
			method: "POST",
		});
	},

	/**
	 * Operator review queue (src/webapp/proposals-api.ts). Admin-only —
	 * returns 403 for non-admins. Optional status filter.
	 */
	async proposals(status?: string): Promise<{ proposals: Proposal[] }> {
		const q = status ? `?status=${encodeURIComponent(status)}` : "";
		return http(`/api/webapp/proposals${q}`);
	},
	async approveProposal(id: string): Promise<{ ok: boolean; status: string }> {
		return http(`/api/webapp/proposals/${encodeURIComponent(id)}/approve`, {
			method: "POST",
		});
	},
	async rejectProposal(id: string): Promise<{ ok: boolean; status: string }> {
		return http(`/api/webapp/proposals/${encodeURIComponent(id)}/reject`, {
			method: "POST",
		});
	},

	/**
	 * Action framework admin control plane (src/webapp/actions-api.ts).
	 * Admin-only — every call returns 403 for non-admins.
	 */
	async actionPolicy(): Promise<{ policies: ActionPolicy[] }> {
		return http("/api/webapp/actions/policy");
	},
	async setActionPolicy(input: {
		verb: string;
		scopeType: ActionScopeType;
		scopeId: string;
		level: ActionLevel;
	}): Promise<{ policy: ActionPolicy }> {
		return http("/api/webapp/actions/policy", {
			method: "PUT",
			body: JSON.stringify(input),
		});
	},
	async deleteActionPolicy(input: {
		verb: string;
		scopeType: ActionScopeType;
		scopeId: string;
	}): Promise<{ ok: boolean; removed: boolean }> {
		return http("/api/webapp/actions/policy", {
			method: "DELETE",
			body: JSON.stringify(input),
		});
	},
	async killSwitch(): Promise<{ on: boolean }> {
		return http("/api/webapp/actions/kill");
	},
	async setKillSwitch(on: boolean): Promise<{ on: boolean }> {
		return http("/api/webapp/actions/kill", {
			method: "PUT",
			body: JSON.stringify({ on }),
		});
	},
	async actionLog(opts: {
		status?: string;
		verb?: string;
		limit?: number;
	} = {}): Promise<{ log: ActionLogEntry[] }> {
		const params = new URLSearchParams();
		if (opts.status) params.set("status", opts.status);
		if (opts.verb) params.set("verb", opts.verb);
		if (opts.limit) params.set("limit", String(opts.limit));
		const q = params.toString();
		return http(`/api/webapp/actions/log${q ? `?${q}` : ""}`);
	},

	async sources(limit = 200): Promise<SourcesData> {
		return http(`/api/webapp/sources?limit=${limit}`);
	},
	async forgetSource(id: string): Promise<void> {
		await http(`/api/webapp/sources/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	/**
	 * Live, Graph-trimmed search as the signed-in user (delegated OBO —
	 * see src/graph/delegated.ts + src/webapp/search-api.ts). Acquires a
	 * webapp-API-scoped token via the same MSAL2 provider the MGT
	 * components use, then sends it as `x-graph-token` alongside the
	 * session cookie; the worker verifies both agree on identity before
	 * exchanging the token for Graph access on the user's behalf.
	 */
	async search(query: string, entityTypes?: string[]): Promise<SearchResponse> {
		const token = await getApiToken();
		if (!token) {
			throw new Error("/api/webapp/search → no signed-in Graph account");
		}
		return http("/api/webapp/search", {
			method: "POST",
			headers: { "x-graph-token": token },
			body: JSON.stringify({ query, ...(entityTypes ? { entityTypes } : {}) }),
		});
	},
};

export type { Task };
