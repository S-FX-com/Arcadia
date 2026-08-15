import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPleasantry, looksLikeDoctrineQuestion } from "../src/lib/question";
import type { ModelRouter } from "../src/ai/router";
import { chunkMessages } from "../src/memory/ingest";
import { MESSAGE_CHARS, partKey, partsOf, splitIntoMessages } from "../src/memory/seed-parts";

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

describe("looksLikeDoctrineQuestion", () => {
  interface Seen {
    prompt: string;
    calls: number;
  }

  function fakeAi(reply: string, seen?: Seen) {
    return {
      text: async (_task: string, opts: { prompt?: string }) => {
        if (seen) {
          seen.calls++;
          seen.prompt = opts.prompt ?? "";
        }
        return reply;
      },
    } as unknown as ModelRouter;
  }

  it("short-circuits a pleasantry without spending a model call", async () => {
    const seen: Seen = { calls: 0, prompt: "" };
    const verdict = await looksLikeDoctrineQuestion(fakeAi("{}", seen), "hi");
    expect(verdict.isQuestion).toBe(false);
    expect(seen.calls).toBe(0);
  });

  it("shows the classifier the conversation, so a follow-up can be judged", async () => {
    // "talk me 'bout that" is meaningless alone and a real question after an
    // answer. Without the transcript the filter rejects it and the gap is lost.
    const seen: Seen = { calls: 0, prompt: "" };
    await looksLikeDoctrineQuestion(fakeAi('{"isQuestion":true}', seen), "talk me 'bout that", [
      { role: "user", content: "retainer discount policy" },
      { role: "arcadia", content: "Rate locks yes, discounts no." },
    ]);
    expect(seen.prompt).toContain("retainer discount policy");
    expect(seen.prompt).toContain("talk me 'bout that");
  });

  it("fails open — an unusable verdict counts as a question", async () => {
    // A missed gap is a permanent hole in doctrine; an extra one is a row
    // Shane declines.
    await expect(looksLikeDoctrineQuestion(fakeAi("not json"), "what is the rate")).resolves.toMatchObject({
      isQuestion: true,
    });
    const throwing = {
      text: async () => {
        throw new Error("model down");
      },
    } as unknown as ModelRouter;
    await expect(looksLikeDoctrineQuestion(throwing, "what is the rate")).resolves.toMatchObject({
      isQuestion: true,
    });
  });

  it("honors a negative verdict from the classifier", async () => {
    await expect(
      looksLikeDoctrineQuestion(fakeAi('{"isQuestion":false,"reason":"small talk"}'), "nice weather huh")
    ).resolves.toMatchObject({ isQuestion: false, reason: "small talk" });
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

describe("seed sizing against the real §5.3 chunker", () => {
  // The two modules carry independent constants. This is the invariant that
  // couples them: raising MESSAGE_CHARS without raising the chunker's budget
  // produces oversized chunks and quietly degrades extraction.
  const CHUNK_BUDGET = 10_000;

  it("keeps every chunk within the §5.3 budget for a real document", () => {
    const doc = readFileSync("CLAUDE.md", "utf8");
    const messages = splitIntoMessages(doc).map((content) => ({ role: "user" as const, content }));
    const sizes = chunkMessages(messages).map((c) => c.reduce((n, m) => n + m.content.length, 0));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CHUNK_BUDGET);
  });

  it("holds the invariant that makes that true", () => {
    // A chunk can hold OVERLAP_MESSAGES + 1 messages.
    expect(MESSAGE_CHARS * 3).toBeLessThanOrEqual(CHUNK_BUDGET);
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
