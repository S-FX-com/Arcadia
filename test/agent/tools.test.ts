import { describe, expect, it } from "vitest";
import { listTools, getTool } from "../../src/agent/tools/index.js";

describe("agent tool registry", () => {
	it("lists all bootstrap + action tools", () => {
		const names = listTools().map((t) => t.name).sort();
		expect(names).toEqual([
			"create_event",
			"create_planner_task",
			"get_calendar",
			"get_client_context",
			"list_clients",
			"post_channel",
			"search_documents",
			"search_memory",
			"search_teams_messages",
			"send_mail",
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
