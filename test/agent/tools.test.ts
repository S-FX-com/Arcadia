import { describe, expect, it } from "vitest";
import { listTools, getTool } from "../../src/agent/tools/index.js";

describe("agent tool registry", () => {
	it("lists all four bootstrap tools", () => {
		const names = listTools().map((t) => t.name).sort();
		expect(names).toEqual([
			"get_calendar",
			"search_documents",
			"search_memory",
			"search_teams_messages",
		]);
	});

	it("rejects invalid input via the zod schema", () => {
		const tool = getTool("search_memory")!;
		expect(tool.schema.safeParse({ query: "" }).success).toBe(false);
		expect(tool.schema.safeParse({ query: "hello", limit: 100 }).success).toBe(false);
		expect(tool.schema.safeParse({ query: "hello", limit: 5 }).success).toBe(true);
	});

	it("getTool returns undefined for unknown tools", () => {
		expect(getTool("nope")).toBeUndefined();
	});
});
