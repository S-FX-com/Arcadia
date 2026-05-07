import { describe, expect, it, vi } from "vitest";
import { filterByAcl } from "../../src/graph/acl.js";
import type { Env } from "../../src/types.js";

interface FakeRow { resource_type: string; resource_id: string }

/**
 * Build a minimal Env-like object whose ARCADIA_DB.prepare(sql).bind(...).all()
 * returns the rows we tell it to. Captures the most recent SQL + bind args
 * for assertions.
 */
function envWithAclRows(rows: FakeRow[]): { env: Env; lastSql: () => string; lastParams: () => unknown[] } {
	let lastSql = "";
	let lastParams: unknown[] = [];
	const stmt = {
		bind(...args: unknown[]) {
			lastParams = args;
			return {
				all: async <T = FakeRow>() => ({ results: rows as unknown as T[], success: true, meta: {} }),
			};
		},
	};
	const ARCADIA_DB = {
		prepare(sql: string) {
			lastSql = sql;
			return stmt;
		},
	} as unknown as D1Database;
	const env = { ARCADIA_DB } as unknown as Env;
	return { env, lastSql: () => lastSql, lastParams: () => lastParams };
}

type Candidate = { id: string; sourceResourceType?: string | null; sourceResourceId?: string | null };

describe("filterByAcl", () => {
	it("off mode is a pure pass-through and never queries D1", async () => {
		const dbSpy = vi.fn();
		const env = { ARCADIA_DB: { prepare: dbSpy } } as unknown as Env;
		const cands: Candidate[] = [
			{ id: "a", sourceResourceType: "teams_channel", sourceResourceId: "x:1" },
			{ id: "b" },
		];
		const out = await filterByAcl(cands, "off", ["user-1"], env);
		expect(out).toEqual(cands);
		expect(dbSpy).not.toHaveBeenCalled();
	});

	it("permissive: candidates without resource pointers pass; tagged ones require an ACL match", async () => {
		const { env } = envWithAclRows([
			{ resource_type: "teams_channel", resource_id: "T1:C1" },
		]);
		const cands: Candidate[] = [
			{ id: "untagged" },                                                             // pass (permissive)
			{ id: "allowed",  sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" }, // pass (ACL match)
			{ id: "denied",   sourceResourceType: "teams_channel", sourceResourceId: "T1:C2" }, // drop
		];
		const out = await filterByAcl(cands, "permissive", ["user-1", "group-a"], env);
		expect(out.map((c) => c.id).sort()).toEqual(["allowed", "untagged"]);
	});

	it("strict: only candidates with an ACL match pass; untagged are dropped", async () => {
		const { env } = envWithAclRows([
			{ resource_type: "teams_chat", resource_id: "CHAT1" },
		]);
		const cands: Candidate[] = [
			{ id: "untagged" },                                                          // drop
			{ id: "allowed",  sourceResourceType: "teams_chat", sourceResourceId: "CHAT1" }, // pass
			{ id: "denied",   sourceResourceType: "teams_chat", sourceResourceId: "CHAT2" }, // drop
		];
		const out = await filterByAcl(cands, "strict", ["user-1"], env);
		expect(out.map((c) => c.id)).toEqual(["allowed"]);
	});

	it("empty principal set: strict denies all, permissive keeps only untagged", async () => {
		const env = { ARCADIA_DB: { prepare: vi.fn() } } as unknown as Env;
		const cands: Candidate[] = [
			{ id: "untagged" },
			{ id: "tagged",  sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" },
		];
		const strict = await filterByAcl(cands, "strict", [], env);
		expect(strict).toEqual([]);
		const permissive = await filterByAcl(cands, "permissive", [], env);
		expect(permissive.map((c) => c.id)).toEqual(["untagged"]);
	});

	it("when no candidate has a source pointer: permissive is pass-through, strict drops everything", async () => {
		const env = { ARCADIA_DB: { prepare: vi.fn() } } as unknown as Env;
		const cands: Candidate[] = [{ id: "a" }, { id: "b" }];
		expect(await filterByAcl(cands, "permissive", ["user-1"], env)).toEqual(cands);
		expect(await filterByAcl(cands, "strict", ["user-1"], env)).toEqual([]);
	});

	it("binds the (resource_type, resource_id) tuples and the principal list to the query", async () => {
		const { env, lastSql, lastParams } = envWithAclRows([]);
		const cands: Candidate[] = [
			{ id: "a", sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" },
			{ id: "b", sourceResourceType: "teams_chat",    sourceResourceId: "CHAT1" },
		];
		await filterByAcl(cands, "strict", ["user-1", "group-a"], env);
		expect(lastSql()).toContain("(resource_type, resource_id) IN");
		expect(lastSql()).toContain("principal_aad_id IN");
		// 2 resource pairs × 2 + 2 principals = 6 bind params.
		expect(lastParams()).toEqual(["teams_channel", "T1:C1", "teams_chat", "CHAT1", "user-1", "group-a"]);
	});

	it("dedupes candidates referencing the same resource so each pair binds only once", async () => {
		const { env, lastParams } = envWithAclRows([]);
		const cands: Candidate[] = [
			{ id: "a", sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" },
			{ id: "b", sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" },
			{ id: "c", sourceResourceType: "teams_channel", sourceResourceId: "T1:C1" },
		];
		await filterByAcl(cands, "strict", ["user-1"], env);
		// Single (type, id) pair regardless of duplicate candidates.
		expect(lastParams()).toEqual(["teams_channel", "T1:C1", "user-1"]);
	});

	it("returns an empty array when given an empty candidate list (no DB hit)", async () => {
		const dbSpy = vi.fn();
		const env = { ARCADIA_DB: { prepare: dbSpy } } as unknown as Env;
		expect(await filterByAcl([], "strict", ["user-1"], env)).toEqual([]);
		expect(dbSpy).not.toHaveBeenCalled();
	});
});
