// /clients policy: typed, shape-checked bindings; manage_clients only, with
// a 404 for everyone else; the channel check fails closed.

import { describe, expect, it } from "vitest";
import { handleClientRoutes } from "../src/approval/clients";
import { addBinding, BINDING_TYPES, isBindingType, validateBindingInput } from "../src/clients/bindings";
import type { UserRecord } from "../src/lib/rbac";

const staff = (role: UserRecord["role"], grants: UserRecord["grants"] = []): UserRecord => ({
  email: `${role}@s-fx.com`,
  role,
  active: true,
  grants,
});

/** A D1 stand-in: every query returns the given row / rows, and writes are recorded. */
function fakeDb(row: unknown = null, rows: unknown[] = []) {
  const writes: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: async () => row,
        all: async () => ({ results: rows }),
        run: async () => {
          writes.push(sql);
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, writes };
}

const get = (path: string) => new Request(`https://arcadia.s-fx.com${path}`);

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
    expect(isBindingType("viva_updates")).toBe(false);
    expect(isBindingType("chat")).toBe(false); // 1:1 chats have no group ACL
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

describe("/clients audience", () => {
  it("answers 404, not 403, to everyone without manage_clients, without reading data", async () => {
    const env = {} as Env; // no DB: a read would throw
    for (const role of ["specialist", "lead"] as const) {
      for (const path of ["/clients", "/clients/abc", "/clients/abc/extra"]) {
        expect((await handleClientRoutes(get(path), env, staff(role)))?.status, `${role} ${path}`).toBe(404);
      }
      const sync = new Request("https://arcadia.s-fx.com/clients/sync", { method: "POST" });
      expect((await handleClientRoutes(sync, env, staff(role)))?.status).toBe(404);
    }
  });

  it("lets a manage_clients holder list clients, and a grant counts as much as a role", async () => {
    const { db } = fakeDb(null, []);
    const env = { DB: db } as Env;
    expect((await handleClientRoutes(get("/clients"), env, staff("superadmin")))?.status).toBe(200);
    expect((await handleClientRoutes(get("/clients"), env, staff("lead", ["manage_clients"])))?.status).toBe(200);
  });

  it("404s an unknown sub-path even for a manage_clients holder", async () => {
    const env = { DB: fakeDb().db } as Env;
    expect((await handleClientRoutes(get("/clients/abc/extra"), env, staff("superadmin")))?.status).toBe(404);
  });

  it("leaves paths outside /clients to other routers", async () => {
    expect(await handleClientRoutes(get("/clientsx"), {} as Env, staff("superadmin"))).toBeUndefined();
  });
});

describe("channel binding", () => {
  const client = { id: "c1", name: "Client", status: "active", owner: null, created_by: "x", created_at: "now" };

  it("refuses to bind a channel when Graph cannot verify it (fail closed)", async () => {
    const { db, writes } = fakeDb(client);
    const result = await addBinding({ DB: db } as Env, staff("superadmin"), {
      clientId: "c1",
      type: "channel",
      externalId: "team-1/channel-1",
      label: "",
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
