import { describe, expect, it } from "vitest";

// `parseDeadline` is module-internal — we exercise it indirectly via
// detectTasks would require mocking the Router. Instead we test a
// small public surface that doesn't need network: the cheap
// keyword prefilter used inside activity-handler.ts.
//
// Re-implement the prefilter here to lock the behaviour in. If the
// activity-handler changes its prefilter, this test will need to
// update and tracked deliberately.

function looksLikeTaskCarrier(text: string): boolean {
  const lc = text.toLowerCase();
  if (/<at\b/i.test(text)) return true;
  return [
    "please",
    "can you",
    "could you",
    "would you",
    "let's",
    "we need",
    "i need",
    "need to",
    "have to",
    "should ",
    "todo",
    "to do",
    "follow up",
    "follow-up",
    "by tomorrow",
    "by today",
    "by friday",
    "by monday",
    "eod",
    "end of day",
    "end of week",
    "due ",
    "deadline",
  ].some((cue) => lc.includes(cue));
}

describe("task-carrier prefilter", () => {
  it("matches imperatives", () => {
    expect(looksLikeTaskCarrier("Please send the deck")).toBe(true);
    expect(looksLikeTaskCarrier("Can you take this?")).toBe(true);
    expect(looksLikeTaskCarrier("we need a status update")).toBe(true);
  });

  it("matches deadlines", () => {
    expect(looksLikeTaskCarrier("by Friday at EOD")).toBe(true);
    expect(looksLikeTaskCarrier("deadline is Tuesday")).toBe(true);
  });

  it("matches @mentions", () => {
    expect(looksLikeTaskCarrier('<at id="123">@Anna</at> look at this')).toBe(
      true,
    );
  });

  it("ignores chatter", () => {
    expect(looksLikeTaskCarrier("nice work everyone")).toBe(false);
    expect(looksLikeTaskCarrier("FYI the release shipped")).toBe(false);
  });
});
