import { describe, expect, it, vi } from "vitest";
import { createLogger, newRequestId } from "../../src/lib/logger.js";

function captureConsole<T>(fn: () => T): { lines: string[]; result: T } {
	const lines: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((m: string) => { lines.push(m); });
	const warn = vi.spyOn(console, "warn").mockImplementation((m: string) => { lines.push(m); });
	const err = vi.spyOn(console, "error").mockImplementation((m: string) => { lines.push(m); });
	try {
		const result = fn();
		return { lines, result };
	} finally {
		log.mockRestore();
		warn.mockRestore();
		err.mockRestore();
	}
}

describe("logger", () => {
	it("emits a JSON line with level/event/context", () => {
		const log = createLogger({ requestId: "abc", route: "/x" });
		const { lines } = captureConsole(() => log.info("hello", { a: 1 }));
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.level).toBe("info");
		expect(parsed.event).toBe("hello");
		expect(parsed.requestId).toBe("abc");
		expect(parsed.route).toBe("/x");
		expect(parsed.a).toBe(1);
		expect(typeof parsed.ts).toBe("string");
	});

	it("serializes Error objects with name + stack", () => {
		const log = createLogger();
		const { lines } = captureConsole(() => log.error("boom", { foo: "bar" }, new Error("kaboom")));
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.error.message).toBe("kaboom");
		expect(parsed.error.name).toBe("Error");
		expect(typeof parsed.error.stack).toBe("string");
	});

	it("child() merges context", () => {
		const root = createLogger({ requestId: "r1" });
		const child = root.child({ userId: "u1" });
		const { lines } = captureConsole(() => child.info("event"));
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.requestId).toBe("r1");
		expect(parsed.userId).toBe("u1");
	});

	it("withTiming records latencyMs and rethrows on failure", async () => {
		const log = createLogger();
		const { lines } = await captureConsoleAsync(async () => {
			await expect(log.withTiming("op", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
		});
		const parsed = JSON.parse(lines.at(-1)!);
		expect(parsed.event).toBe("op");
		expect(parsed.ok).toBe(false);
		expect(typeof parsed.latencyMs).toBe("number");
	});

	it("newRequestId returns a 16-char hex string", () => {
		const id = newRequestId();
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});
});

async function captureConsoleAsync<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
	const lines: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((m: string) => { lines.push(m); });
	const warn = vi.spyOn(console, "warn").mockImplementation((m: string) => { lines.push(m); });
	const err = vi.spyOn(console, "error").mockImplementation((m: string) => { lines.push(m); });
	try {
		const result = await fn();
		return { lines, result };
	} finally {
		log.mockRestore();
		warn.mockRestore();
		err.mockRestore();
	}
}
