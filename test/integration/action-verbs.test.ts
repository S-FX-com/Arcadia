import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import type { ActionContext } from "../../src/actions/framework";
import type { GraphRequest } from "../../src/graph/client";
import type { ConversationRef } from "../../src/runtime/bot-outbound";
import {
  assignTaskVerb,
  completeTaskVerb,
  createTaskVerb,
  draftMessageVerb,
  makeScheduleMeetingVerb,
  makeSendMailVerb,
  makeSendMessageVerb,
} from "../../src/actions/verbs";

// Verb-level integration tests. The task verbs run against the real
// miniflare D1 and assert rows in tasks / ownership_history. The outbound
// verbs (mail, message, meeting) run against injected seams — a spy in
// place of Graph / Bot Framework — so we assert the request shape and the
// delegated-token requirement without any network.

const testEnv = env as unknown as Env;
const log = logger();

const ctx: ActionContext = { env: testEnv, log, actorAadId: "verb-actor" };
function ctxWithToken(userToken: string): ActionContext {
  return { env: testEnv, log, actorAadId: "verb-actor", userToken };
}

describe("draft_message verb", () => {
  it("is pure — returns the draft, never sends", async () => {
    const p = draftMessageVerb.parse({ text: "hello team", channelId: "c1" });
    const res = await draftMessageVerb.execute(ctx, p);
    expect(res.ok).toBe(true);
    const detail = res.detail as { draft: { text: string; channelId?: string } };
    expect(detail.draft.text).toBe("hello team");
    expect(detail.draft.channelId).toBe("c1");
    expect(draftMessageVerb.defaultLevel).toBe("draft");
  });
});

