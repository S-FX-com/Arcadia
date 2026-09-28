import { describe, expect, it } from "vitest";
import {
  buildDirectoryTree,
  chartMembers,
  initials,
  managerEditNotice,
  planManagerEdits,
  resolveChartEdge,
  sameChartLine,
  type ChartPerson,
} from "../src/lib/directory-chart";
import { directoryLastError, kickIfNeverSynced, planLastError, shouldAutoSync } from "../src/lib/m365-sync";

const person = (id: string, name: string): ChartPerson => ({
  id,
  email: `${id}@s-fx.com`,
  name,
  title: "Specialist",
  department: "Delivery",
  initials: initials(name),
});

describe("directory chart edges", () => {
  it("prefers the Arcadia manager over Graph and the staff record", () => {
    expect(
      resolveChartEdge({
        personId: "ada",
        overlay: { managerId: "shane" },
        graphManagerId: "diego",
        proofSucceeded: true,
        leadManagerId: "alex",
      })
    ).toEqual({ personId: "ada", managerId: "shane", source: "overlay" });
  });

  it("keeps an explicit Unplaced overlay from falling through to Graph", () => {
    expect(
      resolveChartEdge({
        personId: "ada",
        overlay: { managerId: null },
        graphManagerId: "diego",
        proofSucceeded: true,
        leadManagerId: "alex",
      })
    ).toEqual({ personId: "ada", managerId: null, source: "overlay" });
  });

  it("uses the Graph manager only after the proof succeeded", () => {
    expect(
      resolveChartEdge({
        personId: "ada",
        overlay: null,
        graphManagerId: "diego",
        proofSucceeded: true,
        leadManagerId: "alex",
      })
    ).toEqual({ personId: "ada", managerId: "diego", source: "graph" });
    expect(
      resolveChartEdge({
        personId: "ada",
        overlay: null,
        graphManagerId: "diego",
        proofSucceeded: false,
        leadManagerId: "alex",
      })
    ).toEqual({ personId: "ada", managerId: "alex", source: "lead" });
  });

  it("uses the staff record when Graph has no manager", () => {
    expect(
      resolveChartEdge({
        personId: "ada",
        overlay: null,
        graphManagerId: null,
        proofSucceeded: true,
        leadManagerId: "alex",
      }).source
    ).toBe("lead");
  });

  it("does not treat a title-only save as a new manager line", () => {
    expect(sameChartLine("graph:diego", "diego")).toBe(true);
    expect(sameChartLine("none:", "__unplaced__")).toBe(true);
    expect(sameChartLine("graph:diego", "shane")).toBe(false);
    expect(sameChartLine("overlay:diego", "__clear__")).toBe(false);
    expect(sameChartLine("graph:diego", "__unplaced__")).toBe(false);
  });
});

