import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, Sidebar, canSeeAdmin, initials, navLabelsFor } from "../src/approval/nav";
import type { Role, UserRecord } from "../src/lib/rbac";

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  email: "someone@s-fx.com",
  role: "specialist",
  active: true,
  grants: [],
  ...over,
});

const ROLES: Role[] = ["superadmin", "founder", "lead", "specialist"];

const rail = (as: UserRecord): string => render(h(Sidebar, { user: as }));

/** v5 surfaces that must not come back as nav items or placeholders. */
const GONE = [
  "Ask Arcadia",
  "Operations",
  "Doctrine",
  "Leadership",
  "Processes",
  "Objectives",
  "Workspaces",
  "Clients",
  "Not built yet",
];

describe("v6 navigation", () => {
  it("is one Agency group: Directory, Schedule, Continuing Education", () => {
    expect(NAV_SECTIONS.map((s) => s.group)).toEqual(["Agency"]);
    expect(NAV_SECTIONS[0]?.items.map((i) => [i.label, i.to])).toEqual([
      ["Directory", "/agency/directory"],
      ["Schedule", "/agency/schedule"],
      ["Continuing Education", "/agency/education"],
    ]);
  });

  it("shows every role the same three pages", () => {
    for (const role of ROLES) {
      expect(navLabelsFor(user({ role })), role).toEqual(["Directory", "Schedule", "Continuing Education"]);
    }
  });

  it("shows a deactivated account no pages", () => {
    expect(navLabelsFor(user({ role: "superadmin", active: false }))).toEqual([]);
  });

  it("renders no placeholder, no Ask Arcadia CTA and no deleted surface for any role", () => {
    for (const role of ROLES) {
      const body = rail(user({ role }));
      for (const label of GONE) expect(body, `${role} ${label}`).not.toContain(label);
      expect(body, role).not.toContain('class="cta');
      expect(body, role).not.toContain("/approval/ops");
      expect(body, role).not.toContain("/chat");
      expect(body, role).not.toContain("/#latest");
      expect(body, role).not.toContain('href="/clients"');
      for (const path of ["/agency/directory", "/agency/schedule", "/agency/education"]) {
        expect(body, `${role} ${path}`).toContain(`href="${path}"`);
      }
    }
  });

  it("links the brand to the Directory", () => {
    expect(rail(user())).toMatch(/<a class="brand" href="\/agency\/directory"/);
  });

  it("marks the current page", () => {
    const body = render(h(Sidebar, { user: user(), current: "schedule" }));
    expect(body).toContain('class="navitem active" href="/agency/schedule" aria-current="page"');
    expect(body.match(/aria-current/g)).toHaveLength(1);
  });

  it("offers the Admin link only to admin_models or admin_users holders", () => {
    expect(canSeeAdmin(user({ role: "superadmin" }))).toBe(true);
    expect(canSeeAdmin(user({ role: "founder" }))).toBe(false);
    expect(canSeeAdmin(user({ role: "lead" }))).toBe(false);
    expect(canSeeAdmin(user({ role: "specialist" }))).toBe(false);
    expect(canSeeAdmin(user({ grants: ["admin_users"] }))).toBe(true);
    expect(canSeeAdmin(user({ grants: ["admin_models"] }))).toBe(true);

    expect(rail(user({ role: "superadmin" }))).toContain('href="/approval/admin"');
    expect(rail(user({ role: "specialist" }))).not.toContain('href="/approval/admin"');
    expect(rail(user({ role: "founder" }))).not.toContain('href="/approval/admin"');
    expect(rail(user({ grants: ["admin_models"] }))).toContain('href="/approval/admin"');
  });

  it("derives two initials from a display name, else from the address", () => {
    expect(initials(user({ displayName: "Shane Skwarek" }))).toBe("SS");
    expect(initials(user({ email: "vicky@s-fx.com" }))).toBe("VI");
  });
});
