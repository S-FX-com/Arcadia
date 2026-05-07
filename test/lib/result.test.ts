import { describe, expect, it } from "vitest";
import { ok, err, tryAsync, unwrap } from "../../src/lib/result.js";

describe("Result", () => {
	it("ok / err discriminate via .ok", () => {
		const o = ok(42);
		const e = err(new Error("nope"));
		expect(o.ok).toBe(true);
		if (o.ok) expect(o.value).toBe(42);
		expect(e.ok).toBe(false);
		if (!e.ok) expect(e.error.message).toBe("nope");
	});

	it("tryAsync wraps thrown errors", async () => {
		const success = await tryAsync(async () => 1);
		expect(success.ok).toBe(true);
		const failure = await tryAsync(async () => { throw new Error("boom"); });
		expect(failure.ok).toBe(false);
		if (!failure.ok) expect(failure.error.message).toBe("boom");
	});

	it("unwrap throws when not ok", () => {
		expect(() => unwrap(err(new Error("x")))).toThrow("x");
		expect(unwrap(ok("y"))).toBe("y");
	});
});
