import { describe, expect, it } from "vitest";
import { AUTHORITATIVE_VERIFIERS, CHECKLISTS, checklistByKey } from "../src/certification/checklists";

describe("launch checklists (§4 M2)", () => {
  it("ships all five checklists named in the spec", () => {
    expect(CHECKLISTS.map((c) => c.key).sort()).toEqual([
      "client_document",
      "it_ticket_close",
      "seo_deliverable",
      "social_post",
      "web_build",
    ]);
  });

  it("has no vague items — every item names a concrete, checkable claim", () => {
    for (const c of CHECKLISTS) {
      for (const item of c.items) {
        expect(item.label.length).toBeGreaterThan(12);
        expect(item.label.toLowerCase()).not.toContain("check your work");
        expect(item.label.toLowerCase()).not.toMatch(/^review\b/);
      }
    }
  });

  it("auto-verifies at least four items on the web build checklist", () => {
    const web = checklistByKey("web_build");
    const verifiable = web?.items.filter((i) => i.verifier !== "none") ?? [];
    expect(verifiable.length).toBeGreaterThanOrEqual(4);
  });

  it("covers the spec's verification table on the web build", () => {
    const web = checklistByKey("web_build");
    const byVerifier = new Set(web?.items.map((i) => i.verifier));
    for (const v of ["spellcheck", "links", "mobile", "meta", "forms", "copy_diff"]) {
      expect(byVerifier.has(v as never)).toBe(true);
    }
  });

  it("marks forms and copy diff as partial — Arcadia cannot fully confirm them", () => {
    const web = checklistByKey("web_build");
    expect(web?.items.find((i) => i.verifier === "forms")?.partial).toBe(true);
    expect(web?.items.find((i) => i.verifier === "copy_diff")?.partial).toBe(true);
  });

  it("treats no partial verifier as authoritative", () => {
    for (const c of CHECKLISTS) {
      for (const item of c.items) {
        if (item.partial) expect(AUTHORITATIVE_VERIFIERS).not.toContain(item.verifier);
      }
    }
  });

  it("gives every checklist at least one gated stage", () => {
    for (const c of CHECKLISTS) expect(c.stages.length).toBeGreaterThan(0);
  });

  it("requires a URL exactly where a crawl-based verifier is the point", () => {
    expect(checklistByKey("web_build")?.needsUrl).toBe(true);
    expect(checklistByKey("it_ticket_close")?.needsUrl).toBe(false);
  });
});
