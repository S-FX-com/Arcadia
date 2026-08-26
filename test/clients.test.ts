// v5.0 spine policy tests (§8). The point of these is the refusals: a
// client-scoped session must be impossible to point at a team that was not
// frozen in at mint, and workspace access must fail CLOSED — no capability,
// no verified membership, no read.

import { describe, expect, it } from "vitest";
import { BINDING_TYPES, isBindingType, validateBindingInput } from "../src/clients/bindings";
import {
  MEMBERSHIP_STALENESS_MINUTES,
  membershipFresh,
  membershipGate,
  parseDbTime,
} from "../src/clients/members";
import {
  clientGraphSessionFromPorts,
  type ClientGraphScope,
  type GraphPorts,
} from "../src/gatekeepers/graph";
import {
  GatekeeperDeniedError,
  type ArcadiaActionQueue,
  type ObservationDescription,
} from "../src/gatekeepers/types";

// ---------------------------------------------------------------------------
// Binding policy (§8): typed, shape-checked, admin-bound.
// ---------------------------------------------------------------------------

describe("binding policy", () => {
  it("accepts exactly the seven documented types", () => {
    expect(BINDING_TYPES).toEqual([
      "team",
      "channel",
      "planner_plan",
      "sharepoint_folder",
      "enque_org",
      "repo",
      "staging_url",
    ]);
    expect(isBindingType("team")).toBe(true);
    expect(isBindingType("viva_updates")).toBe(false); // not a binding type (§4.2)
    expect(isBindingType("chat")).toBe(false); // 1:1 chats have no group ACL (§8)
  });

  it("refuses an empty external id on every type", () => {
    for (const type of BINDING_TYPES) {
      expect(validateBindingInput(type, "  "), type).toBeDefined();
    }
  });

  it("checks the composite id shapes", () => {
    expect(validateBindingInput("channel", "team-guid/19:abc@thread.tacv2")).toBeUndefined();
    expect(validateBindingInput("channel", "just-a-channel-id")).toContain("teamId/channelId");
    expect(validateBindingInput("sharepoint_folder", "b!drive:/Shared/ClientX")).toBeUndefined();
    expect(validateBindingInput("sharepoint_folder", "no-separator")).toContain("driveId:/");
    expect(validateBindingInput("repo", "s-fx-com/arcadia")).toBeUndefined();
    expect(validateBindingInput("repo", "arcadia")).toContain("owner/name");
    expect(validateBindingInput("staging_url", "https://staging.s-fx.com")).toBeUndefined();
    expect(validateBindingInput("staging_url", "http://staging.s-fx.com")).toContain("https");
    expect(validateBindingInput("team", "guid-without-slashes")).toBeUndefined();
    expect(validateBindingInput("team", "team/extra")).toContain("bare");
  });
});

// ---------------------------------------------------------------------------
// Membership (§8): capability × membership, 15-minute ceiling, fail closed.
// ---------------------------------------------------------------------------

describe("membership staleness", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");

  it("treats a missing or unparseable sync time as stale", () => {
    expect(membershipFresh(null, now)).toBe(false);
    expect(membershipFresh("not a time", now)).toBe(false);
  });

  it("holds the ceiling at exactly fifteen minutes", () => {
    expect(MEMBERSHIP_STALENESS_MINUTES).toBe(15);
    expect(membershipFresh("2026-08-25T11:46:00Z", now)).toBe(true); // 14m
    expect(membershipFresh("2026-08-25T11:45:00Z", now)).toBe(true); // 15m — at the ceiling
    expect(membershipFresh("2026-08-25T11:44:59Z", now)).toBe(false); // past it
  });

  it("reads D1's zone-less datetime('now') format as UTC", () => {
    expect(parseDbTime("2026-08-25 11:50:00")).toBe(Date.parse("2026-08-25T11:50:00Z"));
    expect(membershipFresh("2026-08-25 11:50:00", now)).toBe(true);
  });
});

