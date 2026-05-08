// ─────────────────────────────────────────────────────────────────────────────
// Phase 17 — Operating Charter prompt-shape tests.
//
// The whole point of the charter is the label asymmetry: the user-authored
// block is labelled GROUND TRUTH, the AI-inferred profile block is labelled
// INFERRED. When both are present the model resolves conflicts by trusting
// the charter. These tests pin that contract.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { buildDMSystemPrompt } from "../src/ai/prompts.js";
import { buildWebappSystemPrompt } from "../src/webapp/prompts.js";
import { buildCharterSection, buildProfileSection } from "../src/ai/prompt-registry.js";
import type { ProfileInsights, UserCharter, UserProfile } from "../src/types.js";

const insights: ProfileInsights = {
  communicationStyle: { summary: "direct, low ceremony", traits: ["direct"] },
  focusAreas: { primary: ["ops"], secondary: [], recent: ["billing"] },
  workingPatterns: { activeHours: "9–6 ET", responseStyle: "brief" },
  updatedAt: "2026-05-08T00:00:00.000Z",
};

const charter: UserCharter = {
  content: "Lead with cost, not vision. Don't nudge me about email — I batch it on Fridays.",
  version: 3,
  updatedAt: "2026-05-08T00:00:00.000Z",
  lastReviewedAt: "2026-05-08T00:00:00.000Z",
};

describe("buildCharterSection", () => {
  it("returns empty string when charter is null", () => {
    expect(buildCharterSection(null)).toBe("");
  });

  it("returns empty string when charter content is whitespace", () => {
    expect(buildCharterSection({ ...charter, content: "   \n  " })).toBe("");
  });

  it("emits a GROUND TRUTH-labelled fenced block when content is present", () => {
    const out = buildCharterSection(charter);
    expect(out).toContain("USER-AUTHORED OPERATING CONTEXT");
    expect(out).toContain("TREAT AS GROUND TRUTH");
    expect(out).toContain(charter.content.trim());
    expect(out).toContain("END USER-AUTHORED CONTEXT");
  });
});

describe("buildProfileSection — relabelled to INFERRED", () => {
  it("uses the INFERRED label so the model knows it's a guess", () => {
    const out = buildProfileSection("Shane", insights);
    expect(out).toContain("INFERRED");
    expect(out).toContain("defer to user-authored context above");
    expect(out).not.toMatch(/^What you know about/m);
  });
});

describe("buildDMSystemPrompt — charter integration", () => {
  it("produces the same prompt shape as before when charter is null", () => {
    const before = buildDMSystemPrompt("Shane", false, insights);
    const after = buildDMSystemPrompt("Shane", false, insights, null);
    expect(after).toBe(before);
  });

  it("includes the charter block ABOVE the inferred profile block", () => {
    const out = buildDMSystemPrompt("Shane", false, insights, charter);
    const charterIdx = out.indexOf("USER-AUTHORED OPERATING CONTEXT");
    const inferredIdx = out.indexOf("INFERRED");
    expect(charterIdx).toBeGreaterThan(-1);
    expect(inferredIdx).toBeGreaterThan(-1);
    expect(charterIdx).toBeLessThan(inferredIdx);
  });

  it("works when only the charter is present (no inferred profile yet)", () => {
    const out = buildDMSystemPrompt("Shane", false, null, charter);
    expect(out).toContain("USER-AUTHORED OPERATING CONTEXT");
    // With no insights, the section says "early conversation" — but the
    // INFERRED label is only emitted when insights exist.
    expect(out).toContain("early conversation");
  });
});

describe("buildWebappSystemPrompt — charter integration", () => {
  const profile: UserProfile = {
    userId: "u1",
    displayName: "Shane",
    messageCount: 50,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-05-01T00:00:00.000Z",
    insights,
    insightVersion: 2,
  };

  it("is byte-identical to pre-Phase-17 when charter is null", () => {
    const before = buildWebappSystemPrompt("Shane", false, profile, [], "");
    const after = buildWebappSystemPrompt("Shane", false, profile, [], "", null);
    expect(after).toBe(before);
  });

  it("places GROUND TRUTH above INFERRED when both are present", () => {
    const out = buildWebappSystemPrompt("Shane", false, profile, [], "", charter);
    const charterIdx = out.indexOf("USER-AUTHORED OPERATING CONTEXT");
    const inferredIdx = out.indexOf("INFERRED");
    expect(charterIdx).toBeGreaterThan(-1);
    expect(inferredIdx).toBeGreaterThan(-1);
    expect(charterIdx).toBeLessThan(inferredIdx);
  });
});
