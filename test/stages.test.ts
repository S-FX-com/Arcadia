import { describe, expect, it } from "vitest";
import { canAdvance, hoursSince, nextStage, STAGES, STAGE_ORDER, stageByKey } from "../src/dispatch/stages";

describe("review chain (§4 Phase 3)", () => {
  it("encodes Developer → QA → Tech Review → Pre-Launch in order", () => {
    expect(STAGE_ORDER).toEqual(["development", "qa", "tech_review", "pre_launch"]);
  });

  it("advances only to the immediate next stage", () => {
    expect(canAdvance("development", "qa").ok).toBe(true);
    expect(canAdvance("qa", "tech_review").ok).toBe(true);
    expect(canAdvance("tech_review", "pre_launch").ok).toBe(true);
  });

  it("refuses to skip a stage and names what was skipped", () => {
    const skip = canAdvance("qa", "pre_launch");
    expect(skip.ok).toBe(false);
    expect(skip.reason).toContain("tech_review");
    expect(canAdvance("development", "pre_launch").ok).toBe(false);
  });

  it("refuses to move work backwards", () => {
    expect(canAdvance("tech_review", "qa").ok).toBe(false);
    expect(canAdvance("qa", "qa").ok).toBe(false);
  });

  it("rejects unknown stages rather than guessing", () => {
    expect(canAdvance("qa", "launched").ok).toBe(false);
    expect(canAdvance("nonsense", "qa").ok).toBe(false);
  });

  it("gives every review stage an SLA and a pass-through floor", () => {
    for (const stage of STAGES.filter((s) => s.key !== "development")) {
      expect(stage.slaHours).toBeGreaterThan(0);
      expect(stage.minReviewSeconds).toBeGreaterThan(0);
      expect(stage.checklist).toBeTruthy();
    }
  });

  it("walks the chain with nextStage and stops at the end", () => {
    expect(nextStage("development")?.key).toBe("qa");
    expect(nextStage("pre_launch")).toBeUndefined();
    expect(stageByKey("qa")?.label).toContain("QA");
  });
});

describe("hoursSince", () => {
  it("measures elapsed hours for SLA checks", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(hoursSince("2026-08-05T00:00:00Z", now)).toBe(12);
    expect(hoursSince("2026-08-04T12:00:00Z", now)).toBe(24);
  });
});