describe("batch manager apply", () => {
  const people = new Set(["shane", "alex", "diego", "pat"]);
  const current = new Map<string, string | null>([
    ["shane", null],
    ["alex", "shane"],
    ["diego", "shane"],
    ["pat", "diego"],
  ]);
  const open = new Map<string, string | null>([
    ["shane", null],
    ["alex", "shane"],
    ["diego", "shane"],
    ["pat", "diego"],
  ]);
  const names: Record<string, string> = {
    shane: "Shane Skwarek",
    alex: "Alex Jordan",
    diego: "Diego Velasquez",
    pat: "Pat Nguyen",
  };

  it("keeps two manager changes and names the one that would loop", () => {
    const plan = planManagerEdits({
      peopleIds: people,
      current,
      openManagers: open,
      edits: [
        { personId: "alex", picked: "diego", baseline: "graph:shane" },
        { personId: "pat", picked: "alex", baseline: "graph:diego" },
        { personId: "shane", picked: "pat", baseline: "none:" },
      ],
    });
    expect(plan.writes.map((write) => write.personId)).toEqual(["alex", "pat"]);
    expect(plan.looped).toEqual(["shane"]);
    expect(plan.missing).toEqual([]);
    const notice = managerEditNotice({
      writes: plan.writes,
      looped: plan.looped,
      missing: plan.missing,
      nameOf: (id) => names[id] ?? id,
    });
    expect(notice).toContain("Alex Jordan now reports to Diego Velasquez.");
    expect(notice).toContain("Pat Nguyen now reports to Alex Jordan.");
    expect(notice).toContain("Shane Skwarek's line was left unchanged.");
    expect(notice).not.toContain("The chart shows those lines.");
  });

  it("applies a pair that is safe only after both moves", () => {
    const plan = planManagerEdits({
      peopleIds: people,
      current: new Map<string, string | null>([
        ["shane", null],
        ["alex", "diego"],
        ["diego", null],
        ["pat", "shane"],
      ]),
      openManagers: open,
      edits: [
        { personId: "diego", picked: "alex", baseline: "none:" },
        { personId: "alex", picked: "shane", baseline: "overlay:diego" },
      ],
    });
    expect(plan.looped).toEqual([]);
    expect(plan.writes.map((write) => write.personId).sort()).toEqual(["alex", "diego"]);
  });

  it("does not write a dropdown that still matches the drawn line", () => {
    const plan = planManagerEdits({
      peopleIds: people,
      current,
      openManagers: open,
      edits: [{ personId: "alex", picked: "shane", baseline: "graph:shane" }],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.looped).toEqual([]);
    expect(
      managerEditNotice({ writes: [], looped: [], missing: [], nameOf: (id) => names[id] ?? id })
    ).toBe("Nothing pending was different from the chart.");
  });
});

describe("directory chart tree", () => {
  const shane = person("shane", "Shane Skwarek");
  const diego = person("diego", "Diego Velasquez");
  const allie = person("allie", "Allie Nguyen");
  const casey = person("casey", "Casey Morgan");

  it("nests a multi-level tree and leaves someone with no line Unplaced", () => {
    const tree = buildDirectoryTree(
      [shane, diego, allie, casey],
      [
        { personId: "shane", managerId: null, source: "none" },
        { personId: "diego", managerId: "shane", source: "overlay" },
        { personId: "allie", managerId: "diego", source: "graph" },
        { personId: "casey", managerId: null, source: "none" },
      ]
    );
    expect(tree.roots.map((root) => root.person.id)).toEqual(["shane"]);
    expect(tree.roots[0]?.reports.map((node) => node.person.id)).toEqual(["diego"]);
    expect(tree.roots[0]?.reports[0]?.reports.map((node) => node.person.id)).toEqual(["allie"]);
    expect(tree.unplaced.map((row) => [row.person.name, row.reason])).toEqual([["Casey Morgan", "no-line"]]);
    expect(chartMembers(tree).map((row) => row.id).sort()).toEqual(["allie", "casey", "diego", "shane"]);
  });

  it("puts a line that names someone off the chart into Unplaced", () => {
    const tree = buildDirectoryTree(
      [casey],
      [{ personId: "casey", managerId: "missing", source: "lead" }]
    );
    expect(tree.roots).toHaveLength(0);
    expect(tree.unplaced[0]?.reason).toBe("manager-missing");
  });

  it("cuts a reporting loop and still shows every person once", () => {
    const a = person("a", "Ada Lovelace");
    const b = person("b", "Grace Hopper");
    const c = person("c", "Lin Chen");
    const tree = buildDirectoryTree(
      [a, b, c],
      [
        { personId: "a", managerId: "c", source: "overlay" },
        { personId: "b", managerId: "a", source: "overlay" },
        { personId: "c", managerId: "b", source: "overlay" },
      ]
    );
    const members = chartMembers(tree);
    expect(members).toHaveLength(3);
    expect(new Set(members.map((row) => row.id)).size).toBe(3);
    const loop = tree.roots.find((root) => root.loop) ?? tree.unplaced.find((row) => row.reason === "loop");
    expect(loop).toBeTruthy();
  });
});

describe("initials", () => {
  it("uses the first and last name", () => {
    expect(initials("Shane Skwarek")).toBe("SS");
    expect(initials("Alex")).toBe("AL");
  });
});

describe("never-synced auto-run", () => {
  it("starts a sync on open only when nothing has synced and Microsoft 365 is connected", async () => {
    const starts: string[] = [];
    const start = async () => {
      starts.push("yes");
    };
    expect(shouldAutoSync({ hasRun: false, connected: true })).toBe(true);
    expect(shouldAutoSync({ hasRun: true, connected: true })).toBe(false);
    expect(shouldAutoSync({ hasRun: false, connected: false })).toBe(false);
    expect(await kickIfNeverSynced({ hasRun: false, connected: true, start })).toBe("started");
    expect(await kickIfNeverSynced({ hasRun: true, connected: true, start })).toBe("skipped");
    expect(await kickIfNeverSynced({ hasRun: false, connected: false, start })).toBe("skipped");
    expect(starts).toEqual(["yes"]);
  });

  it("turns a refused read into one plain sentence and stays quiet on a clean run", () => {
    expect(directoryLastError({ manager_proof: "succeeded", users_seen: 41, detail: "App-only manager read returned an id." })).toBeNull();
    expect(directoryLastError({ manager_proof: "failed", users_seen: 0, detail: "HTTP 403 Authorization_RequestDenied" })).toBe(
      "Microsoft 365 refused the directory read. Consent for User.Read.All is missing."
    );
    expect(planLastError("12 Unified group(s), 40 plan(s), 2 omitted.")).toBeNull();
    expect(planLastError("Microsoft 365 refused the plan index. Consent for GroupMember.Read.All or Tasks.Read.All is missing.")).toBe(
      "Microsoft 365 refused the plan index. Consent for GroupMember.Read.All or Tasks.Read.All is missing."
    );
  });
});
