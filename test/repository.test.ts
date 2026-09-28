import { describe, expect, it } from "vitest";
import { handleDirectoryRoutes } from "../src/approval/directory";
import { handleEducationRoutes } from "../src/approval/education";
import { handleObjectivesRoutes } from "../src/approval/objectives";
import { handlePlanIndexRoutes } from "../src/approval/plan-index";
import { handlePatternRoutes } from "../src/approval/patterns";
import { handleProcessRoutes } from "../src/approval/processes";
import { handleRunSheetRoutes } from "../src/approval/run-sheet";
import { scheduleSessionFromPorts, type GraphPorts } from "../src/gatekeepers/graph";
import { freezeRunSheetScope, runSheetSessionFromPorts, type RunSheetPorts } from "../src/gatekeepers/run-sheet";
import {
  classifyManagerCall,
  groupByRegion,
  managerFieldIsReal,
  mergeOverlay,
  reportingLine,
  selectActiveMembers,
} from "../src/lib/directory-merge";
import { canAddContinuingEducation, canReadContinuingEducation } from "../src/lib/education";
import { indexGroupPlans, rosterOmissionNote } from "../src/lib/plan-index";
import type { UserRecord } from "../src/lib/rbac";
import { assembleRunSheet, plannerChanges, type RunSheetTask } from "../src/lib/run-sheet";
import { horizonDates, shiftInterval, skipConfirmedTimeOff } from "../src/lib/shift-pattern";
import type { ArcadiaActionQueue, ObservationDescription } from "../src/gatekeepers/types";

const staff = (role: UserRecord["role"], active = true): UserRecord => ({
  email: `${role}@s-fx.com`,
  role,
  active,
  grants: [],
});

const env = {} as Env;

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

  it("does not treat manager as real unless the proof returned an id", () => {
    expect(managerFieldIsReal(classifyManagerCall({ called: false }))).toBe(false);
    expect(
      managerFieldIsReal(classifyManagerCall({ called: true, ok: false, status: 403, message: "not supported" }))
    ).toBe(false);
    expect(managerFieldIsReal(classifyManagerCall({ called: true, ok: true, managerId: "  " }))).toBe(false);
    const succeeded = classifyManagerCall({
      called: true,
      ok: true,
      managerId: "mgr-1",
      managerMail: "lead@s-fx.com",
    });
    expect(managerFieldIsReal(succeeded)).toBe(true);
    expect(succeeded.status).toBe("succeeded");
  });

  it("keeps the Arcadia reporting line until that person's proof succeeded", () => {
    const proof = {
      ...classifyManagerCall({ called: true, ok: true, managerId: "mgr-1", managerMail: "lead@s-fx.com" }),
      probedAadId: "ada",
    };
    expect(reportingLine({ leadEmail: "chart@s-fx.com", personAadId: "ada", proof })).toEqual({
      email: "lead@s-fx.com",
      source: "graph",
    });
    expect(reportingLine({ leadEmail: "chart@s-fx.com", personAadId: "grace", proof })).toEqual({
      email: "chart@s-fx.com",
      source: "arcadia",
    });
    expect(
      reportingLine({
        leadEmail: "chart@s-fx.com",
        personAadId: "ada",
        proof: classifyManagerCall({ called: false }),
      }).source
    ).toBe("arcadia");
  });

  it("groups people by city and state and never takes a street", () => {
    const city = mergeOverlay({ city: "Austin", state: "TX" }).city;
    const state = mergeOverlay({ city: "Austin", state: "TX" }).state;
    const empty = mergeOverlay({});
    const groups = groupByRegion([
      { label: "Ada", city, state },
      { label: "Grace", city, state },
      { label: "Lin", city: empty.city, state: empty.state },
    ]);
    expect(groups.map((group) => [group.region, group.count])).toEqual([
      ["Austin, TX", 2],
      ["Region not set", 1],
    ]);
  });
});

