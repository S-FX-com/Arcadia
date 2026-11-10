import { describe, expect, it } from "vitest";
import { handleDirectoryRoutes } from "../src/approval/directory";
import { handleEducationRoutes } from "../src/approval/education";
import { handlePatternRoutes } from "../src/approval/patterns";
import { mergeOverlay, selectActiveMembers } from "../src/lib/directory-merge";
import { canAddContinuingEducation, canReadContinuingEducation } from "../src/lib/education";
import type { UserRecord } from "../src/lib/rbac";
import { horizonDates, shiftInterval, skipConfirmedTimeOff, weekdayLabels } from "../src/lib/shift-pattern";

const staff = (role: UserRecord["role"], active = true): UserRecord => ({
  email: `${role}@s-fx.com`,
  role,
  active,
  grants: [],
});

/** A D1 stand-in with no rows. Writes succeed and are counted. */
function emptyDb(): { db: D1Database; writes: () => number } {
  let writes = 0;
  const statement = {
    bind() {
      return statement;
    },
    async run() {
      writes += 1;
      return { success: true };
    },
    async all() {
      return { results: [] };
    },
    async first() {
      return null;
    },
  };
  const db = {
    prepare() {
      return statement;
    },
  };
  return { db: db as unknown as D1Database, writes: () => writes };
}

const get = (path: string) => new Request(`https://arcadia.s-fx.com${path}`);
const post = (path: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request(`https://arcadia.s-fx.com${path}`, {
    method: "POST",
    body,
    headers: { Origin: "https://arcadia.s-fx.com", "Sec-Fetch-Site": "same-origin" },
  });
};

describe("directory overlay", () => {
  it("shows an Arcadia value on top of Graph and says which", () => {
    const merged = mergeOverlay(
      { jobTitle: "Engineer", department: "Delivery", city: "Chicago", state: "IL" },
      { titleOverride: "Principal", departmentOverride: "  ", cityOverride: null, stateOverride: "Illinois" }
    );
    expect(merged.title).toMatchObject({ shown: "Principal", source: "arcadia", graph: "Engineer" });
    expect(merged.department).toMatchObject({ shown: "Delivery", source: "graph" });
    expect(merged.city).toMatchObject({ shown: "Chicago", source: "graph" });
    expect(merged.state).toMatchObject({ shown: "Illinois", source: "arcadia", graph: "IL" });
    const cityWins = mergeOverlay({ city: "Chicago", state: "IL" }, { cityOverride: "Seattle" });
    expect(cityWins.city).toMatchObject({ shown: "Seattle", source: "arcadia", graph: "Chicago" });
    expect(cityWins.state).toMatchObject({ shown: "IL", source: "graph" });
  });

  it("shows nothing when neither side has a value", () => {
    expect(mergeOverlay({}).title).toEqual({ shown: null, source: "none", graph: null, arcadia: null });
  });

  it("keeps active member users and drops guests and disabled accounts", () => {
    const kept = selectActiveMembers([
      { id: "1", accountEnabled: true, userType: "Member", displayName: "Ada" },
      { id: "2", accountEnabled: false, userType: "Member", displayName: "Gone" },
      { id: "3", accountEnabled: true, userType: "Guest", displayName: "Guest" },
      { id: "", accountEnabled: true, userType: "Member" },
    ]);
    expect(kept.map((user) => user.displayName)).toEqual(["Ada"]);
  });
});

describe("shift pattern horizon and time off", () => {
  it("names the weekdays a pattern stores", () => {
    expect(weekdayLabels("[1,2,3,4,5]")).toBe("Mon, Tue, Wed, Thu, Fri");
  });

  const monday = new Date("2026-09-28T15:00:00Z");

  it("posts an eight-week horizon of the chosen weekdays", () => {
    const dates = horizonDates(monday, 8, [1]);
    expect(dates).toHaveLength(8);
    expect(dates[0]).toBe("2026-09-28");
    expect(dates[7]).toBe("2026-11-16");
    expect(horizonDates(monday, 1, [1, 3])).toEqual(["2026-09-28", "2026-09-30"]);
  });

  it("refuses a zero-length shift and allows an overnight one inside 24 hours", () => {
    expect(shiftInterval("2026-09-28", "09:00", "09:00")).toBeUndefined();
    const day = shiftInterval("2026-09-28", "09:00", "17:00");
    expect(day?.minutes).toBe(8 * 60);
    const overnight = shiftInterval("2026-09-28", "22:00", "06:00");
    expect(overnight?.minutes).toBe(8 * 60);
    expect(overnight?.end.toISOString()).toBe("2026-09-29T06:00:00.000Z");
  });

  it("skips a date that overlaps confirmed time off for that person only", () => {
    const dates = ["2026-09-28", "2026-09-29", "2026-09-30"];
    const timeOff = [
      { userId: "ada", startDateTime: "2026-09-29T00:00:00Z", endDateTime: "2026-09-30T00:00:00Z" },
      { userId: "grace", startDateTime: "2026-09-28T00:00:00Z", endDateTime: "2026-09-29T00:00:00Z" },
    ];
    const split = skipConfirmedTimeOff("ada", dates, "09:00", "17:00", timeOff);
    expect(split.skipped).toEqual(["2026-09-29"]);
    expect(split.post).toEqual(["2026-09-28", "2026-09-30"]);
  });
});

