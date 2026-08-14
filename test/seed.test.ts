import { describe, expect, it } from "vitest";
import { isPleasantry } from "../src/lib/question";
import { partKey, partsOf, splitIntoMessages } from "../src/memory/seed-parts";

describe("isPleasantry", () => {
  it("rejects greetings and tests outright, so they never become gaps", () => {
    for (const input of ["hi", "Hi!", "  HELLO  ", "hola", "gracias", "test", "thanks", "ok", "hi arcadia"]) {
      expect(isPleasantry(input), input).toBe(true);
    }
  });

  it("rejects input too short to carry a question", () => {
    expect(isPleasantry("?")).toBe(true);
    expect(isPleasantry("a")).toBe(true);
    expect(isPleasantry("   ")).toBe(true);
  });

  it("matches whole inputs only — a pleasantry inside a real question is still a question", () => {
    // "hi" is in the list; "hi-touch" must not inherit that.
    expect(isPleasantry("What are hi-touch clients billed at?")).toBe(false);
    expect(isPleasantry("Hi, can I discount a 12-month retainer?")).toBe(false);
    expect(isPleasantry("test the staging site before launch?")).toBe(false);
  });

  it("keeps real doctrine questions", () => {
    for (const input of [
      "Can I discount a 12-month retainer?",
      "What is the minimum term",
      "who approves a site plan",
    ]) {
      expect(isPleasantry(input), input).toBe(false);
    }
  });
});

describe("splitIntoMessages", () => {
  it("splits on paragraph boundaries, never mid-sentence", () => {
    const doc = ["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n");
    const messages = splitIntoMessages(doc, 130);
    expect(messages.length).toBe(2);
    expect(messages[0]).toBe(`${"a".repeat(60)}\n\n${"b".repeat(60)}`);
    expect(messages[1]).toBe("c".repeat(60));
  });

  it("hard-splits a single paragraph over the budget rather than dropping it", () => {
    const messages = splitIntoMessages("x".repeat(250), 100);
    expect(messages.length).toBe(3);
    expect(messages.join("").length).toBe(250);
  });

  it("loses no content", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some text.`).join("\n\n");
    const rejoined = splitIntoMessages(doc, 200).join("\n\n");
    expect(rejoined).toBe(doc);
  });

  it("drops empty input", () => {
    expect(splitIntoMessages("")).toEqual([]);
    expect(splitIntoMessages("\n\n   \n\n")).toEqual([]);
  });
});

describe("partsOf", () => {
  it("stamps every part with the real total, not a placeholder", () => {
    const doc = Array.from({ length: 12 }, () => "y".repeat(9_000)).join("\n\n");
    const parts = partsOf("pricing.md", doc);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.total).toBe(parts.length);
      expect(part.document).toBe("pricing.md");
    }
    expect(parts.map((p) => p.index)).toEqual(parts.map((_, i) => i));
  });

  it("caps messages per part so one durable step stays bounded", () => {
    const doc = Array.from({ length: 20 }, () => "z".repeat(7_900)).join("\n\n");
    for (const part of partsOf("big.md", doc)) {
      expect(part.messages.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("partKey", () => {
  it("zero-pads the index so R2's lexicographic listing keeps parts in order", () => {
    const keys = [2, 10].map((i) => partKey("p", "run", "doc.md", i));
    expect([...keys].sort()).toEqual(keys);
  });

  it("sanitizes a document name into a safe key segment", () => {
    expect(partKey("p", "run", "../../etc/passwd", 0)).toBe("p/run/.._.._etc_passwd/0000.json");
  });
});
