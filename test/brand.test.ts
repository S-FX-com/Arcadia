import { describe, expect, it } from "vitest";
import { brandViolations } from "../src/lib/brand";

describe("brandViolations", () => {
  it("flags every banned term (§7)", () => {
    expect(brandViolations("We are the best MSP in town")).toContain("MSP");
    expect(brandViolations("your trusted managed service provider")).toContain("managed service provider");
    expect(brandViolations("a full-service agency")).toContain("agency");
    expect(brandViolations("as an IT company we")).toContain("IT company");
    expect(brandViolations("choose us as your vendor")).toContain("vendor");
    expect(brandViolations("multiple vendors were compared")).toContain("vendor");
    expect(brandViolations("several agencies do this")).toContain("agency");
  });

  it("passes the approved positioning", () => {
    expect(brandViolations("S-FX is an outsourced technology department. S-FX Specialists ship weekly.")).toEqual([]);
  });

  it("flags superseded fractional positioning", () => {
    expect(brandViolations("S-FX is a fractional technology department.")).toContain(
      "fractional technology department"
    );
  });

  it("does not false-positive on substrings", () => {
    expect(brandViolations("the MSPaint tutorial")).toEqual([]);
    expect(brandViolations("urgency matters in checkout flows")).toEqual([]);
  });
});
