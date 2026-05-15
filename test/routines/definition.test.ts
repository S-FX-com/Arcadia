import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  parseDefinition,
  safeParseDefinition,
} from "../../src/routines/definition";

describe("routine definition", () => {
  it("validates a well-formed cron-triggered definition", () => {
    const def = parseDefinition({
      name: "morning_digest",
      trigger: { kind: "cron", cron: "0 8 * * 1-5" },
      steps: [
        {
          kind: "ai_complete",
          prompt: "Summarise yesterday",
          as: "summary",
        },
      ],
    });
    expect(def.name).toBe("morning_digest");
    expect(def.trigger.kind).toBe("cron");
    expect(def.steps).toHaveLength(1);
  });

  it("rejects missing trigger", () => {
    const result = safeParseDefinition({
      name: "x",
      steps: [{ kind: "ai_complete", prompt: "p", as: "a" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("trigger");
    }
  });

  it("rejects unknown step kinds", () => {
    const result = safeParseDefinition({
      name: "x",
      trigger: { kind: "manual" },
      steps: [{ kind: "magic", prompt: "?" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty step arrays", () => {
    const result = safeParseDefinition({
      name: "x",
      trigger: { kind: "manual" },
      steps: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("applyTemplate", () => {
  it("replaces single-key placeholders", () => {
    const out = applyTemplate("Hello {{ name }}", { name: "Arcadia" });
    expect(out).toBe("Hello Arcadia");
  });

  it("traverses dotted paths", () => {
    const out = applyTemplate("score {{result.score}}", {
      result: { score: 0.91 },
    });
    expect(out).toBe("score 0.91");
  });

  it("leaves unknown vars empty", () => {
    const out = applyTemplate("[{{missing}}]", {});
    expect(out).toBe("[]");
  });

  it("JSON-stringifies non-string values", () => {
    const out = applyTemplate("{{list}}", { list: ["a", "b"] });
    expect(out).toBe('["a","b"]');
  });
});
