import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { GraphError } from "../../src/graph/client";
import {
  syncChats,
  syncSiteAcl,
  syncTeamsAndChannels,
  type RegistryDeps,
} from "../../src/graph/registry";

// These integration tests exercise the ACL-derivation pipeline (P2.1): the
// resource_acl rows written as a side effect of registry sync. They run the
// real sync functions against miniflare D1 with an injected Graph seam that
// serves canned teams / channels / chats / members / sites, and assert the
// derived rows are created idempotently, that chat membership reconciliation
// adds+removes only user grants (preserving group grants), and that site
// grants appear only when a group's root site is one we already track.

const testEnv = env as unknown as Env;
const log = logger();

// Build an injectable Graph seam. `allPages` handles graphAllPages() calls
// (routed by req.path); `graph` handles single graph() calls. Handlers may
// throw (e.g. a GraphError) to exercise the skip paths.
function makeDeps(opts: {
  allPages?: (path: string) => unknown[];
  graph?: (path: string) => unknown;
}): RegistryDeps {
  return {
    graphAllPages: (_env, req) => {
      const items = opts.allPages ? opts.allPages(req.path) : [];
      return Promise.resolve({ items });
    },
    graph: (_env, req) => {
      if (!opts.graph) {
        return Promise.reject(new Error(`unexpected graph call: ${req.path}`));
      }
      try {
        return Promise.resolve(opts.graph(req.path));
      } catch (e) {
        return Promise.reject(e as Error);
      }
    },
  };
}

async function aclRows(
  resourceType: string,
  resourceId: string,
): Promise<{ pt: string; pid: string }[]> {
  const rows = await testEnv.ARCADIA_DB.prepare(
    `SELECT principal_type AS pt, principal_id AS pid
       FROM resource_acl
      WHERE resource_type = ? AND resource_id = ?
      ORDER BY principal_type, principal_id`,
  )
    .bind(resourceType, resourceId)
    .all<{ pt: string; pid: string }>();
  return rows.results;
}

describe("channel ACL derivation", () => {
  it("derives one group grant per channel, idempotently", async () => {
    const deps = makeDeps({
      allPages: (path) => {
        if (path === "/groups") return [{ id: "acl-team-A" }];
        if (path === "/teams/acl-team-A/channels")
          return [{ id: "acl-chan-1" }, { id: "acl-chan-2" }];
        return [];
      },
    });

    const first = await syncTeamsAndChannels(testEnv, log, deps);
    expect(first.channels).toBe(2);
    expect(first.channelGrants).toBe(2);

    expect(await aclRows("channel", "acl-chan-1")).toEqual([
      { pt: "group", pid: "acl-team-A" },
    ]);
    expect(await aclRows("channel", "acl-chan-2")).toEqual([
      { pt: "group", pid: "acl-team-A" },
    ]);

    // Second run: no new grants, no duplicates.
    const second = await syncTeamsAndChannels(testEnv, log, deps);
    expect(second.channelGrants).toBe(0);
    expect(await aclRows("channel", "acl-chan-1")).toHaveLength(1);
    expect(await aclRows("channel", "acl-chan-2")).toHaveLength(1);
  });
});

