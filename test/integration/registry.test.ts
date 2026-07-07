import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import {
  mapChatType,
  syncRegistry,
  upsertChannelRow,
  upsertChatRow,
  upsertDriveRow,
  upsertSiteRow,
  upsertUserRow,
  type RegistryDeps,
} from "../../src/graph/registry";

// Integration tests run the real upsert helpers against the miniflare D1 and
// exercise syncRegistry's failure path with an injected graph seam that
// throws. We assert both the happy-path upsert semantics (no clobbering of
// columns other flows own) and that a failing sync still records one
// ingest_runs row with the failure count.

const testEnv = env as unknown as Env;
const log = logger();
const TID = testEnv.GRAPH_TENANT_ID;

describe("registry upsert helpers", () => {
  it("upsertUserRow refreshes display_name/mail/upn without clobbering is_admin/last_seen_at/profile_json", async () => {
    const aadId = "reg-user-1";
    await upsertUserRow(testEnv, {
      aadId,
      tenantId: TID,
      displayName: "Old Name",
      mail: "old@example.com",
      upn: "old@example.com",
    });

    // Columns owned by other flows (admin flag, presence, profile).
    await testEnv.ARCADIA_DB.prepare(
      `UPDATE users
          SET is_admin = 1, last_seen_at = '2020-01-01T00:00:00.000Z',
              profile_json = '{"style":"terse"}'
        WHERE aad_id = ?`,
    )
      .bind(aadId)
      .run();

    await upsertUserRow(testEnv, {
      aadId,
      tenantId: TID,
      displayName: "New Name",
      mail: "new@example.com",
      upn: "new@example.com",
    });

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT display_name, mail, upn, is_admin, last_seen_at, profile_json
         FROM users WHERE aad_id = ?`,
    )
      .bind(aadId)
      .first<{
        display_name: string;
        mail: string;
        upn: string;
        is_admin: number;
        last_seen_at: string;
        profile_json: string;
      }>();

    expect(row?.display_name).toBe("New Name");
    expect(row?.mail).toBe("new@example.com");
    expect(row?.upn).toBe("new@example.com");
    // Untouched:
    expect(row?.is_admin).toBe(1);
    expect(row?.last_seen_at).toBe("2020-01-01T00:00:00.000Z");
    expect(row?.profile_json).toBe('{"style":"terse"}');
  });

  it("upsertSiteRow inserts then updates display_name/web_url", async () => {
    const siteId = "reg-site-1";
    await upsertSiteRow(testEnv, {
      siteId,
      tenantId: TID,
      displayName: "Old Site",
      webUrl: "https://sp/old",
    });
    await upsertSiteRow(testEnv, {
      siteId,
      tenantId: TID,
      displayName: "New Site",
      webUrl: "https://sp/new",
    });

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT display_name, web_url, last_synced_at FROM sites WHERE site_id = ?`,
    )
      .bind(siteId)
      .first<{
        display_name: string;
        web_url: string;
        last_synced_at: string;
      }>();
    expect(row?.display_name).toBe("New Site");
    expect(row?.web_url).toBe("https://sp/new");
    expect(row?.last_synced_at).toBeTruthy();
  });

  it("upsertDriveRow inserts then updates drive_type/display_name", async () => {
    const driveId = "reg-drive-1";
    await upsertDriveRow(testEnv, {
      driveId,
      tenantId: TID,
      ownerType: "site",
      ownerId: "reg-site-1",
      driveType: "documentLibrary",
      displayName: "Docs",
    });
    await upsertDriveRow(testEnv, {
      driveId,
      tenantId: TID,
      ownerType: "site",
      ownerId: "reg-site-1",
      driveType: "documentLibrary",
      displayName: "Documents",
    });

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT owner_type, owner_id, drive_type, display_name
         FROM drives WHERE drive_id = ?`,
    )
      .bind(driveId)
      .first<{
        owner_type: string;
        owner_id: string;
        drive_type: string;
        display_name: string;
      }>();
    expect(row?.owner_type).toBe("site");
    expect(row?.display_name).toBe("Documents");
  });

  it("upsertChannelRow sets empty service_url on insert and never clobbers service_url/conversation_id/enabled", async () => {
    const channelId = "reg-channel-1";
    // First-seen via registry enumeration → empty service_url.
    await upsertChannelRow(testEnv, {
      channelId,
      teamId: "team-1",
      tenantId: TID,
      displayName: "General",
    });
    let row = await testEnv.ARCADIA_DB.prepare(
      `SELECT service_url, display_name FROM channels WHERE channel_id = ?`,
    )
      .bind(channelId)
      .first<{ service_url: string; display_name: string }>();
    expect(row?.service_url).toBe("");
    expect(row?.display_name).toBe("General");

    // Bot conversationUpdate fills in the real serviceUrl + conversation_id.
    await testEnv.ARCADIA_DB.prepare(
      `UPDATE channels
          SET service_url = 'https://smba.example/v3',
              conversation_id = 'conv-xyz', enabled = 1
        WHERE channel_id = ?`,
    )
      .bind(channelId)
      .run();

    // Next registry sweep refreshes the display name only.
    await upsertChannelRow(testEnv, {
      channelId,
      teamId: "team-1",
      tenantId: TID,
      displayName: "General (renamed)",
    });

    row = await testEnv.ARCADIA_DB.prepare(
      `SELECT service_url, display_name, conversation_id, enabled
         FROM channels WHERE channel_id = ?`,
    )
      .bind(channelId)
      .first<{
        service_url: string;
        display_name: string;
        conversation_id: string;
        enabled: number;
      }>();
    expect(row?.display_name).toBe("General (renamed)");
    expect(row?.service_url).toBe("https://smba.example/v3");
    expect(row?.conversation_id).toBe("conv-xyz");
    expect(row?.enabled).toBe(1);
  });

  it("upsertChatRow sets empty service_url on insert and preserves it on conflict", async () => {
    const chatId = "reg-chat-1";
    await upsertChatRow(testEnv, {
      chatId,
      tenantId: TID,
      chatType: mapChatType("oneOnOne"),
      displayName: "DM",
    });
    let row = await testEnv.ARCADIA_DB.prepare(
      `SELECT service_url, chat_type, display_name FROM chats WHERE chat_id = ?`,
    )
      .bind(chatId)
      .first<{ service_url: string; chat_type: string; display_name: string }>();
    expect(row?.service_url).toBe("");
    expect(row?.chat_type).toBe("oneOnOne");

    await testEnv.ARCADIA_DB.prepare(
      `UPDATE chats SET service_url = 'https://smba.example/v3' WHERE chat_id = ?`,
    )
      .bind(chatId)
      .run();

    await upsertChatRow(testEnv, {
      chatId,
      tenantId: TID,
      chatType: mapChatType("weird-unknown-type"),
      displayName: "Group now",
    });
    row = await testEnv.ARCADIA_DB.prepare(
      `SELECT service_url, chat_type, display_name FROM chats WHERE chat_id = ?`,
    )
      .bind(chatId)
      .first<{ service_url: string; chat_type: string; display_name: string }>();
    // Unknown chatType maps to 'group' (satisfies the CHECK constraint).
    expect(row?.chat_type).toBe("group");
    expect(row?.display_name).toBe("Group now");
    expect(row?.service_url).toBe("https://smba.example/v3");
  });

  it("mapChatType passes through known values and defaults unknown to group", () => {
    expect(mapChatType("oneOnOne")).toBe("oneOnOne");
    expect(mapChatType("group")).toBe("group");
    expect(mapChatType("meeting")).toBe("meeting");
    expect(mapChatType(undefined)).toBe("group");
    expect(mapChatType("unknownType")).toBe("group");
  });
});

describe("syncRegistry failure accounting", () => {
  it("records one ingest_runs row and counts every failing sub-sync when Graph is down", async () => {
    // Seed a site + user + channel so the drives (site loop), chats, and
    // site-ACL sub-syncs all reach the injected graph fn and fail —
    // otherwise those sub-syncs would no-op on empty tables.
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO sites (site_id, tenant_id) VALUES (?, ?)`,
    )
      .bind("reg-fail-site", TID)
      .run();
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO users (aad_id, tenant_id) VALUES (?, ?)`,
    )
      .bind("reg-fail-user", TID)
      .run();
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO channels (channel_id, team_id, tenant_id, service_url)
       VALUES (?, ?, ?, '')`,
    )
      .bind("reg-fail-channel", "reg-fail-team", TID)
      .run();

    // Injected seam: every Graph call throws (a non-GraphError, so the
    // 404/403 skip paths do not swallow it).
    const downDeps: RegistryDeps = {
      graphAllPages: () => Promise.reject(new Error("graph down")),
      graph: () => Promise.reject(new Error("graph down")),
    };

    const before = await countRegistryRuns();
    const summary = await syncRegistry(testEnv, log, downDeps);
    const after = await countRegistryRuns();

    expect(after).toBe(before + 1);
    expect(summary.processed).toBe(0);
    // Six sub-syncs: users, sites, drives, teams_channels, chats, site_acl.
    expect(summary.failures).toBe(6);
    expect(summary.detail).toEqual({
      users: null,
      sites: null,
      drives: null,
      teamsChannels: null,
      chats: null,
      channelGrants: null,
      chatGrantsAdded: null,
      chatGrantsRemoved: null,
      siteGrants: null,
    });

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT source, processed, failures, detail_json, finished_at
         FROM ingest_runs WHERE source = 'registry'
        ORDER BY started_at DESC LIMIT 1`,
    ).first<{
      source: string;
      processed: number;
      failures: number;
      detail_json: string;
      finished_at: string;
    }>();
    expect(row?.source).toBe("registry");
    expect(row?.processed).toBe(0);
    expect(row?.failures).toBe(6);
    expect(row?.finished_at).toBeTruthy();
    expect(JSON.parse(row?.detail_json ?? "{}")).toEqual({
      users: null,
      sites: null,
      drives: null,
      teamsChannels: null,
      chats: null,
      channelGrants: null,
      chatGrantsAdded: null,
      chatGrantsRemoved: null,
      siteGrants: null,
    });
  });
});

async function countRegistryRuns(): Promise<number> {
  const r = await testEnv.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM ingest_runs WHERE source = 'registry'`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}
