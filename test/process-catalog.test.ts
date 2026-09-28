import { describe, expect, it } from "vitest";
import { filterProcessLinks } from "../src/lib/process-catalog";

describe("process catalog search", () => {
  const links = [
    { name: "Onboarding", url: "https://loop.cloud.microsoft/onboarding", owner: "Ada", description: "New hire path" },
    { name: "Billing", url: "https://loop.cloud.microsoft/billing", owner: "Bea", description: "Invoice steps" },
  ];

  it("matches name, owner, and note, and returns everything for a blank query", () => {
    expect(filterProcessLinks(links, "").map((link) => link.name)).toEqual(["Onboarding", "Billing"]);
    expect(filterProcessLinks(links, "invoice").map((link) => link.name)).toEqual(["Billing"]);
    expect(filterProcessLinks(links, "ADA").map((link) => link.name)).toEqual(["Onboarding"]);
    expect(filterProcessLinks(links, "missing")).toEqual([]);
  });
});
