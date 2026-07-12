import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { GraphError, type GraphRequest } from "../../src/graph/client";
import type { ProducerDeps } from "../../src/ingest/producers/deps";
import type { IngestMessage } from "../../src/ingest/types";
import { produceDrives } from "../../src/ingest/producers/drive";
import { produceSharepoint } from "../../src/ingest/producers/sharepoint";
import { produceMessages } from "../../src/ingest/producers/messages";
import { produceMail } from "../../src/ingest/producers/mail";
import { produceCalendar } from "../../src/ingest/producers/calendar";
import { produceMeetings } from "../../src/ingest/producers/meetings";
import { produceAll } from "../../src/ingest/producers";

// Producer integration tests: seed the registry tables in miniflare D1, then
// drive each producer through a stubbed Graph seam (canned pages + a queue
// collector). We assert the enqueued IngestMessages, delta_state writes, KV
// cursor advancement, per-producer ingest_runs rows, and the mail-403 /
// meetings-403 graceful-degradation paths.

const testEnv = env as unknown as Env;
const log = logger();
const TID = testEnv.GRAPH_TENANT_ID;
const NOW = new Date("2026-07-07T12:00:00.000Z");

type PageResult = { items: unknown[]; deltaLink?: string };
type PageFn = (req: GraphRequest) => PageResult | Promise<PageResult>;
type TextFn = (req: GraphRequest) => string | Promise<string>;

interface StubOpts {
  pages?: PageFn;
  text?: TextFn;
}

function makeDeps(opts: StubOpts): { deps: ProducerDeps; sent: IngestMessage[] } {
  const sent: IngestMessage[] = [];
  const deps: ProducerDeps = {
    graphAllPages: (async (_env: Env, req: GraphRequest) =>
      opts.pages
        ? opts.pages(req)
        : { items: [] }) as ProducerDeps["graphAllPages"],
    graph: (async () => {
      throw new Error("graph() not stubbed");
    }) as ProducerDeps["graph"],
    graphText: async (_env, req) => (opts.text ? opts.text(req) : ""),
    send: async (_env, msg) => {
      sent.push(msg);
    },
    now: () => NOW,
  };
  return { deps, sent };
}

