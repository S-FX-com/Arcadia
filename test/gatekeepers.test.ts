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
import {
  crawlSessionFromPorts,
  isSafeCrawlTarget,
  tutorialsSessionFromPorts,
  type TutorialsPorts,
} from "../src/gatekeepers/wordpress";
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
import type { WpPost } from "../src/integrations/wordpress";

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

const post = (over: Partial<WpPost> = {}): WpPost => ({
  id: 7,
  link: "https://www.s-fx.com/how-do-i/x",
  slug: "x",
  status: "draft",
  title: "X",
  ...over,
});

function wpPorts(over: Partial<TutorialsPorts> = {}): TutorialsPorts & { queue: RecordingQueue } {
  const queue = new RecordingQueue();
  return {
    queue,
    wp: {
      createPost: async (input) => post({ slug: input.slug, status: input.status, title: input.title }),
      searchPosts: async () => [post()],
      findBySlug: async () => undefined,
      readMetaKeys: async () => ["title", "desc"],
    },
    killSwitchEngaged: async () => false,
    autoPublishAllowed: async () => false,
    approvedApproval: async () => null,
    ...over,
  } as TutorialsPorts & { queue: RecordingQueue };
}

describe("WordPress tutorials session", () => {
  const human: ActionAuthorization = {
    kind: "human_approval",
    approvalId: "apr_wf1",
    decidedBy: "diego@s-fx.com",
  };

  it("logs an observation on every read", async () => {
    const ports = wpPorts();
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    await session.searchPosts("retainers");
    await session.findBySlug("x");
    await session.readMetaKeys(7);
    expect(ports.queue.observations).toHaveLength(3);
  });

  it("refuses to publish with no authorization, and records the block", async () => {
    let created = 0;
    const ports = wpPorts();
    ports.wp.createPost = async () => {
      created++;
      return post();
    };
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    await expect(
      session.createPost({ title: "T", content: "c", slug: "t", status: "publish" })
    ).rejects.toThrow(GatekeeperDeniedError);
    expect(created).toBe(0);
    expect(ports.queue.failed.size).toBe(1);
  });

  it("refuses authorization that does not match an approved approvals row", async () => {
    const ports = wpPorts({ approvedApproval: async () => ({ decidedBy: "someone-else@s-fx.com" }) });
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    await expect(
      session.createPost({ title: "T", content: "c", slug: "t", status: "publish" }, human)
    ).rejects.toThrow(/not an approved decision/);
  });

  it("publishes with verified human approval and records the chain", async () => {
    const ports = wpPorts({ approvedApproval: async () => ({ decidedBy: "diego@s-fx.com" }) });
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    const created = await session.createPost(
      { title: "T", content: "c", slug: "t", status: "publish" },
      human
    );
    expect(created.slug).toBe("t");
    const key = "wp.publish_post:t";
    expect(ports.queue.decided.get(key)).toEqual(human);
    expect(ports.queue.applied.has(key)).toBe(true);
  });

  it("refuses auto-publish while the 60-day control is off", async () => {
    const session = tutorialsSessionFromPorts("wp:test:tutorials", wpPorts());
    await expect(
      session.createPost({ title: "T", content: "c", slug: "t", status: "publish" }, { kind: "auto_publish" })
    ).rejects.toThrow(/60-day/);
  });

  it("refuses to publish past an engaged kill switch, approval or not", async () => {
    const ports = wpPorts({
      killSwitchEngaged: async () => true,
      approvedApproval: async () => ({ decidedBy: "diego@s-fx.com" }),
    });
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    await expect(
      session.createPost({ title: "T", content: "c", slug: "t", status: "publish" }, human)
    ).rejects.toThrow(/kill switch/);
  });

  it("applies a draft with no human tap — drafts are never client-visible", async () => {
    const ports = wpPorts();
    const session = tutorialsSessionFromPorts("wp:test:tutorials", ports);
    const created = await session.createPost({ title: "T", content: "c", slug: "t", status: "draft" });
    expect(created.status).toBe("draft");
    expect(ports.queue.applied.has("wp.create_draft:t")).toBe(true);
  });
});

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

  it("refuses a Planner write without a dispatch rule or human approval", async () => {
    const ports = graphPorts();
    const session = graphSessionFromPorts({ projectId: "alpha", plannerPlanId: "plan1" }, ports);
    await expect(
      session.patchPlannerTask("task1", "etag", { percentComplete: 100 }, { kind: "auto_publish" })
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
  const ctx = { sessionId: "wf1", actor: "hermes" };
  const description: ActionDescription = {
    title: "Publish: T",
    description: "slug t",
    implementsRevert: false,
    actionKind: { tag: "wp.publish_post", label: "Publish WordPress post" },
  };

  it("blocks a non-auto action with no evidence; the row stays pending", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "wordpress", "wp:test:tutorials", ctx);
    await queue.submitAction("publish", description);
    await expect(queue.recordDecision("publish")).rejects.toThrow(/requires recorded human authorization/);
    expect(actions.get("wf1#publish")?.status).toBe("pending");
  });

  it("approves with evidence and attributes the named human", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "wordpress", "wp:test:tutorials", ctx);
    await queue.submitAction("publish", description);
    await queue.recordDecision("publish", {
      kind: "human_approval",
      approvalId: "apr_wf1",
      decidedBy: "diego@s-fx.com",
    });
    await queue.recordApplied("publish", "post 7");
    const row = actions.get("wf1#publish");
    expect(row?.status).toBe("applied");
    expect(row?.decided_by).toBe("diego@s-fx.com");
    expect(row?.auth_evidence).toContain("apr_wf1");
  });

  it("lets an auto-approvable action through without evidence", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "wordpress", "wp:test:tutorials", ctx);
    await queue.submitAction("draft", { ...description, autoApprovable: true });
    await queue.recordDecision("draft");
    expect(actions.get("wf1#draft")?.status).toBe("approved");
  });

  it("refuses a decision on an action that was never submitted", async () => {
    const { db } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "wordpress", "wp:test:tutorials", ctx);
    await expect(queue.recordDecision("ghost")).rejects.toThrow(/never submitted/);
  });

  it("treats a retried decision on a decided action as a no-op", async () => {
    const { db, actions } = fakeDb();
    const queue = new D1GatekeeperQueue(db, "wordpress", "wp:test:tutorials", ctx);
    await queue.submitAction("publish", description);
    await queue.recordDecision("publish", {
      kind: "human_approval",
      approvalId: "apr_wf1",
      decidedBy: "diego@s-fx.com",
    });
    // Second decision (a workflow step retry) must not throw or overwrite.
    await queue.recordDecision("publish");
    expect(actions.get("wf1#publish")?.decided_by).toBe("diego@s-fx.com");
  });
});
