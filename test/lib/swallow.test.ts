import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { swallow, swallowWith } from "../../src/lib/swallow.js";

function silenceConsole(): () => void {
	const a = vi.spyOn(console, "log").mockImplementation(() => {});
	const b = vi.spyOn(console, "warn").mockImplementation(() => {});
	const c = vi.spyOn(console, "error").mockImplementation(() => {});
	return () => { a.mockRestore(); b.mockRestore(); c.mockRestore(); };
}

describe("swallow", () => {
	it("returns the fallback value when the promise rejects and logs at warn", async () => {
		const restore = silenceConsole();
		try {
			const log = createLogger();
			const warn = vi.spyOn(log, "warn");
			const result = await Promise.reject(new Error("boom")).catch(swallow(log, "op_failed", "fallback"));
			expect(result).toBe("fallback");
			expect(warn).toHaveBeenCalledOnce();
		} finally { restore(); }
	});

	it("does not log when the promise resolves", async () => {
		const restore = silenceConsole();
		try {
			const log = createLogger();
			const warn = vi.spyOn(log, "warn");
			const result = await Promise.resolve(42).catch(swallow(log, "op_failed", -1));
			expect(result).toBe(42);
			expect(warn).not.toHaveBeenCalled();
		} finally { restore(); }
	});

	it("swallowWith re-evaluates the fallback factory on each call", async () => {
		const restore = silenceConsole();
		try {
			const log = createLogger();
			const factory = vi.fn(() => ({ id: Math.random() }));
			const a = await Promise.reject(new Error("x")).catch(swallowWith(log, "op", factory));
			const b = await Promise.reject(new Error("y")).catch(swallowWith(log, "op", factory));
			expect(factory).toHaveBeenCalledTimes(2);
			expect(a).not.toBe(b);
		} finally { restore(); }
	});
});
