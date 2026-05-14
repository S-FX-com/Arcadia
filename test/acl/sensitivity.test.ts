import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  policyFor,
  requiresExplicitAcl,
} from "../../src/acl/sensitivity";

describe("policyFor", () => {
  it("maps highly confidential -> redact", () => {
    expect(policyFor("Highly Confidential")).toBe("redact");
    expect(policyFor("HIGHLY CONFIDENTIAL")).toBe("redact");
    expect(policyFor("Restricted")).toBe("redact");
  });

  it("maps confidential -> confidential", () => {
    expect(policyFor("Confidential")).toBe("confidential");
  });

  it("maps internal/general -> restricted", () => {
    expect(policyFor("Internal")).toBe("restricted");
    expect(policyFor("General")).toBe("restricted");
  });

  it("maps public/unclassified -> public", () => {
    expect(policyFor("Public")).toBe("public");
    expect(policyFor("Unclassified")).toBe("public");
  });

  it("defaults to restricted on unknown / null", () => {
    expect(policyFor(null)).toBe("restricted");
    expect(policyFor(undefined)).toBe("restricted");
    expect(policyFor("Something Else")).toBe("restricted");
  });
});

describe("requiresExplicitAcl", () => {
  it("returns true only for confidential + redact", () => {
    expect(requiresExplicitAcl("confidential")).toBe(true);
    expect(requiresExplicitAcl("redact")).toBe(true);
    expect(requiresExplicitAcl("restricted")).toBe(false);
    expect(requiresExplicitAcl("public")).toBe(false);
  });
});

describe("applyPolicy", () => {
  it("returns full content for non-redact policies", () => {
    expect(applyPolicy("secret", "public", "viewer", "subject")).toBe("secret");
    expect(applyPolicy("secret", "restricted", "viewer", "subject")).toBe(
      "secret",
    );
    expect(applyPolicy("secret", "confidential", "viewer", "subject")).toBe(
      "secret",
    );
  });

  it("returns full content to the subject of a redact memory", () => {
    expect(applyPolicy("private", "redact", "aad-1", "aad-1")).toBe("private");
  });

  it("scrubs redact content for any non-subject viewer", () => {
    expect(applyPolicy("private", "redact", "aad-1", "aad-2")).toBe(
      "[redacted]",
    );
    expect(applyPolicy("private", "redact", "aad-1", undefined)).toBe(
      "[redacted]",
    );
  });
});
