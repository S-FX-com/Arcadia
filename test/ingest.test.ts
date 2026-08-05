import { describe, expect, it } from "vitest";
import { chunkMessages, dedupeCandidates, type Candidate } from "../src/memory/ingest";
import type { Message } from "../src/memory/driver";

const msg = (content: string): Message => ({ role: "user", content });

describe("chunkMessages (§5.3)", () => {
  it("keeps a short transcript in one chunk", () => {
    const chunks = chunkMessages([msg("a"), msg("b"), msg("c")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it("splits at roughly 10K chars", () => {
    const big = Array.from({ length: 5 }, () => msg("x".repeat(4000)));
    const chunks = chunkMessages(big);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("overlaps 2 messages between chunks so context is not cut mid-thought", () => {
    const big = Array.from({ length: 6 }, (_, i) => msg(`${i}:${"x".repeat(4000)}`));
    const chunks = chunkMessages(big);
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0] as Message[];
    const second = chunks[1] as Message[];
    const tail = first.slice(-2).map((m) => m.content);
    expect(second.slice(0, 2).map((m) => m.content)).toEqual(tail);
  });

  it("handles an empty transcript", () => {
    expect(chunkMessages([])).toEqual([]);
  });
});

describe("dedupeCandidates", () => {
  const c = (over: Partial<Candidate>): Candidate => ({
    content: "Retainers run 12 months minimum.",
    kind: "fact",
    topicKey: "retainer-term",
    pass: "A",
    ...over,
  });

  it("collapses duplicates on topic key plus content", () => {
    expect(dedupeCandidates([c({}), c({})])).toHaveLength(1);
  });

  it("prefers the pass B version — it carries the concrete value", () => {
    const deduped = dedupeCandidates([c({ pass: "A" }), c({ pass: "B" })]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.pass).toBe("B");
  });

  it("keeps genuinely different candidates", () => {
    const deduped = dedupeCandidates([
      c({}),
      c({ content: "Discounts are never offered; rate locks are.", topicKey: "discount-policy" }),
    ]);
    expect(deduped).toHaveLength(2);
  });

  it("does not let pass A displace an already-kept pass B", () => {
    const deduped = dedupeCandidates([c({ pass: "B" }), c({ pass: "A" })]);
    expect(deduped[0]?.pass).toBe("B");
  });
});
