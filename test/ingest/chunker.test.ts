import { describe, expect, it } from "vitest";
import { chunk } from "../../src/ingest/chunker";

describe("chunk", () => {
  it("returns empty for empty input", () => {
    expect(chunk("")).toEqual([]);
    expect(chunk("   ")).toEqual([]);
  });

  it("preserves a single short paragraph", () => {
    const out = chunk("This is a short paragraph that fits in one chunk.");
    expect(out).toHaveLength(1);
    expect(out[0]!.ordinal).toBe(0);
    expect(out[0]!.text.startsWith("This is a short")).toBe(true);
  });

  it("splits a long doc into multiple ordered chunks", () => {
    const paragraph = "Lorem ipsum dolor sit amet. ".repeat(20);
    const text = Array.from({ length: 8 }, () => paragraph).join("\n\n");
    const out = chunk(text);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 0; i < out.length; i += 1) {
      expect(out[i]!.ordinal).toBe(i);
    }
  });

  it("never produces a chunk over CHUNK_MAX_CHARS-ish", () => {
    const text = "x ".repeat(5000);
    const out = chunk(text);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(2200);
    }
  });

  it("collapses whitespace", () => {
    const out = chunk("foo  bar\t\tbaz");
    expect(out[0]!.text).toContain("foo bar baz");
  });
});
