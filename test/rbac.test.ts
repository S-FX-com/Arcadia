import { describe, expect, it } from "vitest";
import {
  can,
  canViewPersonRecord,
  capabilitiesOf,
  type UserRecord,
} from "../src/lib/rbac";

const user = (over: Partial<UserRecord>): UserRecord => ({
  email: "someone@s-fx.com",
  role: "specialist",
  active: true,
  grants: [],
  ...over,
});

describe("role capabilities", () => {
  it("gives superadmin everything, including admin surfaces", () => {
    const shane = user({ email: "shane@s-fx.com", role: "superadmin" });
    expect(can(shane, "admin_models")).toBe(true);
    expect(can(shane, "admin_users")).toBe(true);
    expect(can(shane, "approve_plans")).toBe(true);
    expect(can(shane, "ratify_doctrine")).toBe(true);
  });

  it("withholds tenancy administration from the founder role", () => {
    const founder = user({ role: "founder" });
    expect(can(founder, "ratify_doctrine")).toBe(true);
    expect(can(founder, "approve_plans")).toBe(true);
    expect(can(founder, "admin_models")).toBe(false);
    expect(can(founder, "admin_users")).toBe(false);
  });

  it("keeps leads out of doctrine ratification", () => {
    const lead = user({ role: "lead" });
    expect(can(lead, "approve_plans")).toBe(true);
    expect(can(lead, "manage_projects")).toBe(true);
    expect(can(lead, "ratify_doctrine")).toBe(false);
    expect(can(lead, "admin_users")).toBe(false);
  });

  it("limits specialists to the board, signing, and asking", () => {
    const spec = user({});
    expect(capabilitiesOf(spec).sort()).toEqual(["ask_arcadia", "sign_certification", "view_board"]);
    expect(can(spec, "approve_plans")).toBe(false);
  });

  it("honors explicit grants beyond the role", () => {
    const diego = user({ role: "lead", grants: ["ratify_doctrine"] });
    expect(can(diego, "ratify_doctrine")).toBe(true);
  });

  it("gives a deactivated account nothing, whatever the role", () => {
    const gone = user({ role: "superadmin", active: false });
    expect(can(gone, "view_board")).toBe(false);
    expect(capabilitiesOf(gone)).toEqual([]);
  });
});

describe("canViewPersonRecord (§5.7)", () => {
  it("lets a person see their own numbers", () => {
    const self = user({ email: "dev@s-fx.com" });
    expect(canViewPersonRecord(self, "dev@s-fx.com")).toBe(true);
    expect(canViewPersonRecord(self, "DEV@S-FX.COM")).toBe(true);
  });

  it("lets their lead see them", () => {
    const lead = user({ email: "lead@s-fx.com", role: "lead" });
    expect(canViewPersonRecord(lead, "dev@s-fx.com", "lead@s-fx.com")).toBe(true);
  });

  it("blocks an unrelated lead", () => {
    const other = user({ email: "otherlead@s-fx.com", role: "lead" });
    expect(canViewPersonRecord(other, "dev@s-fx.com", "lead@s-fx.com")).toBe(false);
  });

  it("lets Shane see everyone", () => {
    const shane = user({ email: "shane@s-fx.com", role: "superadmin" });
    expect(canViewPersonRecord(shane, "dev@s-fx.com", "lead@s-fx.com")).toBe(true);
  });
});