async function deltaToken(
  resource: string,
  scopeKey: string,
): Promise<string | null> {
  const row = await testEnv.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(resource, scopeKey)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

beforeEach(async () => {
  // Isolate each test: clear KV cursors and the tables/rows the producers walk.
  for (const key of [
    "ingest:drive_cursor",
    "ingest:sharepoint_cursor",
    "ingest:mail_cursor",
    "ingest:calendar_cursor",
    "ingest:meetings_cursor",
  ]) {
    await testEnv.ARCADIA_CACHE.delete(key);
  }
  for (const table of [
    "drives",
    "sites",
    "channels",
    "chats",
    "users",
    "delta_state",
    "ingest_runs",
  ]) {
    await testEnv.ARCADIA_DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("produceDrives", () => {
  it("walks site + user drives, skips folders/unsupported mimes, sets scope + delta", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO drives (drive_id, tenant_id, owner_type, owner_id) VALUES
         ('d-site', ?, 'site', 'site-1'),
         ('d-user', ?, 'user', 'user-9')`,
    )
      .bind(TID, TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (req.path === "/drives/d-site/root/delta") {
          return {
            items: [
              { id: "f1", name: "a.txt", file: { mimeType: "text/plain" } },
              { id: "folder", folder: { childCount: 1 } },
              { id: "f2", name: "n.png", file: { mimeType: "image/png" } },
            ],
            deltaLink:
              "https://graph.microsoft.com/v1.0/drives/d-site/root/delta?token=SITETOK",
          };
        }
        if (req.path === "/drives/d-user/root/delta") {
          return {
            items: [
              { id: "u1", name: "b.pdf", file: { mimeType: "application/pdf" } },
            ],
            deltaLink:
              "https://graph.microsoft.com/v1.0/drives/d-user/root/delta?token=USERTOK",
          };
        }
        return { items: [] };
      },
    });

    const res = await produceDrives(testEnv, log, deps);
    expect(res.drives).toBe(2);
    expect(res.enqueued).toBe(2);
    expect(res.failures).toBe(0);

    const siteMsg = sent.find((m) => m.resourceId === "f1");
    expect(siteMsg?.source).toBe("drive_item");
    expect(siteMsg?.scope).toEqual({ resourceType: "site", resourceId: "site-1" });
    expect(siteMsg?.uri).toBe("/drives/d-site/items/f1/content");

    const userMsg = sent.find((m) => m.resourceId === "u1");
    expect(userMsg?.scope).toEqual({ resourceType: "user", resourceId: "user-9" });
    expect(userMsg?.ownerAadId).toBe("user-9");

    // Folder + png filtered out.
    expect(sent.some((m) => m.resourceId === "folder" || m.resourceId === "f2")).toBe(
      false,
    );

    expect(await deltaToken("drive", "d-site")).toContain("SITETOK");
    expect(await deltaToken("drive", "d-user")).toContain("USERTOK");
  });

  it("advances the KV cursor across runs and wraps at the end", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO drives (drive_id, tenant_id, owner_type, owner_id) VALUES
         ('d-a', ?, 'site', 's'), ('d-b', ?, 'site', 's')`,
    )
      .bind(TID, TID)
      .run();
    const { deps } = makeDeps({ pages: () => ({ items: [] }) });

    // cap=1 → first run processes d-a and parks the cursor there.
    await produceDrives(testEnv, log, deps, 1);
    expect(await testEnv.ARCADIA_CACHE.get("ingest:drive_cursor")).toBe("d-a");

    // Second run picks up d-b (a full cap-sized batch), parking there.
    await produceDrives(testEnv, log, deps, 1);
    expect(await testEnv.ARCADIA_CACHE.get("ingest:drive_cursor")).toBe("d-b");

    // Third run finds nothing past d-b → sweep complete, cursor wraps to "".
    await produceDrives(testEnv, log, deps, 1);
    expect(await testEnv.ARCADIA_CACHE.get("ingest:drive_cursor")).toBe("");
  });
});

describe("produceSharepoint", () => {
  it("enqueues pages newer than the watermark and advances it", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO sites (site_id, tenant_id) VALUES ('s-1', ?)`,
    )
      .bind(TID)
      .run();

    const pages: PageFn = () => ({
      items: [
        {
          id: "p1",
          title: "Old",
          lastModifiedDateTime: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "p2",
          title: "New",
          lastModifiedDateTime: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const first = makeDeps({ pages });
    const r1 = await produceSharepoint(testEnv, log, first.deps);
    expect(r1.enqueued).toBe(2);
    expect(first.sent[0]?.scope).toEqual({ resourceType: "site", resourceId: "s-1" });
    expect(await deltaToken("sharepoint_pages", "s-1")).toBe(
      "2026-07-01T00:00:00.000Z",
    );

    // Second run: nothing is newer than the stored watermark.
    const second = makeDeps({ pages });
    const r2 = await produceSharepoint(testEnv, log, second.deps);
    expect(r2.enqueued).toBe(0);
    expect(second.sent).toHaveLength(0);
  });
});

describe("produceMessages", () => {
  it("channel: delta walk sets channel scope + persists the deltaLink", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO channels (channel_id, team_id, tenant_id, service_url, enabled)
       VALUES ('chan-1', 'team-1', ?, '', 1)`,
    )
      .bind(TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (
          req.path ===
          "/teams/team-1/channels/chan-1/messages/delta"
        ) {
          return {
            items: [
              {
                id: "m1",
                createdDateTime: "2026-07-06T00:00:00.000Z",
                from: { user: { id: "u-1", displayName: "Ann" } },
                body: { content: "<p>hi</p>", contentType: "html" },
              },
            ],
            deltaLink:
              "https://graph.microsoft.com/v1.0/teams/team-1/channels/chan-1/messages/delta?$deltatoken=CHTOK",
          };
        }
        return { items: [] };
      },
    });

    const res = await produceMessages(testEnv, log, deps);
    expect(res.channels).toBe(1);
    expect(res.enqueued).toBe(1);
    const msg = sent[0];
    expect(msg?.source).toBe("teams_channel_message");
    expect(msg?.scope).toEqual({ resourceType: "channel", resourceId: "chan-1" });
    expect(msg?.ownerAadId).toBe("u-1");
    expect(await deltaToken("channel_messages", "team-1|chan-1")).toContain(
      "CHTOK",
    );
  });

  it("chat: watermark walk stops at the watermark and saves the newest", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO chats (chat_id, tenant_id, service_url, chat_type)
       VALUES ('chat-1', ?, '', 'group')`,
    )
      .bind(TID)
      .run();
    // Pre-seed a watermark so the desc-ordered break path is exercised.
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO delta_state (resource, scope_key, delta_token)
       VALUES ('chat_messages', 'chat-1', '2026-07-05T00:00:00.000Z')`,
    ).run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (req.path === "/chats/chat-1/messages") {
          return {
            items: [
              {
                id: "new",
                lastModifiedDateTime: "2026-07-06T00:00:00.000Z",
                from: { user: { id: "u-2" } },
                body: { content: "fresh", contentType: "text" },
              },
              {
                id: "old",
                lastModifiedDateTime: "2026-07-04T00:00:00.000Z",
                from: { user: { id: "u-3" } },
                body: { content: "stale", contentType: "text" },
              },
            ],
          };
        }
        return { items: [] };
      },
    });

    const res = await produceMessages(testEnv, log, deps);
    expect(res.chats).toBe(1);
    expect(res.enqueued).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.resourceId).toBe("new");
    expect(sent[0]?.scope).toEqual({ resourceType: "chat", resourceId: "chat-1" });
    expect(await deltaToken("chat_messages", "chat-1")).toBe(
      "2026-07-06T00:00:00.000Z",
    );
  });
});