describe("membership gate — both legs must pass, and unverifiable denies", () => {
  const base = { hasCapability: true, isMember: true, fresh: true, refreshSucceeded: false };

  it("grants a member with the capability and a fresh cache", () => {
    expect(membershipGate(base)).toBe(true);
  });

  it("refuses without the capability, membership notwithstanding", () => {
    expect(membershipGate({ ...base, hasCapability: false })).toBe(false);
  });

  it("refuses a non-member, capability notwithstanding", () => {
    expect(membershipGate({ ...base, isMember: false })).toBe(false);
  });

  it("fails closed past the ceiling when the refresh could not run", () => {
    // The cached row still says "member" — but membership that cannot be
    // verified inside the window does not grant (§8).
    expect(membershipGate({ ...base, fresh: false, refreshSucceeded: false })).toBe(false);
  });

  it("grants again once a refresh brings the cache inside the ceiling", () => {
    expect(membershipGate({ ...base, fresh: false, refreshSucceeded: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client-scoped Graph session: frozen at mint, metadata-only observation.
// ---------------------------------------------------------------------------

class RecordingQueue implements ArcadiaActionQueue {
  observations: ObservationDescription[] = [];
  async authorizeObservation(d: ObservationDescription): Promise<void> {
    this.observations.push(d);
  }
  async submitAction(): Promise<void> {
    throw new Error("client sessions submit no actions");
  }
  async recordDecision(): Promise<void> {}
  async recordApplied(): Promise<void> {}
  async recordFailed(): Promise<void> {}
}

function ports(over: Partial<GraphPorts> = {}): { ports: GraphPorts; queue: RecordingQueue; gets: string[] } {
  const queue = new RecordingQueue();
  const gets: string[] = [];
  return {
    queue,
    gets,
    ports: {
      queue,
      available: () => true,
      async get<T>(path: string): Promise<T> {
        gets.push(path);
        return { value: [] } as T;
      },
      post: async () => {
        throw new Error("client sessions have no generic Graph write");
      },
      patchPlannerTask: async () => {
        throw new Error("client sessions have no Planner write");
      },
      userName: async () => undefined,
      ...over,
    },
  };
}

describe("client-scoped graph session", () => {
  it("refuses every read until Graph credentials exist", async () => {
    const { ports: p } = ports({ available: () => false });
    const session = clientGraphSessionFromPorts({ clientId: "c1", teamIds: ["t1"] }, p);
    expect(session.available()).toBe(false);
    await expect(session.teamMembers()).rejects.toThrow(GatekeeperDeniedError);
  });

  it("iterates the frozen set — a team added to the scope after mint is not read", async () => {
    const { ports: p, gets } = ports();
    const scope = { clientId: "c1", teamIds: ["t1"] } as ClientGraphScope;
    const session = clientGraphSessionFromPorts(scope, p);
    // Simulate a binding added mid-session (the ./types.ts scope rule).
    (scope as unknown as { teamIds: string[] }).teamIds = ["t1", "t2-added-later"];
    await session.teamMembers();
    expect(gets).toHaveLength(1);
    expect(gets[0]).toContain("/groups/t1/members");
    expect(gets[0]).not.toContain("t2-added-later");
  });

  it("keeps directory users, drops nested groups and devices, lowercases addresses", async () => {
    const { ports: p, queue } = ports({
      async get<T>(): Promise<T> {
        return {
          value: [
            { "@odata.type": "#microsoft.graph.user", id: "u1", displayName: "Vicky", mail: "Vicky@S-FX.com" },
            { "@odata.type": "#microsoft.graph.user", id: "u2", userPrincipalName: "NoMail@s-fx.com" },
            { "@odata.type": "#microsoft.graph.group", id: "g1", displayName: "Nested group" },
            { "@odata.type": "#microsoft.graph.user", displayName: "no id, skipped" },
          ],
        } as T;
      },
    });
    const session = clientGraphSessionFromPorts({ clientId: "c1", teamIds: ["t1"] }, p);
    const members = await session.teamMembers();
    expect(members).toEqual([
      { aadId: "u1", sourceTeamId: "t1", displayName: "Vicky", email: "vicky@s-fx.com" },
      { aadId: "u2", sourceTeamId: "t1", email: "nomail@s-fx.com" },
    ]);
    // One observation for the whole read, metadata class: names and
    // addresses, never messages or files.
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]?.description).toContain("no messages, no files");
    expect(queue.observations[0]?.description).toContain("1 non-user object(s) ignored");
  });

  it("reads membership across every team frozen in at mint", async () => {
    const { ports: p, gets } = ports();
    const session = clientGraphSessionFromPorts({ clientId: "c1", teamIds: ["t1", "t2"] }, p);
    await session.teamMembers();
    expect(gets.some((g) => g.includes("/groups/t1/members"))).toBe(true);
    expect(gets.some((g) => g.includes("/groups/t2/members"))).toBe(true);
  });
});
