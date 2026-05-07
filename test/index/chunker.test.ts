import { describe, expect, it } from "vitest";
import { chunkText, CHUNKER_INTERNALS } from "../../src/index/chunker.js";

describe("chunkText", () => {
	it("returns empty array for empty input", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   \n  ")).toEqual([]);
	});

	it("returns a single chunk when text fits the budget", () => {
		const text = "Hello world.";
		const chunks = chunkText(text);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.content).toBe(text);
		expect(chunks[0]!.ordinal).toBe(0);
	});

	it("splits long text into multiple chunks with sequential ordinals", () => {
		const big = "para. ".repeat(2000);
		const chunks = chunkText(big);
		expect(chunks.length).toBeGreaterThan(1);
		for (let i = 0; i < chunks.length; i++) {
			expect(chunks[i]!.ordinal).toBe(i);
		}
	});

	it("estimates tokens roughly as chars/4", () => {
		const text = "x".repeat(400);
		const chunks = chunkText(text);
		expect(chunks[0]!.tokenEstimate).toBeGreaterThan(0);
		expect(chunks[0]!.tokenEstimate).toBeLessThanOrEqual(Math.ceil(text.length / CHUNKER_INTERNALS.CHARS_PER_TOKEN));
	});

	it("includes overlap from the previous chunk on chunks 1+", () => {
		const big = "abcdefgh ".repeat(2000);
		const chunks = chunkText(big);
		if (chunks.length >= 2) {
			// Second chunk's prefix should share characters with the previous chunk's tail.
			const prevTail = chunks[0]!.content.slice(-50);
			expect(chunks[1]!.content.startsWith(prevTail) || chunks[1]!.content.includes(prevTail.slice(-20))).toBe(true);
		}
	});
});
