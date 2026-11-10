// Post-sign-in routing (src/routes.ts): what a signed-in, active staff member
// can reach. v5 routes stay gone for every role, the kept pages answer at
// their /agency/ paths, and the v5 Education URL (plus the /approval/* source-file
// paths) redirect there.

import { describe, expect, it } from "vitest";
import type { Identity, Role, UserRecord } from "../src/lib/rbac";
import { dispatch, HOME_PATH, movedLocation } from "../src/routes";

const ORIGIN = "https://arcadia.s-fx.com";

const staff = (role: Role, grants: UserRecord["grants"] = []): UserRecord => ({
  email: `${role}@s-fx.com`,
  role,
  active: true,
  grants,
});

const SUPERADMIN = staff("superadmin");
const SPECIALIST = staff("specialist");

/**
 * A D1 stand-in with nothing in it: every read is empty and every write
 * succeeds. Enough for a page to render its empty state. No Graph
 * credentials are set, so nothing reaches Microsoft 365 or the agent.
 */
function emptyEnv(): Env {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
    raw: async () => [],
    run: async () => ({ success: true, meta: {} }),
  };
  const db = {
    prepare: () => statement,
    batch: async (list: unknown[]) => list.map(() => ({ success: true, results: [] })),
  };
  const kv = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return { DB: db, CONTROL: kv } as unknown as Env;
}

function call(path: string, user: UserRecord, method = "GET"): Promise<Response> {
  const identity: Identity = { email: user.email };
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { Accept: "text/html", ...(method === "POST" ? { Origin: ORIGIN } : {}) },
    ...(method === "POST" ? { body: new URLSearchParams({ clientId: "abc" }) } : {}),
  });
  return dispatch(request, emptyEnv(), user, identity);
}

/** Every v5 route that Phase 1 deleted (decision 4), with the method it answered to. */
const DELETED: Array<[method: "GET" | "POST", path: string]> = [
  // Old Ask Arcadia
  ["GET", "/chat"],
  ["GET", "/chat/gaps"],
  ["GET", "/chat/live.js"],
  ["POST", "/chat/send"],
  // Operations, approvals, doctrine, instruments, site plans
  ["GET", "/approval"],
  ["GET", "/approval/ops"],
  ["POST", "/approval/decide"],
  ["GET", "/approval/doctrine"],
  ["POST", "/approval/doctrine/seed"],
  ["GET", "/approval/board"],
  ["GET", "/approval/board/x"],
  ["GET", "/approval/ledger"],
  ["GET", "/approval/ledger/checklists"],
  ["GET", "/approval/siteplan"],
  ["GET", "/approval/siteplan/x"],
  ["GET", "/approval/gatekeepers"],
  // Agency pages that are gone, and the placeholder router
  ["GET", "/agency"],
  ["GET", "/agency/leadership"],
  ["GET", "/agency/org-chart"],
  ["GET", "/agency/objectives"],
  ["GET", "/agency/objectives/tenant"],
  ["GET", "/agency/plan-index"],
  ["GET", "/agency/processes"],
  ["GET", "/agency/run-sheet"],
  ["GET", "/agency/nothing-here"],
  // Look-alike and unknown sub-paths of the kept pages
  ["GET", "/agency/directoryX"],
  ["GET", "/agency/directory/nothing-here"],
  ["GET", "/agency/schedule/patternsX"],
  ["GET", "/agency/schedule/patterns/nothing-here"],
  ["GET", "/agency/educationX"],
  // Schedule availability (beta)
  ["POST", "/agency/schedule/sync-availability-all"],
  ["GET", "/agency/schedule/availability"],
  // Client run-sheet and Teams-membership sync
  ["GET", "/clients/abc/run-sheet"],
  ["POST", "/clients/sync"],
  // Agent bootstrap and SDK routing
  ["POST", "/init"],
  ["GET", "/agents/arcadia/main"],
  ["GET", "/agents/memory-profile/sfx-doctrine-canonical"],
];

describe("deleted v5 routes", () => {
  for (const user of [SUPERADMIN, SPECIALIST]) {
    it(`answer 404 to a ${user.role}`, async () => {
      for (const [method, path] of DELETED) {
        expect((await call(path, user, method)).status, `${user.role} ${method} ${path}`).toBe(404);
      }
    });
  }
});

describe("redirects", () => {
  it("lands / on the Directory with a 302", async () => {
    for (const user of [SUPERADMIN, SPECIALIST]) {
      const res = await call("/", user);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(HOME_PATH);
      expect(HOME_PATH).toBe("/agency/directory");
    }
  });

  it("does not answer a POST to / (the old chat send)", async () => {
    expect((await call("/", SPECIALIST, "POST")).status).toBe(404);
  });

  it("redirects the moved paths with a 301, keeping the tail and the query", async () => {
    const cases: Array<[from: string, to: string]> = [
      ["/agency/continuing-education", "/agency/education"],
      ["/agency/continuing-education?x=1", "/agency/education?x=1"],
    ];
    for (const user of [SUPERADMIN, SPECIALIST]) {
      for (const [from, to] of cases) {
        const res = await call(from, user);
        expect(res.status, from).toBe(301);
        expect(res.headers.get("Location"), from).toBe(to);
      }
    }
  });

  it("moves only GETs and whole path segments", () => {
    const at = (path: string) => new URL(`${ORIGIN}${path}`);
    expect(movedLocation(at("/agency/continuing-education"), "POST")).toBeNull();
    expect(movedLocation(at("/agency/continuing-educationx"), "GET")).toBeNull();
    expect(movedLocation(at("/approval/directory"), "GET")).toBeNull();
    expect(movedLocation(at("/agency/continuing-education"), "HEAD")).toBe("/agency/education");
  });

  it("answers a POST to a moved path with 404, not a redirect that would drop the form", async () => {
    expect((await call("/agency/continuing-education", SUPERADMIN, "POST")).status).toBe(404);
  });
});

describe("the kept pages", () => {
  for (const role of ["specialist", "lead", "founder", "superadmin"] as const) {
    it(`open Directory, Schedule and Continuing Education to a ${role}`, async () => {
      for (const path of ["/agency/directory", "/agency/schedule", "/agency/education"]) {
        const res = await call(path, staff(role));
        expect(res.status, `${role} ${path}`).toBe(200);
        expect(res.headers.get("Content-Type"), path).toContain("text/html");
      }
    });
  }

  it("hides /clients from everyone without manage_clients", async () => {
    for (const role of ["specialist", "lead"] as const) {
      for (const path of ["/clients", "/clients/abc"]) {
        expect((await call(path, staff(role))).status, `${role} ${path}`).toBe(404);
      }
    }
  });

  it("serves /clients to a manage_clients holder", async () => {
    expect((await call("/clients", SUPERADMIN)).status).toBe(200);
    expect((await call("/clients", staff("lead", ["manage_clients"]))).status).toBe(200);
  });

  it("keeps admin model routing at /approval/admin, server-checked", async () => {
    expect((await call("/approval/admin", SUPERADMIN)).status).toBe(200);
    expect((await call("/approval/admin", SPECIALIST)).status).toBe(403);
  });
});
