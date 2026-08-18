// The reporting line drives who gets escalated to, who gets pinged, and who
// may read a person's certification numbers. These tests are about the cases
// where the edge does not hold: nobody may vanish from the chart silently, and
// a loop must not hang the page that renders it.

import { describe, expect, it } from "vitest";
import { buildOrgChart, ladderDisagreements, leadOf, personLabel, type OrgPerson } from "../src/lib/org";

const person = (email: string, over: Partial<OrgPerson> = {}): OrgPerson => ({
  email,
  role: "specialist",
  active: true,
  ...over,
});

const shane = person("shane@s-fx.com", { role: "founder", displayName: "Shane" });
const diego = person("diego@s-fx.com", { role: "lead", displayName: "Diego", leadEmail: "shane@s-fx.com" });
const allie = person("allie@s-fx.com", { displayName: "Allie", leadEmail: "diego@s-fx.com" });

describe("buildOrgChart", () => {
  it("nests reports under their lead and counts the tree below each one", () => {
    const chart = buildOrgChart([allie, diego, shane]);
    expect(chart.roots).toHaveLength(1);
    const root = chart.roots[0]!;
    expect(root.person.email).toBe("shane@s-fx.com");
    expect(root.total).toBe(2);
    expect(root.reports[0]?.person.email).toBe("diego@s-fx.com");
    expect(root.reports[0]?.reports[0]?.person.email).toBe("allie@s-fx.com");
    expect(root.reports[0]?.reports[0]?.depth).toBe(2);
  });

  it("matches the lead edge case-insensitively — an email is not case-sensitive", () => {
    const chart = buildOrgChart([shane, person("x@s-fx.com", { leadEmail: "SHANE@S-FX.COM" })]);
    expect(chart.roots).toHaveLength(1);
    expect(chart.roots[0]?.reports).toHaveLength(1);
    expect(chart.gaps).toHaveLength(0);
  });

  it("names a specialist with no lead as a gap, but not the founder", () => {
    const orphan = person("nobody@s-fx.com");
    const chart = buildOrgChart([shane, orphan]);
    expect(chart.gaps.map((g) => [g.person.email, g.kind])).toEqual([["nobody@s-fx.com", "no_lead"]]);
    // Still on the chart — a person missing from both lists reaches nothing.
    expect(chart.roots.map((r) => r.person.email).sort()).toEqual(["nobody@s-fx.com", "shane@s-fx.com"]);
  });

  it("flags a lead who is not a staff record", () => {
    const chart = buildOrgChart([person("a@s-fx.com", { leadEmail: "ghost@s-fx.com" })]);
    expect(chart.gaps[0]?.kind).toBe("lead_not_on_staff");
    expect(chart.gaps[0]?.namedLead).toBe("ghost@s-fx.com");
  });

  it("flags a deactivated lead while still drawing the edge", () => {
    const gone = person("gone@s-fx.com", { role: "lead", active: false });
    const under = person("under@s-fx.com", { leadEmail: "gone@s-fx.com" });
    const chart = buildOrgChart([gone, under]);
    expect(chart.gaps.map((g) => g.kind)).toEqual(["lead_inactive"]);
    expect(chart.roots[0]?.reports[0]?.person.email).toBe("under@s-fx.com");
  });

  it("flags someone recorded as their own lead and does not orphan them", () => {
    const chart = buildOrgChart([person("self@s-fx.com", { leadEmail: "self@s-fx.com" })]);
    expect(chart.gaps[0]?.kind).toBe("self_lead");
    expect(chart.roots).toHaveLength(1);
  });

  it("cuts a reporting loop loose instead of recursing forever", () => {
    const a = person("a@s-fx.com", { leadEmail: "b@s-fx.com" });
    const b = person("b@s-fx.com", { leadEmail: "c@s-fx.com" });
    const c = person("c@s-fx.com", { leadEmail: "a@s-fx.com" });
    const chart = buildOrgChart([a, b, c]);
    expect(chart.gaps.filter((g) => g.kind === "cycle").map((g) => g.person.email).sort()).toEqual([
      "a@s-fx.com",
      "b@s-fx.com",
      "c@s-fx.com",
    ]);
    // Every member is reachable, and the walk terminated.
    expect(chart.roots).toHaveLength(3);
    expect(chart.roots.every((r) => r.reports.length === 0)).toBe(true);
  });

  it("keeps a clean branch intact when another branch loops", () => {
    const a = person("a@s-fx.com", { leadEmail: "b@s-fx.com" });
    const b = person("b@s-fx.com", { leadEmail: "a@s-fx.com" });
    const chart = buildOrgChart([shane, diego, allie, a, b]);
    const root = chart.roots.find((r) => r.person.email === "shane@s-fx.com");
    expect(root?.total).toBe(2);
  });

  it("puts the founder at the top of the roots", () => {
    const chart = buildOrgChart([person("zed@s-fx.com"), shane]);
    expect(chart.roots[0]?.person.email).toBe("shane@s-fx.com");
  });

  it("loses nobody: everyone is in the tree, in a gap, or both", () => {
    const people = [shane, diego, allie, person("orphan@s-fx.com"), person("loop@s-fx.com", { leadEmail: "loop@s-fx.com" })];
    const chart = buildOrgChart(people);
    const inTree = new Set<string>();
    const walk = (nodes: ReturnType<typeof buildOrgChart>["roots"]) => {
      for (const n of nodes) {
        inTree.add(n.person.email);
        walk(n.reports);
      }
    };
    walk(chart.roots);
    expect(inTree.size).toBe(people.length);
  });
});

