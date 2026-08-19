import { describe, expect, it } from "vitest";
import {
  decideAskMode,
  parseCitationPayload,
  serializeCitationPayload,
  askSystemPrompt,
} from "../src/lib/ask";
import type { RecallResult } from "../src/memory/driver";

const emptyRecall = (over: Partial<RecallResult> = {}): RecallResult => ({
  memories: [],
  belowConfidenceFloor: true,
  ...over,
});

describe("decideAskMode", () => {
  it("is inferred when nothing clears the floor", () => {
    expect(decideAskMode(emptyRecall())).toBe("inferred");
  });

  it("is cited when recall returns entries above the floor", () => {
    expect(
      decideAskMode(
        emptyRecall({
          belowConfidenceFloor: false,
          memories: [
            {
              id: "m1",
              profile: "sfx-doctrine-canonical",
              content: "Rate locks are acceptable. Discounts are not.",
              kind: "instruction",
              topicKey: "discounts",
              provenance: { capturedFrom: "seed", capturedAt: "2026-08-18" },
              createdAt: "2026-08-18",
              score: 0.9,
            },
          ],
        })
      )
    ).toBe("cited");
  });
});

describe("citation payload", () => {
  it("round-trips Cited/Inferred with ids", () => {
    const raw = serializeCitationPayload("inferred", ["a", "b"]);
    expect(parseCitationPayload(raw)).toEqual({ mode: "inferred", ids: ["a", "b"] });
  });

  it("reads the old bare string[] rows", () => {
    expect(parseCitationPayload(JSON.stringify(["old-id"]))).toEqual({ ids: ["old-id"] });
  });
});

describe("askSystemPrompt", () => {
  it("does not tell the model to refuse with INSUFFICIENT_DOCTRINE", () => {
    expect(askSystemPrompt("inferred")).not.toContain("INSUFFICIENT_DOCTRINE");
    expect(askSystemPrompt("cited")).not.toContain("INSUFFICIENT_DOCTRINE");
    expect(askSystemPrompt("inferred")).toContain("Inferred —");
    expect(askSystemPrompt("cited")).toContain("Cited —");
  });
});