describe("produceMail", () => {
  it("enqueues messages, skips 403 mailboxes silently, persists delta per user", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id) VALUES ('u-403', ?), ('u-ok', ?)`,
    )
      .bind(TID, TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (req.path === "/users/u-403/messages/delta") {
          throw new GraphError(403, "forbidden");
        }
        if (req.path === "/users/u-ok/messages/delta") {
          return {
            items: [
              { id: "mail-1", subject: "Hello", receivedDateTime: "2026-07-06T00:00:00.000Z" },
            ],
            deltaLink:
              "https://graph.microsoft.com/v1.0/users/u-ok/messages/delta?$deltatoken=MAILTOK",
          };
        }
        return { items: [] };
      },
    });

    const res = await produceMail(testEnv, log, deps);
    expect(res.users).toBe(2);
    expect(res.enqueued).toBe(1);
    expect(res.failures).toBe(0); // 403 does not count as a failure
    const msg = sent[0];
    expect(msg?.source).toBe("mail_message");
    expect(msg?.uri).toBe("/users/u-ok/messages/mail-1");
    expect(msg?.ownerAadId).toBe("u-ok");
    expect(msg?.scope).toEqual({ resourceType: "user", resourceId: "u-ok" });
    expect(msg?.title).toBe("Hello");
    expect(await deltaToken("mail", "u-ok")).toContain("MAILTOK");
    expect(await deltaToken("mail", "u-403")).toBeNull();
  });
});

describe("produceCalendar", () => {
  it("enqueues an inline text body scoped to the user", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id) VALUES ('cal-user', ?)`,
    )
      .bind(TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (req.path === "/users/cal-user/calendarView/delta") {
          return {
            items: [
              {
                id: "ev-1",
                subject: "Standup",
                organizer: { emailAddress: { name: "Boss" } },
                attendees: [{ emailAddress: { name: "Ann" } }],
                start: { dateTime: "2026-07-07T09:00:00", timeZone: "UTC" },
                end: { dateTime: "2026-07-07T09:15:00", timeZone: "UTC" },
                location: { displayName: "Room 1" },
                bodyPreview: "daily sync",
              },
            ],
            deltaLink:
              "https://graph.microsoft.com/v1.0/users/cal-user/calendarView/delta?$deltatoken=CALTOK",
          };
        }
        return { items: [] };
      },
    });

    const res = await produceCalendar(testEnv, log, deps);
    expect(res.enqueued).toBe(1);
    const msg = sent[0];
    expect(msg?.source).toBe("calendar_event");
    expect(msg?.body?.contentType).toBe("text");
    expect(msg?.body?.content).toContain("Subject: Standup");
    expect(msg?.body?.content).toContain("Organizer: Boss");
    expect(msg?.body?.content).toContain("Attendees: Ann");
    expect(msg?.body?.content).toContain("Location: Room 1");
    expect(msg?.scope).toEqual({ resourceType: "user", resourceId: "cal-user" });
    expect(msg?.ownerAadId).toBe("cal-user");
    expect(await deltaToken("calendar", "cal-user")).toContain("CALTOK");
  });
});

