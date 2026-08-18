// Gatekeeper policy tests (Cloudflare OS integration). The point of these is
// the refusals: a session must be impossible to point at another resource,
// and a live side effect must be impossible without recorded authorization.

import { describe, expect, it } from "vitest";
import {
  GatekeeperDeniedError,
  boundAgentCatalog,
  type ActionAuthorization,
  type ActionDescription,
  type ArcadiaActionQueue,
  type ObservationDescription,
} from "../src/gatekeepers/types";
import { crawlSessionFromPorts, isSafeCrawlTarget } from "../src/gatekeepers/site-crawl";
import { graphSessionFromPorts, type GraphPorts } from "../src/gatekeepers/graph";
import { projectContextFromPorts } from "../src/gatekeepers/project-context";
import {
  BRAND_VOICE_DOC_ID,
  doctrineCatalog,
  readDoctrineEntry,
  searchDoctrine,
  type DoctrineProfile,
} from "../src/os-bridge/doctrine-skill";
import type { Memory, RecallResult } from "../src/memory/driver";

/**
 * In-memory queue with the same enforcement rule as D1GatekeeperQueue:
 * recordDecision throws unless evidence is present or the action was
 * submitted autoApprovable.
 */
class RecordingQueue implements ArcadiaActionQueue {
  observations: ObservationDescription[] = [];
  submitted = new Map<string, ActionDescription>();
  decided = new Map<string, ActionAuthorization | undefined>();
  applied = new Map<string, string>();
  failed = new Map<string, string>();

  async authorizeObservation(d: ObservationDescription): Promise<void> {
    this.observations.push(d);
  }
  async submitAction(key: string, d: ActionDescription): Promise<void> {
    if (!this.submitted.has(key)) this.submitted.set(key, d);
  }
  async recordDecision(key: string, auth?: ActionAuthorization): Promise<void> {
    const d = this.submitted.get(key);
    if (!d) throw new GatekeeperDeniedError(`action ${key} was never submitted`, "test");
    if (!auth && !d.autoApprovable) {
      throw new GatekeeperDeniedError(`action ${key} requires authorization`, "test");
    }
    this.decided.set(key, auth);
  }
  async recordApplied(key: string, result: string): Promise<void> {
    this.applied.set(key, result);
  }
  async recordFailed(key: string, error: string): Promise<void> {
    this.failed.set(key, error);
  }
}

describe("site crawl session", () => {
  const ports = () => {
    const queue = new RecordingQueue();
    return {
      queue,
      fetchPage: async () => ({ status: 200, html: "<title>ok</title>" }),
    };
  };

  it("refuses a private or non-http root at mint", () => {
    expect(() => crawlSessionFromPorts("http://10.0.0.5/", ports())).toThrow(GatekeeperDeniedError);
    expect(() => crawlSessionFromPorts("ftp://example.com/", ports())).toThrow(GatekeeperDeniedError);
  });

  it("refuses to leave the root origin", async () => {
    const session = crawlSessionFromPorts("https://client.example.com/", ports());
    await expect(session.fetchPage("https://other.example.com/page")).rejects.toThrow(/scoped to/);
  });

  it("fetches in-scope pages and logs each as an observation", async () => {
    const p = ports();
    const session = crawlSessionFromPorts("https://client.example.com/", p);
    const res = await session.fetchPage("https://client.example.com/about");
    expect(res.status).toBe(200);
    expect(p.queue.observations).toHaveLength(1);
    expect(p.queue.observations[0]?.title).toContain("/about");
  });

  it("blocks loopback, private ranges, and link-local addresses", () => {
    for (const bad of [
      "http://localhost/x",
      "http://127.0.0.1/",
      "http://192.168.1.10/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://internal.svc.local/",
    ]) {
      expect(isSafeCrawlTarget(bad)).toBe(false);
    }
    expect(isSafeCrawlTarget("https://www.s-fx.com/")).toBe(true);
  });
});

