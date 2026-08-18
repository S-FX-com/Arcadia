import { describe, expect, it } from "vitest";
import { parseJsonBlock } from "../src/ai/router";
import { DEFAULT_ROUTING, MODEL_CATALOG, TASK_KINDS, TASK_TIERS } from "../src/ai/types";

describe("default routing", () => {
  it("routes every task to Workers AI by default (§6)", () => {
    for (const task of TASK_KINDS) {
      expect(DEFAULT_ROUTING[task].provider).toBe("workers-ai");
      expect(DEFAULT_ROUTING[task].model.startsWith("@cf/")).toBe(true);
    }
  });

  it("covers every task with a tier and a binding", () => {
    for (const task of TASK_KINDS) {
      expect(TASK_TIERS[task]).toBeDefined();
      expect(DEFAULT_ROUTING[task].maxTokens).toBeGreaterThan(0);
    }
  });

  it("offers both providers in the admin catalog", () => {
    expect(MODEL_CATALOG.some((m) => m.provider === "workers-ai")).toBe(true);
    expect(MODEL_CATALOG.some((m) => m.provider === "anthropic")).toBe(true);
  });

  it("gives synthesis more room than classification", () => {
    expect(DEFAULT_ROUTING.synthesis.maxTokens).toBeGreaterThan(DEFAULT_ROUTING.classification.maxTokens);
  });
});

describe("parseJsonBlock", () => {
  it("parses a bare object", () => {
    expect(parseJsonBlock<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences", () => {
    expect(parseJsonBlock<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("survives a reasoning preamble, which Workers AI models emit often", () => {
    const raw = 'Let me think about this.\n\nHere is the result:\n{"title":"x","html":"<p>y</p>"}';
    expect(parseJsonBlock<{ title: string }>(raw).title).toBe("x");
  });

  it("handles arrays", () => {
    expect(parseJsonBlock<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws when there is no JSON at all", () => {
    expect(() => parseJsonBlock("I cannot do that")).toThrow(/no JSON/);
  });

  it("throws on unterminated JSON rather than returning junk", () => {
    expect(() => parseJsonBlock('{"a": 1')).toThrow(/unterminated/);
  });
});