describe("produceMeetings", () => {
  it("resolves online meeting → transcript → inline vtt body", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id) VALUES ('org-1', ?)`,
    )
      .bind(TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: (req) => {
        if (req.path === "/users/org-1/calendarView") {
          return {
            items: [
              {
                id: "ev-9",
                subject: "Planning",
                end: { dateTime: "2026-07-07T10:00:00", timeZone: "UTC" },
                onlineMeeting: { joinUrl: "https://teams/join/xyz" },
              },
            ],
          };
        }
        if (req.path === "/users/org-1/onlineMeetings") {
          return { items: [{ id: "om-1", joinWebUrl: "https://teams/join/xyz" }] };
        }
        if (req.path === "/users/org-1/onlineMeetings/om-1/transcripts") {
          return {
            items: [{ id: "tr-1", createdDateTime: "2026-07-07T10:05:00.000Z" }],
          };
        }
        return { items: [] };
      },
      text: (req) => {
        if (
          req.path ===
          "/users/org-1/onlineMeetings/om-1/transcripts/tr-1/content"
        ) {
          return "WEBVTT\n\n00:00.000 --> 00:02.000\nHello team.";
        }
        return "";
      },
    });

    const res = await produceMeetings(testEnv, log, deps);
    expect(res.degraded).toBe(false);
    expect(res.transcripts).toBe(1);
    expect(res.enqueued).toBe(1);
    const msg = sent[0];
    expect(msg?.source).toBe("meeting_transcript");
    expect(msg?.resourceId).toBe("tr-1");
    expect(msg?.body?.content).toContain("WEBVTT");
    expect(msg?.title).toBe("Planning");
    expect(msg?.scope).toEqual({ resourceType: "user", resourceId: "org-1" });
  });

  it("degrades gracefully on a 403 from the protected API", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO users (aad_id, tenant_id) VALUES ('org-x', ?)`,
    )
      .bind(TID)
      .run();

    const { deps, sent } = makeDeps({
      pages: () => {
        throw new GraphError(403, "protected api not approved");
      },
    });

    const res = await produceMeetings(testEnv, log, deps);
    expect(res.degraded).toBe(true);
    expect(res.enqueued).toBe(0);
    expect(res.failures).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe("produceAll", () => {
  it("records one ingest_runs row per producer and isolates failures", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO drives (drive_id, tenant_id, owner_type, owner_id)
       VALUES ('pa-drive', ?, 'site', 'pa-site')`,
    )
      .bind(TID)
      .run();

    const { deps } = makeDeps({
      pages: (req) => {
        // Make the drive walk throw a non-Graph error → produceDrives catches
        // it internally and records failures=1 (produceAll still returns).
        if (req.path === "/drives/pa-drive/root/delta") {
          throw new Error("boom");
        }
        return { items: [] };
      },
    });

    const before = new Date().toISOString();
    const res = await produceAll(testEnv, log, deps);

    // Every producer ran and returned a (non-null) result.
    expect(res.drives).not.toBeNull();
    expect(res.drives?.failures).toBe(1);
    expect(res.messages).not.toBeNull();

    const rows = await testEnv.ARCADIA_DB.prepare(
      `SELECT source, failures FROM ingest_runs
        WHERE started_at >= ? ORDER BY source`,
    )
      .bind(before)
      .all<{ source: string; failures: number }>();
    const sources = rows.results.map((r) => r.source).sort();
    expect(sources).toEqual([
      "calendar",
      "drives",
      "mail",
      "meetings",
      "messages",
      "sharepoint",
    ]);
    const drivesRun = rows.results.find((r) => r.source === "drives");
    expect(drivesRun?.failures).toBe(1);
  });
});
