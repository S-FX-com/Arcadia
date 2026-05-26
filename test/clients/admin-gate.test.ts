import { describe, expect, it } from "vitest";
import { handleAdminClients } from "../../src/webapp/admin-clients-api";
import type { Env } from "../../src/env";
import type { Session } from "../../src/webapp/auth";

function fakeEnv(): Env {
  return {} as Env;
}

function nonAdminSession(): Session {
  return {
    aadId: "user-1",
    tenantId: "tenant-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("handleAdminClients gate", () => {
  it("returns 403 for non-admin sessions before touching the DB", async () => {
    const res = await handleAdminClients(
      new Request("https://x/api/webapp/admin/clients"),
      fakeEnv(),
      nonAdminSession(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("returns 403 for non-admin sessions on nested asset paths too", async () => {
    const res = await handleAdminClients(
      new Request("https://x/api/webapp/admin/clients/c1/assets", {
        method: "POST",
        body: "{}",
      }),
      fakeEnv(),
      nonAdminSession(),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-admin sessions on grants paths too", async () => {
    const res = await handleAdminClients(
      new Request("https://x/api/webapp/admin/clients/c1/grants", {
        method: "POST",
        body: "{}",
      }),
      fakeEnv(),
      nonAdminSession(),
    );
    expect(res.status).toBe(403);
  });
});
