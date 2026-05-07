import { describe, expect, it } from "vitest";
import {
	ACL_INTERNALS,
	aclEnforcementMode,
	buildAclWhereClause,
	isPrincipalKind,
} from "../../src/graph/acl.js";
import type { Env } from "../../src/types.js";

function envWith(mode?: Env["ACL_ENFORCEMENT"]): Env {
	const partial = { ACL_ENFORCEMENT: mode } as unknown as Env;
	return partial;
}

describe("aclEnforcementMode", () => {
	it("defaults to 'off' when unset or invalid", () => {
		expect(aclEnforcementMode(envWith(undefined))).toBe("off");
		expect(aclEnforcementMode({ ACL_ENFORCEMENT: "weird" } as unknown as Env)).toBe("off");
	});

	it("passes through valid modes", () => {
		expect(aclEnforcementMode(envWith("permissive"))).toBe("permissive");
		expect(aclEnforcementMode(envWith("strict"))).toBe("strict");
		expect(aclEnforcementMode(envWith("off"))).toBe("off");
	});
});

describe("buildAclWhereClause", () => {
	it("returns an empty clause when mode is off", () => {
		const c = buildAclWhereClause("off", ["u1", "g1"]);
		expect(c.sql).toBe("");
		expect(c.params).toEqual([]);
	});

	it("permissive: no principals → only resource-less rows", () => {
		const c = buildAclWhereClause("permissive", []);
		expect(c.sql).toBe("source_resource_id IS NULL");
		expect(c.params).toEqual([]);
	});

	it("strict: no principals → universally false (denies all)", () => {
		const c = buildAclWhereClause("strict", []);
		expect(c.sql).toBe("0");
		expect(c.params).toEqual([]);
	});

	it("permissive: produces an OR(NULL, EXISTS(IN ?,?)) clause and binds principals", () => {
		const c = buildAclWhereClause("permissive", ["user-1", "group-a", "group-b"]);
		expect(c.sql).toContain("source_resource_id IS NULL");
		expect(c.sql).toContain("EXISTS");
		expect(c.sql).toContain("?,?,?");
		expect(c.params).toEqual(["user-1", "group-a", "group-b"]);
	});

	it("strict: only the EXISTS clause; binds principals", () => {
		const c = buildAclWhereClause("strict", ["user-1", "group-a"]);
		expect(c.sql).toContain("EXISTS");
		expect(c.sql).not.toContain("IS NULL");
		expect(c.sql).toMatch(/IN \(\?,\?\)/);
		expect(c.params).toEqual(["user-1", "group-a"]);
	});

	it("table alias is applied to source_resource_* references", () => {
		const c = buildAclWhereClause("strict", ["u"], "m");
		expect(c.sql).toContain("m.source_resource_type");
		expect(c.sql).toContain("m.source_resource_id");
	});

	it("caps principal arity at MAX_PRINCIPALS_IN_QUERY", () => {
		const big = Array.from({ length: 200 }, (_, i) => `p${i}`);
		const c = buildAclWhereClause("strict", big);
		expect(c.params.length).toBe(ACL_INTERNALS.MAX_PRINCIPALS_IN_QUERY);
		// Includes the first principal (user's own id).
		expect(c.params[0]).toBe("p0");
	});
});

describe("isPrincipalKind", () => {
	it("only accepts 'user' and 'group'", () => {
		expect(isPrincipalKind("user")).toBe(true);
		expect(isPrincipalKind("group")).toBe(true);
		expect(isPrincipalKind("admin")).toBe(false);
		expect(isPrincipalKind("")).toBe(false);
	});
});

describe("ACL_INTERNALS.principalSetKey", () => {
	it("namespaces the KV key under acl:principals:", () => {
		expect(ACL_INTERNALS.principalSetKey("abc-123")).toBe("acl:principals:abc-123");
	});
});
