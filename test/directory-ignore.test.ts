import { describe, expect, it } from "vitest";
import { buildDirectoryTree, chartMembers, type ChartPerson } from "../src/lib/directory-chart";
import { notIgnoredSql, partitionIgnored } from "../src/lib/directory-ignore";

describe("directory ignore", () => {
  it("drops ignored accounts from a staff list and keeps them for restore", () => {
    const ada = { aadId: "ada", name: "Ada Lovelace" };
    const list = { aadId: "list", name: "All Staff" };
    const inbox = { aadId: "inbox", name: "Shared Inbox" };
    const split = partitionIgnored([ada, list, inbox], ["list", "inbox"]);
    expect(split.visible).toEqual([ada]);
    expect(split.ignored).toEqual([list, inbox]);
  });

  it("leaves everyone visible when nothing is ignored", () => {
    const split = partitionIgnored([{ aadId: "ada", name: "Ada" }], ["missing"]);
    expect(split.visible.map((person) => person.name)).toEqual(["Ada"]);
    expect(split.ignored).toEqual([]);
  });

  it("keeps an ignored account off the org chart", () => {
    const ada: ChartPerson = {
      id: "ada",
      email: "ada@s-fx.com",
      name: "Ada Lovelace",
      title: "Specialist",
      department: "Delivery",
      initials: "AL",
    };
    const inbox: ChartPerson = {
      id: "inbox",
      email: "inbox@s-fx.com",
      name: "Shared Inbox",
      title: "Mailbox",
      department: "Lists",
      initials: "SI",
    };
    const visible = partitionIgnored(
      [
        { aadId: ada.id, person: ada },
        { aadId: inbox.id, person: inbox },
      ],
      [inbox.id]
    ).visible.map((row) => row.person);
    const tree = buildDirectoryTree(visible, [{ personId: ada.id, managerId: null, source: "none" }]);
    expect(chartMembers(tree).map((person) => person.name)).toEqual(["Ada Lovelace"]);
    expect(tree.unplaced.map((row) => row.person.name)).toEqual(["Ada Lovelace"]);
    expect(chartMembers(tree).some((person) => person.name === "Shared Inbox")).toBe(false);
  });

  it("names the clause staff-list queries use", () => {
    expect(notIgnoredSql("directory_profiles.aad_id")).toBe(
      "NOT EXISTS (SELECT 1 FROM directory_ignored i WHERE i.aad_id = directory_profiles.aad_id)"
    );
    expect(notIgnoredSql("p.aad_id")).toContain("directory_ignored");
    expect(notIgnoredSql("p.aad_id")).toContain("p.aad_id");
    expect(notIgnoredSql("directory_profiles.aad_id")).toContain("directory_profiles.aad_id");
  });
});
