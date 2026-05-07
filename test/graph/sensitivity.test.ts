import { describe, expect, it } from "vitest";
import { classifyLabel, redactContent, SENSITIVITY_INTERNALS } from "../../src/graph/sensitivity.js";
import type { Env } from "../../src/types.js";

const baseEnv = {} as Env;
const overrideEnv = { SENSITIVITY_LABEL_MAP: JSON.stringify({ "Beta": "secret", "lawful": "public" }) } as unknown as Env;

describe("classifyLabel", () => {
	it("returns 'internal' for null/empty/unknown labels", () => {
		expect(classifyLabel(null, baseEnv)).toBe("internal");
		expect(classifyLabel("", baseEnv)).toBe("internal");
		expect(classifyLabel("FizzBuzz", baseEnv)).toBe("internal");
	});

	it("maps the standard MIP labels", () => {
		expect(classifyLabel("Public", baseEnv)).toBe("public");
		expect(classifyLabel("General", baseEnv)).toBe("internal");
		expect(classifyLabel("Confidential", baseEnv)).toBe("sensitive");
		expect(classifyLabel("Highly Confidential", baseEnv)).toBe("secret");
		expect(classifyLabel("Top Secret", baseEnv)).toBe("secret");
	});

	it("env overrides win over defaults and are case-insensitive", () => {
		expect(classifyLabel("Beta", overrideEnv)).toBe("secret");
		expect(classifyLabel("lawful", overrideEnv)).toBe("public");
		// Default-mapped labels still classify correctly when not overridden.
		expect(classifyLabel("Public", overrideEnv)).toBe("public");
	});
});

describe("redactContent", () => {
	it("public + internal pass-through unchanged", () => {
		expect(redactContent("hello", "public")).toEqual({ content: "hello", redacted: false });
		expect(redactContent("hello", "internal")).toEqual({ content: "hello", redacted: false });
	});

	it("sensitive returns the first N chars + a redaction notice when long", () => {
		const long = "x".repeat(SENSITIVITY_INTERNALS.SENSITIVE_EXCERPT_CHARS + 200);
		const out = redactContent(long, "sensitive");
		expect(out.redacted).toBe(true);
		expect(out.content.startsWith("x".repeat(SENSITIVITY_INTERNALS.SENSITIVE_EXCERPT_CHARS))).toBe(true);
		expect(out.content).toContain("REDACTED");
	});

	it("sensitive passes through when content fits within the excerpt budget", () => {
		const out = redactContent("short", "sensitive");
		expect(out).toEqual({ content: "short", redacted: false });
	});

	it("secret produces the placeholder body", () => {
		const out = redactContent("anything", "secret");
		expect(out.redacted).toBe(true);
		expect(out.content).toContain("REDACTED");
		expect(out.content).not.toContain("anything");
	});
});