describe("personLabel", () => {
  it("prefers a display name and falls back to the address", () => {
    expect(personLabel(shane)).toBe("Shane");
    expect(personLabel(person("x@s-fx.com"))).toBe("x@s-fx.com");
    expect(personLabel(person("y@s-fx.com", { displayName: "   " }))).toBe("y@s-fx.com");
  });
});

describe("leadOf", () => {
  it("resolves the lead a person's escalations land on", () => {
    const chart = buildOrgChart([shane, diego, allie]);
    expect(leadOf(chart, "allie@s-fx.com")?.email).toBe("diego@s-fx.com");
    expect(leadOf(chart, "shane@s-fx.com")).toBeUndefined();
    expect(leadOf(chart, "stranger@s-fx.com")).toBeUndefined();
  });
});

describe("ladderDisagreements", () => {
  const chart = buildOrgChart([shane, diego, allie]);

  it("names a project escalating to someone who is not the owner's lead", () => {
    const found = ladderDisagreements(chart, [
      { id: "p1", name: "Redesign", owner: "allie@s-fx.com", lead: "shane@s-fx.com", pod: null },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.projectLead).toBe("shane@s-fx.com");
    expect(found[0]?.chartLead).toBe("diego@s-fx.com");
  });

  it("stays quiet when the project already escalates to the chart's lead", () => {
    expect(
      ladderDisagreements(chart, [
        { id: "p1", name: "Redesign", owner: "Allie@S-FX.com", lead: "DIEGO@s-fx.com", pod: null },
      ])
    ).toEqual([]);
  });

  it("catches a project with no escalation lead at all", () => {
    const found = ladderDisagreements(chart, [
      { id: "p2", name: "Migration", owner: "allie@s-fx.com", lead: null, pod: null },
    ]);
    expect(found[0]?.projectLead).toBeNull();
    expect(found[0]?.chartLead).toBe("diego@s-fx.com");
  });

  it("skips a project with no owner — there is no reporting line to compare", () => {
    expect(
      ladderDisagreements(chart, [{ id: "p3", name: "Unowned", owner: null, lead: "diego@s-fx.com", pod: null }])
    ).toEqual([]);
  });
});