describe("Graph session", () => {
  function graphPorts(over: Partial<GraphPorts> = {}): GraphPorts & { queue: RecordingQueue } {
    const queue = new RecordingQueue();
    return {
      queue,
      available: () => true,
      get: async <T>(_path: string): Promise<T> => ({ value: [] }) as T,
      patchPlannerTask: async () => {},
      userName: async () => undefined,
      ...over,
    } as GraphPorts & { queue: RecordingQueue };
  }

  it("cannot be pointed at anything outside its minted scope", async () => {
    const session = graphSessionFromPorts({ projectId: "alpha" }, graphPorts());
    await expect(session.plannerTasks()).rejects.toThrow(/no Planner plan in scope/);
    await expect(session.folderChildren()).rejects.toThrow(/no SharePoint folder in scope/);
    await expect(session.channelMessages()).rejects.toThrow(/no Teams channel in scope/);
  });

  it("reports unavailable credentials as unavailable, never as data", async () => {
    const session = graphSessionFromPorts(
      { projectId: "alpha", plannerPlanId: "plan1" },
      graphPorts({ available: () => false })
    );
    expect(session.available()).toBe(false);
    await expect(session.plannerTasks()).rejects.toThrow(/§9.7/);
  });

  it("logs an observation per read, metadata only", async () => {
    const ports = graphPorts();
    const session = graphSessionFromPorts(
      { projectId: "alpha", plannerPlanId: "plan1", teamsTeamId: "t", teamsChannelId: "c" },
      ports
    );
    await session.plannerTasks();
    await session.channelMessages();
    expect(ports.queue.observations).toHaveLength(2);
    expect(ports.queue.observations[1]?.description).toContain("no bodies read");
  });

  it("reads a board in one observation, following Planner's paging", async () => {
    const pageOne = {
      value: [
        { id: "t1", title: "Ship it", bucketId: "b1", percentComplete: 50, assignments: { "aad-1": {} } },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/planner/plans/plan1/tasks?$skiptoken=x",
    };
    const pageTwo = { value: [{ id: "t2", title: "Test it", assignments: {} }] };
    const ports = graphPorts({
      get: async <T>(path: string): Promise<T> => {
        if (path.includes("/buckets")) return { value: [{ id: "b1", name: "Doing" }] } as T;
        if (path.includes("$skiptoken")) return pageTwo as T;
        return pageOne as T;
      },
    });
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);
    const board = await session.plannerBoard();
    expect(board.buckets).toEqual([{ id: "b1", name: "Doing" }]);
    expect(board.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(board.tasks[0]?.assigneeIds).toEqual(["aad-1"]);
    // One read, one observation — a page view is not twelve audit rows.
    expect(ports.queue.observations).toHaveLength(1);
    expect(ports.queue.observations[0]?.description).toContain("no descriptions or comments");
  });

  it("resolves names only for assignees read off its own plan", async () => {
    const ports = graphPorts({
      get: async <T>(path: string): Promise<T> =>
        (path.includes("/buckets")
          ? { value: [] }
          : { value: [{ id: "t1", title: "T", assignments: { "aad-1": {} } }] }) as T,
      userName: async (id) => (id === "aad-1" ? "Abel Lima Cruz" : "Someone Else"),
    });
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);

    // Before any board read the session has seen nobody — refuse everything.
    await expect(session.assigneeNames(["aad-1"])).rejects.toThrow(/its own plan/);

    await session.plannerBoard();
    await expect(session.assigneeNames(["aad-1"])).resolves.toEqual({ "aad-1": "Abel Lima Cruz" });
    // A plan-scoped session is not a directory browser.
    await expect(session.assigneeNames(["aad-1", "someone-random"])).rejects.toThrow(/its own plan/);
  });

  it("renders a board even when a directory lookup fails — names are decoration", async () => {
    const ports = graphPorts({
      get: async <T>(path: string): Promise<T> =>
        (path.includes("/buckets")
          ? { value: [] }
          : { value: [{ id: "t1", title: "T", assignments: { "aad-1": {}, "aad-2": {} } }] }) as T,
      userName: async (id) => {
        if (id === "aad-2") throw new Error("directory hiccup");
        return "Abel Lima Cruz";
      },
    });
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);
    await session.plannerBoard();
    await expect(session.assigneeNames(["aad-1", "aad-2"])).resolves.toEqual({ "aad-1": "Abel Lima Cruz" });
  });

  it("refuses a Planner write without a dispatch rule or human approval", async () => {
    const ports = graphPorts();
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);
    // Cast: every kind in the union is currently accepted here, so the guard
    // can only be exercised by standing in for a kind added later. The check
    // is what keeps a new authorization kind from silently gaining Planner
    // writes it was never meant to have.
    const unsupported = { kind: "some_future_kind" } as unknown as ActionAuthorization;
    await expect(
      session.patchPlannerTask("task1", "etag", { percentComplete: 100 }, unsupported)
    ).rejects.toThrow(/cannot write task state/);
    expect(ports.queue.failed.size).toBe(1);
  });

  it("applies a Planner write under a dispatch rule attributed to a human", async () => {
    const ports = graphPorts();
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);
    await session.patchPlannerTask(
      "task1",
      "etag",
      { percentComplete: 100 },
      { kind: "dispatch_rule", rule: "stage_advance", onBehalfOf: "allie@s-fx.com" }
    );
    expect(ports.queue.applied.has("graph.patch_planner_task:task1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project context + doctrine skill
// ---------------------------------------------------------------------------

const memory = (over: Partial<Memory> = {}): Memory => ({
  id: "mem1",
  profile: "sfx-doctrine-canonical",
  content: "Rate locks yes, discounts no.",
  kind: "fact",
  topicKey: "discount-policy",
  provenance: { capturedFrom: "seed", capturedAt: "2026-08-01T00:00:00Z", ratifiedBy: "shane@s-fx.com" },
  createdAt: "2026-08-01T00:00:00Z",
  ...over,
});

describe("project context session", () => {
  it("recalls, lists, and remembers against exactly one profile, all logged", async () => {
    const queue = new RecordingQueue();
    const recall: RecallResult = { memories: [{ ...memory(), score: 0.9 }], belowConfidenceFloor: false };
    const session = projectContextFromPorts("sfx-project-acme", {
      queue,
      profile: {
        recall: async () => recall,
        list: async () => [memory()],
        remember: async ({ content }) => memory({ content, profile: "sfx-project-acme" }),
      },
    });
    await session.recall("contract price");
    await session.list();
    const written = await session.rememberFact("Contract price is $4,200/mo.", "teams");
    expect(written.profile).toBe("sfx-project-acme");
    expect(queue.observations).toHaveLength(2);
    expect(queue.applied.size).toBe(1);
    // The fact write is an auto-commit (§5.2) — decided without human evidence.
    expect([...queue.decided.values()]).toEqual([undefined]);
  });
});

describe("doctrine skill (os-bridge)", () => {
  const profile: DoctrineProfile = {
    recall: async () => ({ memories: [{ ...memory(), score: 0.82 }], belowConfidenceFloor: false }),
    list: async () => [memory(), memory({ id: "mem2", topicKey: "payment-terms", content: "Deferred payment is a convenience, not a savings offer." })],
  };

  it("catalogs brand voice first, then canonical entries, bounded", async () => {
    const { catalog, observation } = await doctrineCatalog(profile, { limit: 10 });
    expect(catalog.entries[0]?.id).toBe(BRAND_VOICE_DOC_ID);
    expect(catalog.entries).toHaveLength(3);
    expect(observation.title).toContain("catalog");
  });

  it("search returns scored hits with an observation", async () => {
    const { hits, observation } = await searchDoctrine(profile, "can I discount?");
    expect(hits[0]?.docId).toBe("mem1");
    expect(hits[0]?.score).toBeCloseTo(0.82);
    expect(observation.title).toContain("Searched doctrine");
  });

  it("reads the brand doc and canonical entries by id; unknown ids read as null", async () => {
    expect((await readDoctrineEntry(profile, BRAND_VOICE_DOC_ID)).doc?.kind).toBe("brand");
    expect((await readDoctrineEntry(profile, "mem2")).doc?.content).toContain("Deferred payment");
    expect((await readDoctrineEntry(profile, "nope")).doc).toBeNull();
  });
});

describe("boundAgentCatalog", () => {
  it("clamps to the request limit and the hard cap, marking truncation", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      title: "t".repeat(300),
      description: "d".repeat(900),
    }));
    const catalog = boundAgentCatalog(entries, { limit: 100 });
    expect(catalog.entries).toHaveLength(25);
    expect(catalog.truncated).toBe(true);
    expect(catalog.entries[0]?.title.length).toBeLessThanOrEqual(100);
    expect(catalog.entries[0]?.description.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// D1GatekeeperQueue — the production enforcement backstop. A tiny fake D1
// that understands only the statements the queue issues against gk_actions.
// ---------------------------------------------------------------------------

interface FakeActionRow {
  id: string;
  status: string;
  auto_approvable: number;
  auth_evidence: string | null;
  decided_by: string | null;
  result: string | null;
}

function fakeDb() {
  const actions = new Map<string, FakeActionRow>();
  const observations: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT INTO gk_observations")) {
                observations.push(String(args[4]));
              } else if (sql.includes("INSERT OR IGNORE INTO gk_actions")) {
                const id = String(args[0]);
                if (!actions.has(id)) {
                  actions.set(id, {
                    id,
                    status: "pending",
                    auto_approvable: Number(args[8]),
                    auth_evidence: null,
                    decided_by: null,
                    result: null,
                  });
                }
              } else if (sql.includes("SET status = 'approved'")) {
                const row = actions.get(String(args[0]));
                if (row && row.status === "pending") {
                  row.status = "approved";
                  row.auth_evidence = String(args[1]);
                  row.decided_by = args[2] === null ? null : String(args[2]);
                }
              } else if (sql.includes("SET status = 'applied'")) {
                const row = actions.get(String(args[0]));
                if (row && row.status === "approved") {
                  row.status = "applied";
                  row.result = String(args[1]);
                }
              } else if (sql.includes("SET status = 'failed'")) {
                const row = actions.get(String(args[0]));
                if (row && (row.status === "pending" || row.status === "approved")) {
                  row.status = "failed";
                  row.result = String(args[1]);
                }
              }
              return { meta: {} };
            },
            async first() {
              if (sql.includes("SELECT status, auto_approvable")) {
                return actions.get(String(args[0])) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, actions, observations };
}

describe("D1GatekeeperQueue", async () => {
  const { D1GatekeeperQueue } = await import("../src/gatekeepers/log");
  const ctx = { sessionId: "wf1", actor: "dispatcher" };
  const description: ActionDescription = {
    title: "Planner task task1 update (alpha)",
    description: "Patch: percentComplete 100",
    implementsRevert: false,
    actionKind: { tag: "graph.patch_planner_task", label: "Update Planner task" },
  };

  it("blocks a non-auto action with no evidence; the row stays pending", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "graph", "graph:alpha:plan1", ctx);
    await queue.submitAction("patch", description);
    await expect(queue.recordDecision("patch")).rejects.toThrow(/requires recorded human authorization/);
    expect(actions.get("wf1#patch")?.status).toBe("pending");
  });

  it("approves with evidence and attributes the named human", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "graph", "graph:alpha:plan1", ctx);
    await queue.submitAction("patch", description);
    await queue.recordDecision("patch", {
      kind: "human_approval",
      approvalId: "apr_wf1",
      decidedBy: "diego@s-fx.com",
    });
    await queue.recordApplied("patch", "task task1 patched");
    const row = actions.get("wf1#patch");
    expect(row?.status).toBe("applied");
    expect(row?.decided_by).toBe("diego@s-fx.com");
    expect(row?.auth_evidence).toContain("apr_wf1");
  });

  it("lets an auto-approvable action through without evidence", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "graph", "graph:alpha:plan1", ctx);
    await queue.submitAction("fact", { ...description, autoApprovable: true });
    await queue.recordDecision("fact");
    expect(actions.get("wf1#fact")?.status).toBe("approved");
  });

  it("refuses a decision on an action that was never submitted", async () => {
    const { db } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "graph", "graph:alpha:plan1", ctx);
    await expect(queue.recordDecision("ghost")).rejects.toThrow(/never submitted/);
  });

  it("treats a retried decision on a decided action as a no-op", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "graph", "graph:alpha:plan1", ctx);
    await queue.submitAction("patch", description);
    await queue.recordDecision("patch", {
      kind: "human_approval",
      approvalId: "apr_wf1",
      decidedBy: "diego@s-fx.com",
    });
    // Second decision (a workflow step retry) must not throw or overwrite.
    await queue.recordDecision("patch");
    expect(actions.get("wf1#patch")?.decided_by).toBe("diego@s-fx.com");
  });
});
