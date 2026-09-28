import { describe, expect, it } from "vitest";
import { chartRootHtml, directoryChartHtml, type OrgChartModel } from "../src/approval/org-chart";
import type { ChartPerson } from "../src/lib/directory-chart";

function person(id: string, name: string, title: string): ChartPerson {
  return {
    id,
    email: `${id}@s-fx.com`,
    name,
    title,
    department: "Web Development",
    initials: name.slice(0, 2).toUpperCase(),
  };
}

function model(): OrgChartModel {
  const shane = person("shane", "Shane Skwarek", "Project Manager");
  const alex = person("alex", "Alex Jordan", "Microsoft 365: Project Manager");
  const diego = person("diego", "Diego Velasquez", "Specialist");
  return {
    people: [shane, alex, diego],
    baselines: new Map([
      ["shane", "none:"],
      ["alex", "graph:shane"],
      ["diego", "graph:alex"],
    ]),
    edges: new Map([
      ["shane", { personId: "shane", managerId: null, source: "none" }],
      ["alex", { personId: "alex", managerId: "shane", source: "graph" }],
      ["diego", { personId: "diego", managerId: "alex", source: "graph" }],
    ]),
    tree: {
      roots: [
        {
          person: shane,
          source: "none",
          loop: false,
          reports: [
            {
              person: alex,
              source: "graph",
              loop: false,
              reports: [{ person: diego, source: "graph", loop: false, reports: [] }],
            },
          ],
        },
      ],
      unplaced: [],
    },
  };
}

describe("leadership chart markup", () => {
  it("zooms, collapses, and applies without a title field or a per-card save", () => {
    const html = directoryChartHtml(model());
    expect(html).toContain("Zoom out");
    expect(html).toContain("Zoom in");
    expect(html).toContain('data-zoom="fit"');
    expect(html).toContain("Fit");
    expect(html).toContain("100%");
    expect(html).toContain('data-apply');
    expect(html).toContain("Apply");
    expect(html).toContain("Collapse");
    expect(html).toContain("Manager");
    expect(html).toContain("Project Manager");
    expect(html).toContain("Microsoft 365: Project Manager");
    expect(html).not.toContain('name="title"');
    expect(html).not.toContain("Set in place");
    expect(html).not.toContain("<input");
    expect(html.match(/class="orgtoggle"/g)).toHaveLength(2);
  });

  it("redraws the tree from the same card markup", () => {
    const html = chartRootHtml(model());
    expect(html).toContain('data-person="diego"');
    expect(html).toContain("Reports to Alex Jordan");
    expect(html).not.toContain("Zoom in");
    expect(html).not.toContain('name="title"');
  });
});