describe("chat member ACL reconciliation", () => {
  it("adds+removes user grants while preserving a manual group grant", async () => {
    const chatId = "acl-chat-X";

    // A user in the DB so syncChats has someone to walk chats for.
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO users (aad_id, tenant_id) VALUES (?, ?)`,
    )
      .bind("acl-walker", testEnv.GRAPH_TENANT_ID)
      .run();

    // Pre-seed: a manual group grant (must survive) and a stale user grant
    // (must be removed once that user is no longer a member).
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO resource_acl
         (resource_type, resource_id, principal_type, principal_id, granted_at)
       VALUES ('chat', ?, 'group', 'acl-grp-manual', datetime('now')),
              ('chat', ?, 'user',  'acl-user-old',   datetime('now'))`,
    )
      .bind(chatId, chatId)
      .run();

    const deps = makeDeps({
      allPages: (path) => {
        if (path.endsWith("/chats"))
          return [{ id: chatId, chatType: "group" }];
        if (path === `/chats/${chatId}/members`)
          return [{ userId: "acl-user-1" }, { userId: "acl-user-2" }];
        return [];
      },
    });

    const first = await syncChats(testEnv, log, deps);
    expect(first.grantsAdded).toBe(2);
    expect(first.grantsRemoved).toBe(1);

    expect(await aclRows("chat", chatId)).toEqual([
      { pt: "group", pid: "acl-grp-manual" },
      { pt: "user", pid: "acl-user-1" },
      { pt: "user", pid: "acl-user-2" },
    ]);

    // Idempotent: a second cycle with the same membership changes nothing.
    const second = await syncChats(testEnv, log, deps);
    expect(second.grantsAdded).toBe(0);
    expect(second.grantsRemoved).toBe(0);
    expect(await aclRows("chat", chatId)).toHaveLength(3);
  });

  it("skips reconciliation on a 403/404 members fetch, leaving grants intact", async () => {
    const chatId = "acl-chat-forbidden";
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO users (aad_id, tenant_id) VALUES (?, ?)`,
    )
      .bind("acl-walker-2", testEnv.GRAPH_TENANT_ID)
      .run();
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO resource_acl
         (resource_type, resource_id, principal_type, principal_id, granted_at)
       VALUES ('chat', ?, 'user', 'acl-keep', datetime('now'))`,
    )
      .bind(chatId)
      .run();

    const deps: RegistryDeps = {
      graphAllPages: (_env, req) => {
        if (req.path.endsWith("/chats"))
          return Promise.resolve({
            items: [{ id: chatId, chatType: "oneOnOne" }],
          });
        // members fetch → 403
        return Promise.reject(new GraphError(403, "forbidden"));
      },
      graph: () => Promise.reject(new Error("unused")),
    };

    const r = await syncChats(testEnv, log, deps);
    expect(r.grantsAdded).toBe(0);
    expect(r.grantsRemoved).toBe(0);
    // The pre-existing user grant is untouched (not deleted by a skip).
    expect(await aclRows("chat", chatId)).toEqual([
      { pt: "user", pid: "acl-keep" },
    ]);
  });
});

describe("site ACL derivation", () => {
  it("grants only when a group's root site matches a known site row", async () => {
    // Known site; site-unknown is deliberately absent from the sites table.
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO sites (site_id, tenant_id) VALUES (?, ?)`,
    )
      .bind("acl-site-known", testEnv.GRAPH_TENANT_ID)
      .run();

    // Channels give us the set of Team group ids (team_id) to resolve.
    for (const [chan, team] of [
      ["acl-sc-1", "acl-grp-known"],
      ["acl-sc-2", "acl-grp-unknown"],
      ["acl-sc-3", "acl-grp-403"],
    ]) {
      await testEnv.ARCADIA_DB.prepare(
        `INSERT OR IGNORE INTO channels (channel_id, team_id, tenant_id, service_url)
         VALUES (?, ?, ?, '')`,
      )
        .bind(chan, team, testEnv.GRAPH_TENANT_ID)
        .run();
    }

    const deps = makeDeps({
      graph: (path) => {
        if (path === "/groups/acl-grp-known/sites/root")
          return { id: "acl-site-known" };
        if (path === "/groups/acl-grp-unknown/sites/root")
          return { id: "acl-site-unknown" };
        if (path === "/groups/acl-grp-403/sites/root")
          throw new GraphError(403, "forbidden");
        return {};
      },
    });

    const grants = await syncSiteAcl(testEnv, log, deps);
    expect(grants).toBe(1);

    // Only the known site gets a grant; the unknown site gets none.
    expect(await aclRows("site", "acl-site-known")).toEqual([
      { pt: "group", pid: "acl-grp-known" },
    ]);
    expect(await aclRows("site", "acl-site-unknown")).toHaveLength(0);

    // Idempotent second pass.
    const again = await syncSiteAcl(testEnv, log, deps);
    expect(again).toBe(0);
    expect(await aclRows("site", "acl-site-known")).toHaveLength(1);
  });
});
