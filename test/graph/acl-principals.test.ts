import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTeamsChannelPrincipals, getTeamsChatPrincipals } from "../../src/graph/acl.js";

interface MockResponse {
	pattern: RegExp;
	body: unknown;
	status?: number;
}

function installMockFetch(responses: MockResponse[]): { calls: string[] } {
	const calls: string[] = [];
	const fetchSpy = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		const match = responses.find((r) => r.pattern.test(url));
		if (!match) {
			return new Response(JSON.stringify({ error: "no mock" }), { status: 404 });
		}
		return new Response(JSON.stringify(match.body), {
			status: match.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchSpy);
	return { calls };
}

describe("getTeamsChannelPrincipals", () => {
	beforeEach(() => { vi.unstubAllGlobals(); });
	afterEach(() => { vi.unstubAllGlobals(); });

	it("returns user principals when channel has direct members (private/shared channel)", async () => {
		installMockFetch([
			{
				pattern: /\/teams\/T1\/channels\/C1\/members/,
				body: {
					value: [
						{ "@odata.type": "#microsoft.graph.aadUserConversationMember", userId: "user-1", displayName: "Alice" },
						{ "@odata.type": "#microsoft.graph.aadUserConversationMember", userId: "user-2", displayName: "Bob" },
					],
				},
			},
		]);

		const principals = await getTeamsChannelPrincipals("T1", "C1", "fake-token");
		expect(principals).toEqual([
			{ aadId: "user-1", kind: "user" },
			{ aadId: "user-2", kind: "user" },
		]);
	});

	it("falls back to team members when channel reports zero members (standard channel)", async () => {
		const { calls } = installMockFetch([
			{ pattern: /\/teams\/T1\/channels\/C1\/members/, body: { value: [] } },
			{
				pattern: /\/teams\/T1\/members/,
				body: {
					value: [
						{ userId: "team-user-1" },
						{ userId: "team-user-2" },
						{ userId: "team-user-3" },
					],
				},
			},
		]);

		const principals = await getTeamsChannelPrincipals("T1", "C1", "fake-token");
		expect(principals.map((p) => p.aadId)).toEqual(["team-user-1", "team-user-2", "team-user-3"]);
		expect(calls.some((u) => u.includes("/teams/T1/channels/C1/members"))).toBe(true);
		expect(calls.some((u) => u.includes("/teams/T1/members"))).toBe(true);
	});

	it("filters out member entries that lack a userId field", async () => {
		installMockFetch([
			{
				pattern: /\/teams\/T1\/channels\/C1\/members/,
				body: { value: [{ userId: "user-1" }, { displayName: "no-userId" }, { userId: "user-2" }] },
			},
		]);

		const principals = await getTeamsChannelPrincipals("T1", "C1", "fake-token");
		expect(principals.map((p) => p.aadId)).toEqual(["user-1", "user-2"]);
	});

	it("returns an empty array (not throws) when both channel and team queries fail", async () => {
		installMockFetch([
			{ pattern: /\/teams\/T1\/channels\/C1\/members/, body: { error: "forbidden" }, status: 403 },
			{ pattern: /\/teams\/T1\/members/, body: { error: "forbidden" }, status: 403 },
		]);
		const principals = await getTeamsChannelPrincipals("T1", "C1", "fake-token");
		expect(principals).toEqual([]);
	});

	it("URL-encodes the team and channel ids", async () => {
		const { calls } = installMockFetch([
			{ pattern: /channels\/C%2F1/, body: { value: [{ userId: "u1" }] } },
		]);
		await getTeamsChannelPrincipals("T 1", "C/1", "fake-token");
		expect(calls.some((u) => u.includes("/teams/T%201/channels/C%2F1/members"))).toBe(true);
	});
});

describe("getTeamsChatPrincipals", () => {
	beforeEach(() => { vi.unstubAllGlobals(); });
	afterEach(() => { vi.unstubAllGlobals(); });

	it("maps chat member userIds into user principals", async () => {
		installMockFetch([
			{
				pattern: /\/chats\/CHAT1\/members/,
				body: { value: [{ userId: "u1" }, { userId: "u2" }] },
			},
		]);
		const principals = await getTeamsChatPrincipals("CHAT1", "fake-token");
		expect(principals).toEqual([
			{ aadId: "u1", kind: "user" },
			{ aadId: "u2", kind: "user" },
		]);
	});

	it("returns [] when the chat call fails", async () => {
		installMockFetch([{ pattern: /\/chats/, body: { error: "x" }, status: 500 }]);
		expect(await getTeamsChatPrincipals("CHAT1", "fake-token")).toEqual([]);
	});
});