describe("shift pattern horizon and time off", () => {
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

describe("plan index filtering", () => {
  it("keeps one row per group-owned plan and counts anything that is not a group container", () => {
    const indexed = indexGroupPlans(
      [
        { id: "g1", displayName: "Client Team", groupTypes: ["Unified"] },
        { id: "g2", displayName: "Mail list", groupTypes: [] },
        { id: "g3", displayName: "Internal", groupTypes: ["Unified"] },
      ],
      new Map([
        [
          "g1",
          [
            { id: "p1", title: "Launch", container: { type: "group" } },
            { id: "p-roster", title: "Roster", container: { type: "roster" } },
          ],
        ],
        ["g2", [{ id: "p-hidden", title: "Should not appear" }]],
        [
          "g3",
          [
            { id: "p1", title: "Launch again" },
            { id: "p2", title: "Ops" },
          ],
        ],
      ])
    );
    expect(indexed.groupsWalked).toBe(2);
    expect(indexed.rosterOmitted).toBe(1);
    expect(indexed.rows.map((row) => row.planId)).toEqual(["p1", "p2"]);
    expect(indexed.rows[0]).toMatchObject({ groupName: "Client Team", title: "Launch" });
    expect(rosterOmissionNote(1)).toContain("not listed");
  });
});

describe("run sheet assembly", () => {
  const task = (over: Partial<RunSheetTask> = {}): RunSheetTask => ({
    id: "t1",
    title: "Fix the login",
    planLabel: "Launch",
    percentComplete: 50,
    dueDateTime: "2026-09-30T00:00:00Z",
    assignees: ["Ada"],
    createdDateTime: "2026-09-01T00:00:00Z",
    completedDateTime: null,
    ...over,
  });

  it("lists an open task on the first sheet and a change on the next", () => {
    const first = plannerChanges([task()], null, "2026-09-28", "2026-10-04");
    expect(first.map((row) => row.change)).toEqual(["due this week"]);
    const open = plannerChanges(
      [task({ dueDateTime: null, createdDateTime: "2026-01-01T00:00:00Z" })],
      null,
      "2026-09-28",
      "2026-10-04"
    );
    expect(open.map((row) => row.change)).toEqual(["open as of this reading"]);
    const next = plannerChanges(
      [task({ percentComplete: 100, completedDateTime: "2026-09-29T12:00:00Z" })],
      [task()],
      "2026-09-28",
      "2026-10-04"
    );
    expect(next[0]?.change).toContain("completed this week");
    expect(next[0]?.change).toContain("changed since the last sheet");
  });

  it("renders facts and leaves out chat text and message bodies", () => {
    const { payload, rendered } = assembleRunSheet({
      clientName: "Acme",
      weekStart: "2026-09-28",
      weekEnd: "2026-10-04",
      generatedAt: "2026-09-28T12:00:00.000Z",
      previousTasks: null,
      planner: [{ planLabel: "Launch", available: true, tasks: [task()] }],
      channels: [
        {
          label: "General",
          available: true,
          messageCount: 2,
          capped: false,
          lastActivity: "2026-09-29T15:00:00Z",
          authors: ["Ada"],
        },
      ],
      folders: [{ label: "Files", available: true, files: [{ name: "scope.docx", modified: "2026-09-29T10:00:00Z" }] }],
      loops: [{ label: "Onboarding", url: "https://loop.cloud.microsoft/acme" }],
    });
    expect(rendered).toContain("Fix the login");
    expect(rendered).toContain("scope.docx");
    expect(rendered).toContain("https://loop.cloud.microsoft/acme");
    expect(rendered).toContain("Message text is not in this sheet");
    expect(rendered).toContain("Chats are not included");
    expect(rendered).not.toMatch(/did well|score|EOS/i);
    expect(JSON.stringify(payload)).not.toContain("body");
    expect(payload).not.toHaveProperty("chats");
  });

  it("freezes bindings at mint and does not grow a chat", () => {
    const scope = freezeRunSheetScope(
      "client-1",
      [
        { type: "planner_plan", external_id: "plan-1", label: "Launch" },
        { type: "channel", external_id: "team/channel", label: "General" },
        { type: "sharepoint_folder", external_id: "drive:/Files", label: "Files" },
        { type: "chat", external_id: "chat-1", label: "nope" },
      ],
      [{ label: "Loop", url: "https://loop.cloud.microsoft/x" }],
      "2026-09-28",
      "2026-10-04"
    );
    expect(scope.plans).toHaveLength(1);
    expect(scope.channels).toEqual([{ teamId: "team", channelId: "channel", label: "General" }]);
    expect(scope.folders[0]?.driveId).toBe("drive");
    expect(scope.loops).toHaveLength(1);
    const gets: string[] = [];
    const ports: RunSheetPorts = {
      queue: {
        authorizeObservation: async () => undefined,
        submitAction: async () => undefined,
        recordDecision: async () => undefined,
        recordApplied: async () => undefined,
        recordFailed: async () => undefined,
      },
      available: () => true,
      get: async <T>(path: string) => {
        gets.push(path);
        if (path.includes("/messages")) {
          return {
            value: [
              {
                createdDateTime: "2026-09-29T15:00:00Z",
                from: { user: { displayName: "Ada" } },
                body: { content: "secret thread" },
              },
            ],
          } as T;
        }
        return { value: [] } as T;
      },
    };
    return runSheetSessionFromPorts(scope, ports)
      .channels()
      .then((facts) => {
        expect(facts[0]?.authors).toEqual(["Ada"]);
        expect(JSON.stringify(facts)).not.toContain("secret thread");
        expect(gets.some((path) => path.includes("$select=createdDateTime,from"))).toBe(true);
        expect(gets.some((path) => path.includes("chat"))).toBe(false);
      });
  });
});

describe("continuing education audience", () => {
  it("lets a superadmin read and add for an active member, and nobody else", () => {
    for (const role of ["specialist", "lead", "founder"] as const) {
      expect(canReadContinuingEducation(staff(role))).toBe(false);
      expect(canAddContinuingEducation(staff(role), { activeMember: true }).ok).toBe(false);
    }
    expect(canReadContinuingEducation(staff("superadmin", false))).toBe(false);
    expect(canAddContinuingEducation(staff("superadmin"), { activeMember: false }).ok).toBe(false);
    expect(canAddContinuingEducation(staff("superadmin"), { activeMember: true }).ok).toBe(true);
  });
});

describe("temporary superadmin gates", () => {
  const get = (path: string, role: UserRecord["role"]) =>
    new Request(`https://arcadia.s-fx.com${path}`);

  it("refuses the new surfaces to a specialist without reading data", async () => {
    const specialist = staff("specialist");
    expect((await handleDirectoryRoutes(get("/agency/directory", "specialist"), env, specialist))?.status).toBe(403);
    expect((await handlePatternRoutes(get("/agency/schedule/patterns", "specialist"), env, specialist))?.status).toBe(403);
    expect((await handlePlanIndexRoutes(get("/agency/objectives/tenant", "specialist"), env, specialist))?.status).toBe(403);
    expect((await handleRunSheetRoutes(get("/clients/abc/run-sheet", "specialist"), env, specialist))?.status).toBe(403);

    const processes = await handleProcessRoutes(get("/agency/processes", "specialist"), env, specialist);
    expect(processes?.status).toBe(200);
    const processBody = await processes!.text();
    expect(processBody).toContain("limited to superadmin");
    expect(processBody).not.toContain("<tbody");

    const education = await handleEducationRoutes(get("/agency/continuing-education", "specialist"), env, specialist);
    expect(education?.status).toBe(200);
    const educationBody = await education!.text();
    expect(educationBody).toContain("limited to superadmin");
    expect(educationBody).not.toContain("<tbody");
  });

  it("refuses a founder the same way", async () => {
    const founder = staff("founder");
    expect((await handleDirectoryRoutes(get("/agency/directory", "founder"), env, founder))?.status).toBe(403);
    expect((await handlePlanIndexRoutes(get("/agency/objectives/tenant", "founder"), env, founder))?.status).toBe(403);
  });

  it("lets a superadmin refresh the plan index through the objectives router", async () => {
    const statement = {
      bind() {
        return statement;
      },
      async run() {
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
    const response = await handleObjectivesRoutes(
      new Request("https://arcadia.s-fx.com/agency/objectives/tenant/refresh", { method: "POST" }),
      { DB: db } as unknown as Env,
      staff("superadmin"),
      { email: "superadmin@s-fx.com" }
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("Graph credentials are not configured");
  });
});

describe("createShift", () => {
  it("posts sharedShift inside 24 hours and refuses a longer one", async () => {
    const posts: unknown[] = [];
    const queue: ArcadiaActionQueue = {
      authorizeObservation: async (_description: ObservationDescription) => undefined,
      submitAction: async () => undefined,
      recordDecision: async () => undefined,
      recordApplied: async () => undefined,
      recordFailed: async () => undefined,
    };
    const ports = {
      queue,
      available: () => true,
      get: async <T>() => ({ value: [] }) as T,
      post: async <T>(_path: string, body: unknown) => {
        posts.push(body);
        return { id: "shift-1" } as T;
      },
      del: async () => undefined,
      patchPlannerTask: async () => undefined,
      userName: async () => undefined,
    } satisfies GraphPorts;
    const session = scheduleSessionFromPorts({ teamId: "team-1" }, ports);
    await expect(
      session.createShift(
        {
          userId: "ada",
          schedulingGroupId: "group-1",
          startDateTime: "2026-09-28T09:00:00.000Z",
          endDateTime: "2026-09-30T09:00:00.000Z",
          displayName: "Day",
        },
        { kind: "human_approval", approvalId: "pattern-1", decidedBy: "shane@s-fx.com" }
      )
    ).rejects.toThrow(/24 hours/);
    const created = await session.createShift(
      {
        userId: "ada",
        schedulingGroupId: "group-1",
        startDateTime: "2026-09-28T09:00:00.000Z",
        endDateTime: "2026-09-28T17:00:00.000Z",
        displayName: "Day",
      },
      { kind: "human_approval", approvalId: "pattern-1", decidedBy: "shane@s-fx.com" }
    );
    expect(created.graphId).toBe("shift-1");
    expect(posts[0]).toMatchObject({
      userId: "ada",
      schedulingGroupId: "group-1",
      sharedShift: { displayName: "Day", startDateTime: "2026-09-28T09:00:00.000Z" },
    });
    expect(posts[0]).not.toHaveProperty("draftShift");
  });
});