describe("continuing education audience", () => {
  it("lets every active member read and only an admin_users holder add for an active member", () => {
    for (const role of ["specialist", "lead", "founder", "superadmin"] as const) {
      expect(canReadContinuingEducation(staff(role))).toBe(true);
    }
    expect(canReadContinuingEducation(staff("superadmin", false))).toBe(false);
    for (const role of ["specialist", "lead", "founder"] as const) {
      expect(canAddContinuingEducation(staff(role), { activeMember: true }).ok).toBe(false);
    }
    expect(canAddContinuingEducation({ ...staff("lead"), grants: ["admin_users"] }, { activeMember: true }).ok).toBe(true);
    expect(canAddContinuingEducation(staff("superadmin"), { activeMember: false }).ok).toBe(false);
    expect(canAddContinuingEducation(staff("superadmin"), { activeMember: true }).ok).toBe(true);
  });
});

describe("Directory and Continuing Education access", () => {
  it("lets a specialist read the Directory without the editors or the sync panel", async () => {
    const { db } = emptyDb();
    const response = await handleDirectoryRoutes(get("/agency/directory"), { DB: db } as Env, staff("specialist"));
    expect(response?.status).toBe(200);
    const body = await response!.text();
    expect(body).toContain("Directory");
    expect(body).not.toContain("/agency/directory/sync");
    expect(body).not.toContain("/agency/directory/overlay");
    expect(body).not.toContain("/agency/directory/ignore");
    expect(body).not.toContain("Where people are");
  });

  it("shows a superadmin the sync panel and the editors", async () => {
    const { db } = emptyDb();
    const response = await handleDirectoryRoutes(get("/agency/directory"), { DB: db } as Env, staff("superadmin"));
    expect(response?.status).toBe(200);
    const body = await response!.text();
    expect(body).toContain("/agency/directory/sync");
    expect(body).toContain("Arcadia values");
  });

  it("refuses every Directory change to a specialist without writing", async () => {
    const specialist = staff("specialist");
    for (const [path, fields] of [
      ["/agency/directory/sync", {}],
      ["/agency/directory/overlay", { aadId: "ada", field: "title", value: "Lead" }],
      ["/agency/directory/social", { aadId: "ada", network: "x", url: "https://x.com/ada", intent: "add" }],
      ["/agency/directory/ignore", { aadId: "ada", intent: "ignore" }],
    ] as const) {
      const { db, writes } = emptyDb();
      const response = await handleDirectoryRoutes(post(path, fields), { DB: db } as Env, specialist);
      expect(response?.status, path).toBe(403);
      expect(writes(), path).toBe(0);
    }
  });

  it("lets a specialist read Continuing Education without the add form, and refuses an add", async () => {
    const specialist = staff("specialist");
    const read = emptyDb();
    const page = await handleEducationRoutes(get("/agency/education"), { DB: read.db } as Env, specialist);
    expect(page?.status).toBe(200);
    const body = await page!.text();
    expect(body).toContain("Continuing Education");
    expect(body).not.toContain("Add an Accomplishment");

    const write = emptyDb();
    const added = await handleEducationRoutes(
      post("/agency/education", { subject: "ada", kind: "course", title: "First aid", completedOn: "2026-11-01" }),
      { DB: write.db } as Env,
      specialist
    );
    expect(added?.status).toBe(403);
    expect(write.writes()).toBe(0);
  });

  it("answers only the new Continuing Education path", async () => {
    const { db } = emptyDb();
    expect(await handleEducationRoutes(get("/agency/continuing-education"), { DB: db } as Env, staff("superadmin"))).toBeUndefined();
  });

  it("keeps shift patterns behind admin_users", async () => {
    const { db } = emptyDb();
    const response = await handlePatternRoutes(get("/agency/schedule/patterns"), { DB: db } as Env, staff("specialist"));
    expect(response?.status).toBe(403);
  });
});
