import { describe, expect, it } from "vitest";
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

  it("names the clause staff-list queries use", () => {
    expect(notIgnoredSql("directory_profiles.aad_id")).toBe(
      "NOT EXISTS (SELECT 1 FROM directory_ignored i WHERE i.aad_id = directory_profiles.aad_id)"
    );
    expect(notIgnoredSql("p.aad_id")).toContain("directory_ignored");
    expect(notIgnoredSql("p.aad_id")).toContain("p.aad_id");
    expect(notIgnoredSql("directory_profiles.aad_id")).toContain("directory_profiles.aad_id");
  });
});
