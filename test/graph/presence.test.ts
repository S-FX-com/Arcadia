import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { GraphError, type GraphRequest } from "../../src/graph/client";
import {
  getPresence,
  getPresenceBatch,
  isReachable,
  type Presence,
  type PresenceDeps,
} from "../../src/graph/presence";

// Unit tests (node env): presence.ts is exercised entirely through its
// injectable PresenceDeps seam (mirroring RegistryDeps) rather than a
// stubbed global fetch, since the only thing worth asserting here is
// presence.ts's own request-shaping / chunking / fail-open logic — not the
// shared graph() client, which client.test.ts already covers.

function fakeEnv(): Env {
  return {} as unknown as Env;
}

describe("getPresence", () => {
  it("selects availability,activity from /users/{id}/presence", async () => {
    const calls: GraphRequest[] = [];
    const deps: PresenceDeps = {
      graph: async (_env, req) => {
        calls.push(req);
        return { availability: "Away", activity: "Away" } as never;
      },
    };

    const p = await getPresence(fakeEnv(), "user-1", deps);
    expect(p).toEqual({ availability: "Away", activity: "Away" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/users/user-1/presence");
    expect(calls[0]?.query).toEqual({ $select: "availability,activity" });
  });

  it("fails open to Unknown on 403 (Presence.Read.All not consented)", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(403, "forbidden");
      },
    };
    const p = await getPresence(fakeEnv(), "user-1", deps);
    expect(p).toEqual({ availability: "Unknown", activity: "Unknown" });
  });

  it("fails open to Unknown on 404 (no presence answer for the user)", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(404, "not found");
      },
    };
    const p = await getPresence(fakeEnv(), "user-1", deps);
    expect(p).toEqual({ availability: "Unknown", activity: "Unknown" });
  });

  it("rethrows unexpected errors rather than swallowing them", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(500, "boom");
      },
    };
    await expect(getPresence(fakeEnv(), "user-1", deps)).rejects.toThrow(
      GraphError,
    );
  });
});

describe("getPresenceBatch", () => {
  it("posts /communications/getPresencesByUserId with deduped ids and maps the response by id", async () => {
    const calls: GraphRequest[] = [];
    const deps: PresenceDeps = {
      graph: async (_env, req) => {
        calls.push(req);
        return {
          value: [
            { id: "u1", availability: "Busy", activity: "InACall" },
            { id: "u2", availability: "Available", activity: "Available" },
          ],
        } as never;
      },
    };

    const result = await getPresenceBatch(
      fakeEnv(),
      ["u1", "u2", "u1"],
      deps,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/communications/getPresencesByUserId");
    expect(calls[0]?.body).toEqual({ ids: ["u1", "u2"] });

    expect(result.get("u1")).toEqual({
      availability: "Busy",
      activity: "InACall",
    });
    expect(result.get("u2")).toEqual({
      availability: "Available",
      activity: "Available",
    });
    expect(result.size).toBe(2);
  });

  it("returns an empty map without calling Graph for an empty id list", async () => {
    let called = false;
    const deps: PresenceDeps = {
      graph: async () => {
        called = true;
        return { value: [] } as never;
      },
    };
    const result = await getPresenceBatch(fakeEnv(), [], deps);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it("chunks requests at 650 ids per call", async () => {
    const chunkSizes: number[] = [];
    const deps: PresenceDeps = {
      graph: async (_env, req) => {
        const body = req.body as { ids: string[] };
        chunkSizes.push(body.ids.length);
        return { value: [] } as never;
      },
    };

    const ids = Array.from({ length: 1301 }, (_, i) => `u${i}`);
    await getPresenceBatch(fakeEnv(), ids, deps);

    expect(chunkSizes).toEqual([650, 650, 1]);
  });

  it("fails open to an empty map on 403 (Presence.Read.All not consented)", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(403, "forbidden");
      },
    };
    const result = await getPresenceBatch(fakeEnv(), ["u1", "u2"], deps);
    expect(result.size).toBe(0);
  });

  it("fails open to an empty map on 404", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(404, "not found");
      },
    };
    const result = await getPresenceBatch(fakeEnv(), ["u1"], deps);
    expect(result.size).toBe(0);
  });

  it("rethrows unexpected errors", async () => {
    const deps: PresenceDeps = {
      graph: async () => {
        throw new GraphError(500, "boom");
      },
    };
    await expect(
      getPresenceBatch(fakeEnv(), ["u1"], deps),
    ).rejects.toThrow(GraphError);
  });
});

describe("isReachable truth table", () => {
  it("is reachable when presence is undefined (unknown fails open)", () => {
    expect(isReachable(undefined)).toBe(true);
  });

  const reachableAvailability = ["Available", "AvailableIdle", "Away", "BeRightBack", "Offline", "Unknown"];
  for (const availability of reachableAvailability) {
    it(`is reachable for availability=${availability} (activity=Available)`, () => {
      const p: Presence = { availability, activity: "Available" };
      expect(isReachable(p)).toBe(true);
    });
  }

  const unreachableAvailability = ["Busy", "DoNotDisturb", "InAMeeting", "Presenting"];
  for (const availability of unreachableAvailability) {
    it(`is unreachable for availability=${availability}`, () => {
      const p: Presence = { availability, activity: "Available" };
      expect(isReachable(p)).toBe(false);
    });
  }

  const unreachableActivity = ["InAConferenceCall", "Presenting", "InACall", "InAMeeting"];
  for (const activity of unreachableActivity) {
    it(`is unreachable for activity=${activity} even when availability is Available`, () => {
      const p: Presence = { availability: "Available", activity };
      expect(isReachable(p)).toBe(false);
    });
  }

  it("is reachable for a fully benign presence", () => {
    const p: Presence = { availability: "Available", activity: "Available" };
    expect(isReachable(p)).toBe(true);
  });
});
