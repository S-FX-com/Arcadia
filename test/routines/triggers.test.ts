import { describe, expect, it } from "vitest";
import { cronMatches } from "../../src/routines/triggers.js";

describe("cronMatches", () => {
	const m = (expr: string, iso: string) => cronMatches(expr, new Date(iso));

	it("any-field wildcard matches every minute", () => {
		expect(m("* * * * *", "2026-05-07T12:34:00Z")).toBe(true);
	});

	it("literal minute + hour", () => {
		expect(m("30 9 * * *",  "2026-05-07T09:30:00Z")).toBe(true);
		expect(m("30 9 * * *",  "2026-05-07T09:31:00Z")).toBe(false);
		expect(m("30 9 * * *",  "2026-05-07T08:30:00Z")).toBe(false);
	});

	it("range field (Mon–Fri)", () => {
		expect(m("0 13 * * 1-5", "2026-05-07T13:00:00Z")).toBe(true);  // Thu
		expect(m("0 13 * * 1-5", "2026-05-09T13:00:00Z")).toBe(false); // Sat
	});

	it("step field every-N", () => {
		expect(m("*/15 * * * *", "2026-05-07T12:00:00Z")).toBe(true);
		expect(m("*/15 * * * *", "2026-05-07T12:15:00Z")).toBe(true);
		expect(m("*/15 * * * *", "2026-05-07T12:14:00Z")).toBe(false);
	});

	it("set field (a,b,c)", () => {
		expect(m("0 9,12,17 * * *", "2026-05-07T12:00:00Z")).toBe(true);
		expect(m("0 9,12,17 * * *", "2026-05-07T13:00:00Z")).toBe(false);
	});

	it("rejects malformed expressions", () => {
		expect(m("invalid", "2026-05-07T00:00:00Z")).toBe(false);
		expect(m("0 9 * *",  "2026-05-07T09:00:00Z")).toBe(false);
	});
});