describe("create_task verb", () => {
  it("writes a tasks row + initial ownership_history row", async () => {
    const p = createTaskVerb.parse({
      title: "Chase invoices",
      ownerAadId: "owner-alpha",
      priority: "high",
      description: "follow up",
    });
    const res = await createTaskVerb.execute(ctx, p);
    expect(res.ok).toBe(true);
    const taskId = (res.detail as { taskId: string }).taskId;

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT title, owner_aad_id, created_by_aad_id, priority, description, status
         FROM tasks WHERE id = ?`,
    )
      .bind(taskId)
      .first<{
        title: string;
        owner_aad_id: string | null;
        created_by_aad_id: string | null;
        priority: string;
        description: string | null;
        status: string;
      }>();
    expect(row?.title).toBe("Chase invoices");
    expect(row?.owner_aad_id).toBe("owner-alpha");
    expect(row?.created_by_aad_id).toBe("verb-actor");
    expect(row?.priority).toBe("high");
    expect(row?.description).toBe("follow up");
    expect(row?.status).toBe("open");

    const oh = await testEnv.ARCADIA_DB.prepare(
      `SELECT to_aad_id FROM ownership_history WHERE task_id = ?`,
    )
      .bind(taskId)
      .all<{ to_aad_id: string }>();
    expect(oh.results).toHaveLength(1);
    expect(oh.results[0]?.to_aad_id).toBe("owner-alpha");
  });

  it("rejects a missing title at parse time", () => {
    expect(() => createTaskVerb.parse({ ownerAadId: "x" })).toThrow();
  });
});

describe("assign_task verb", () => {
  it("replaces the owner and appends an ownership_history row", async () => {
    const created = await createTaskVerb.execute(
      ctx,
      createTaskVerb.parse({ title: "Reassign me", ownerAadId: "owner-1" }),
    );
    const taskId = (created.detail as { taskId: string }).taskId;

    const res = await assignTaskVerb.execute(
      ctx,
      assignTaskVerb.parse({ taskId, ownerAadId: "owner-2" }),
    );
    expect(res.ok).toBe(true);

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT owner_aad_id FROM tasks WHERE id = ?`,
    )
      .bind(taskId)
      .first<{ owner_aad_id: string }>();
    expect(row?.owner_aad_id).toBe("owner-2");

    const oh = await testEnv.ARCADIA_DB.prepare(
      `SELECT from_aad_id, to_aad_id FROM ownership_history
         WHERE task_id = ? ORDER BY id ASC`,
    )
      .bind(taskId)
      .all<{ from_aad_id: string | null; to_aad_id: string }>();
    expect(oh.results).toHaveLength(2);
    expect(oh.results[1]?.from_aad_id).toBe("owner-1");
    expect(oh.results[1]?.to_aad_id).toBe("owner-2");
  });

  it("returns task_not_found for an unknown id", async () => {
    const res = await assignTaskVerb.execute(
      ctx,
      assignTaskVerb.parse({ taskId: "no-such-task", ownerAadId: "z" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("task_not_found");
  });
});

describe("complete_task verb", () => {
  it("marks the task done", async () => {
    const created = await createTaskVerb.execute(
      ctx,
      createTaskVerb.parse({ title: "Finish me" }),
    );
    const taskId = (created.detail as { taskId: string }).taskId;

    const res = await completeTaskVerb.execute(
      ctx,
      completeTaskVerb.parse({ taskId }),
    );
    expect(res.ok).toBe(true);

    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT status FROM tasks WHERE id = ?`,
    )
      .bind(taskId)
      .first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("returns task_not_found for an unknown id", async () => {
    const res = await completeTaskVerb.execute(
      ctx,
      completeTaskVerb.parse({ taskId: "no-such-task" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("task_not_found");
  });
});

describe("send_mail verb (delegated/OBO)", () => {
  interface SendMailBody {
    message: {
      subject: string;
      body: { contentType: string; content: string };
      toRecipients: { emailAddress: { address: string } }[];
    };
    saveToSentItems: boolean;
  }

  function seam() {
    const calls: GraphRequest[] = [];
    const verb = makeSendMailVerb({
      graph: async (_env, req) => {
        calls.push(req);
        return {};
      },
      delegatedGraphToken: async (_env, userToken) => `obo:${userToken}`,
    });
    return { calls, verb };
  }

  it("without userToken → delegated_required, no Graph call", async () => {
    const { calls, verb } = seam();
    const res = await verb.execute(
      ctx,
      verb.parse({ to: ["a@b.com"], subject: "Hi", body: "body" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("delegated_required");
    expect(calls).toHaveLength(0);
  });

  it("with userToken → POST /me/sendMail with the OBO token + correct shape", async () => {
    const { calls, verb } = seam();
    const res = await verb.execute(
      ctxWithToken("USER-TOKEN"),
      verb.parse({ to: ["a@b.com", "c@d.com"], subject: "Subject", body: "Hello" }),
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/me/sendMail");
    expect(req.token).toBe("obo:USER-TOKEN");
    const body = req.body as SendMailBody;
    expect(body.message.subject).toBe("Subject");
    expect(body.message.body.content).toBe("Hello");
    expect(body.message.toRecipients.map((r) => r.emailAddress.address)).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });
});

describe("schedule_meeting verb (delegated/OBO)", () => {
  interface EventBody {
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees: { emailAddress: { address: string }; type: string }[];
  }

  function seam() {
    const calls: GraphRequest[] = [];
    const verb = makeScheduleMeetingVerb({
      graph: async (_env, req) => {
        calls.push(req);
        return { id: "event-123" };
      },
      delegatedGraphToken: async (_env, userToken) => `obo:${userToken}`,
    });
    return { calls, verb };
  }

  it("without userToken → delegated_required", async () => {
    const { calls, verb } = seam();
    const res = await verb.execute(
      ctx,
      verb.parse({
        subject: "Sync",
        attendees: ["a@b.com"],
        start: "2026-07-08T10:00:00Z",
        end: "2026-07-08T10:30:00Z",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("delegated_required");
    expect(calls).toHaveLength(0);
  });

  it("with userToken → POST /me/events with correct shape + returns eventId", async () => {
    const { calls, verb } = seam();
    const res = await verb.execute(
      ctxWithToken("UT"),
      verb.parse({
        subject: "Sync",
        attendees: ["a@b.com"],
        start: "2026-07-08T10:00:00Z",
        end: "2026-07-08T10:30:00Z",
        body: "agenda",
      }),
    );
    expect(res.ok).toBe(true);
    expect((res.detail as { eventId?: string }).eventId).toBe("event-123");
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/me/events");
    expect(req.token).toBe("obo:UT");
    const body = req.body as EventBody;
    expect(body.subject).toBe("Sync");
    expect(body.start.dateTime).toBe("2026-07-08T10:00:00Z");
    expect(body.end.timeZone).toBe("UTC");
    expect(body.attendees[0]?.emailAddress.address).toBe("a@b.com");
    expect(body.attendees[0]?.type).toBe("required");
  });
});

describe("send_message verb (app-only via bot-outbound)", () => {
  it("resolves the channel conversation ref and posts text", async () => {
    await testEnv.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO channels
         (channel_id, team_id, tenant_id, service_url, conversation_id, enabled)
       VALUES (?, 'team-x', 'tenant-x', ?, ?, 1)`,
    )
      .bind("sm-channel-1", "https://smba.example/v3", "sm-conv-1")
      .run();

    const posts: { ref: ConversationRef; text: string }[] = [];
    const verb = makeSendMessageVerb({
      postText: async (_env, ref, text) => {
        posts.push({ ref, text });
      },
    });

    const res = await verb.execute(
      ctx,
      verb.parse({ channelId: "sm-channel-1", text: "status update" }),
    );
    expect(res.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.ref.serviceUrl).toBe("https://smba.example/v3");
    expect(posts[0]?.ref.conversationId).toBe("sm-conv-1");
    expect(posts[0]?.text).toBe("status update");
  });

  it("returns conversation_not_found when the channel is unknown", async () => {
    const posts: { ref: ConversationRef; text: string }[] = [];
    const verb = makeSendMessageVerb({
      postText: async (_env, ref, text) => {
        posts.push({ ref, text });
      },
    });
    const res = await verb.execute(
      ctx,
      verb.parse({ channelId: "does-not-exist", text: "x" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("conversation_not_found");
    expect(posts).toHaveLength(0);
  });

  it("parse requires channelId or chatId", () => {
    expect(() => makeSendMessageVerb().parse({ text: "no target" })).toThrow();
  });
});
