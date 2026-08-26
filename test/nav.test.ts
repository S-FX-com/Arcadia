import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, initials } from "../src/approval/nav";
import { SECTIONS, handleSectionRoutes } from "../src/approval/sections";
import type { UserRecord } from "../src/lib/rbac";

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  email: "someone@s-fx.com",
  role: "specialist",
  active: true,
  grants: [],
  ...over,
});

const get = (path: string, as: UserRecord = user()) =>
  handleSectionRoutes(new Request(`https://arcadia.s-fx.com${path}`), as);

/** Pages that have been built and route through their own module. */
const LIVE_PAGES = ["/agency/leadership", "/agency/objectives", "/agency/schedule", "/clients"];

describe("navigation model", () => {
  it("carries Agency and Clients in the order the department reads them", () => {
    const groups = NAV_SECTIONS.map((s) => s.group);
    expect(groups.slice(0, 2)).toEqual(["Agency", "Clients"]);

    const labels = (group: string) =>
      NAV_SECTIONS.find((s) => s.group === group)?.items.map((i) => i.label);
    expect(labels("Agency")).toEqual([
      "Leadership",
      "Processes",
      "Objectives",
      "Schedule",
      "Continuing Education",
    ]);
    // One workspace surface since v5.0 (approval/clients.tsx), not three
    // placeholders — Onboarding and Health were shaped around instruments
    // that are dormant under the v5 posture (§4.3).
    expect(labels("Clients")).toEqual(["Workspaces"]);
  });

  it("points every placeholder nav item at a route that answers", () => {
    for (const item of NAV_SECTIONS.flatMap((s) => s.items)) {
      // Live surfaces are routed elsewhere; the placeholders are routed here.
      if (!item.to.startsWith("/agency") && !item.to.startsWith("/clients")) continue;
      if (LIVE_PAGES.includes(item.to)) continue;
      expect(get(item.to, user({ role: "superadmin" }))?.status, item.to).toBe(200);
    }
  });

  it("leaves the live pages to their own routers", () => {
    // Leadership reads the staff reporting line (approval/leadership.tsx),
    // Workspaces reads clients and bindings (approval/clients.tsx). A
    // placeholder left behind here would shadow them.
    for (const path of LIVE_PAGES) {
      expect(SECTIONS.some((s) => s.path === path), path).toBe(false);
      expect(get(path), path).toBeUndefined();
    }
  });

  it("derives two initials from a display name, else from the address", () => {
    expect(initials(user({ displayName: "Shane Skwarek" }))).toBe("SS");
    expect(initials(user({ email: "vicky@s-fx.com" }))).toBe("VI");
  });
});

describe("agency placeholders", () => {
  it("lands the group root on its first page and leaves /clients alone", () => {
    expect(get("/agency")?.headers.get("Location")).toBe("/agency/leadership");
    // /clients belongs to approval/clients.tsx since v5.0.
    expect(get("/clients")).toBeUndefined();
  });

  it("leaves paths it does not own alone", () => {
    expect(get("/approval/ops")).toBeUndefined();
    expect(get("/agency/nothing-here")).toBeUndefined();
  });

  it("accepts no input — these pages are read-only", () => {
    const post = handleSectionRoutes(
      new Request("https://arcadia.s-fx.com/agency/objectives", { method: "POST" }),
      user()
    );
    expect(post?.status).toBe(405);
  });

  it("says on every page that it is not built, and shows no invented figure", async () => {
    for (const section of SECTIONS) {
      const body = await get(section.path, user({ role: "superadmin" }))!.text();
      expect(body, section.path).toContain("Not built yet");
      // A placeholder that renders a sample row or a stat tile reads as data.
      expect(body, section.path).not.toContain('class="stat');
      expect(body, section.path).not.toContain("<tbody");
    }
  });
});
