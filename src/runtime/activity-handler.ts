// Microsoft 365 Agents SDK activity handler.
//
// Activities arrive as Bot Framework JSON envelopes on POST /api/messages
// after JWT verification. Dispatch by activity.type:
//
//   message            user said something → AI reply, write episodic memory
//   invoke             card Action.Execute → dispatch by data.verb
//   conversationUpdate someone joined/left → maintain channels table
//   installationUpdate app installed/removed → register / unregister channel
//   typing / event     pass through, no reply
//
// Replies are written back via the serviceUrl in the activity using an
// outbound Bot Framework token (different from the inbound JWT we
// verified). We never hold the request open: long work goes via
// ctx.waitUntil after a 200 ack.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { Verb } from "../cards/types";
import { injectCharter } from "../charter/inject";
import { MemoryStore } from "../memory/store";
import { TaskStore } from "../tasks/store";
import { detectTasks, type DetectionContext } from "../tasks/detect";
import { BotAuthError, verifyBotJwt } from "./auth";
import { acquireBotToken } from "./bot-outbound";
import { dispatchInvoke, type InvokeActivity } from "./invoke-dispatch";

interface Activity {
  type: string;
  id?: string;
  name?: string;
  serviceUrl: string;
  channelId: string;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  from?: { id?: string; aadObjectId?: string; name?: string };
  recipient?: { id?: string; name?: string };
  text?: string;
  value?: {
    action?: {
      type?: string;
      verb?: Verb;
      data?: Record<string, unknown>;
    };
  } & Record<string, unknown>;
  channelData?: {
    teamsChannelId?: string;
    teamsTeamId?: string;
    team?: { id?: string };
    channel?: { id?: string };
    tenant?: { id?: string };
  };
  replyToId?: string;
}

export async function handleActivity(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  try {
    await verifyBotJwt(env, request.headers.get("authorization"));
  } catch (e) {
    if (e instanceof BotAuthError) {
      log.warn("activity_auth_failed", { error: e.message });
      return new Response("unauthorized", { status: 401 });
    }
    throw e;
  }

  let activity: Activity;
  try {
    activity = (await request.json()) as Activity;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  log.info("activity", {
    type: activity.type,
    channelId: activity.channelId,
    conversationId: activity.conversation?.id,
  });

  switch (activity.type) {
    case "message":
      ctx.waitUntil(
        handleMessage(env, activity, log).catch((e) =>
          log.error("message_failed", { error: String(e) }),
        ),
      );
      return new Response(null, { status: 200 });

    case "invoke":
      return handleInvoke(env, activity, log);

    case "conversationUpdate":
      ctx.waitUntil(
        handleConversationUpdate(env, activity, log).catch((e) =>
          log.error("conv_update_failed", { error: String(e) }),
        ),
      );
      return new Response(null, { status: 200 });

    case "installationUpdate":
    case "typing":
    case "event":
      return new Response(null, { status: 200 });

    default:
      log.info("activity_unhandled", { type: activity.type });
      return new Response(null, { status: 200 });
  }
}

async function handleMessage(
  env: Env,
  activity: Activity,
  log: Logger,
): Promise<void> {
  if (!activity.text || !activity.from?.aadObjectId) return;

  const text = stripBotMention(activity.text);
  const scopeId = activity.conversation.id;

  const tenantId =
    activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
  const memory = new MemoryStore(env);
  const recall = await memory.recall(text, {
    scopeType: "channel",
    scopeId,
    limit: 5,
    viewer: activity.from.aadObjectId,
    ...(tenantId ? { tenantId } : {}),
  });
  const context = recall
    .map((h) => `(${h.memory.kind}) ${h.memory.content}`)
    .join("\n");

  const router = new Router(env);
  const system = await injectCharter(
    env,
    "You are Arcadia, a Microsoft 365 AI operations layer. Reply in your own voice — direct, specific, no filler. Cite ownership signals when relevant. Use the context from memory only if it actually answers the question.",
  );
  const reply = await router.complete({
    system,
    messages: [
      ...(context
        ? [
            {
              role: "user" as const,
              content: `Context from memory:\n${context}`,
            },
          ]
        : []),
      { role: "user" as const, content: text },
    ],
    maxTokens: 600,
  });

  await replyToActivity(env, activity, reply.text, log);

  await memory
    .add({
      kind: "episodic",
      scopeType: "channel",
      scopeId,
      subjectAadId: activity.from.aadObjectId,
      content: `User asked: ${text}\nArcadia replied: ${reply.text}`,
      sourceResourceType: "teams_message",
      occurredAt: new Date().toISOString(),
      confidence: 1.0,
      ...(activity.id ? { sourceResourceId: activity.id } : {}),
      ...(activity.id ? { sourceMessageId: activity.id } : {}),
    })
    .catch((e) => log.warn("episodic_write_failed", { error: String(e) }));

  if (looksLikeTaskCarrier(text)) {
    await maybeDetectAndCreateTasks(env, activity, text, log).catch((e) =>
      log.warn("task_detect_create_failed", { error: String(e) }),
    );
  }
}

// Cheap prefilter so we don't burn an AI call on every message. If the
// text contains an assignment cue, a deadline cue, or a mention,
// it's worth asking detect.ts to look closer.
function looksLikeTaskCarrier(text: string): boolean {
  const lc = text.toLowerCase();
  if (/<at\b/i.test(text)) return true;
  return [
    "please",
    "can you",
    "could you",
    "would you",
    "let's",
    "we need",
    "i need",
    "need to",
    "have to",
    "should ",
    "todo",
    "to do",
    "follow up",
    "follow-up",
    "by tomorrow",
    "by today",
    "by friday",
    "by monday",
    "eod",
    "end of day",
    "end of week",
    "due ",
    "deadline",
  ].some((cue) => lc.includes(cue));
}

const MIN_TASK_CONFIDENCE = 0.6;

async function maybeDetectAndCreateTasks(
  env: Env,
  activity: Activity,
  text: string,
  log: Logger,
): Promise<void> {
  if (!activity.from?.aadObjectId) return;

  const context: DetectionContext = {
    authorAadId: activity.from.aadObjectId,
    ...(activity.from.name ? { authorDisplayName: activity.from.name } : {}),
  };

  const detected = await detectTasks(env, text, context, log);
  const actionable = detected.filter(
    (d) => d.confidence >= MIN_TASK_CONFIDENCE,
  );
  if (actionable.length === 0) return;

  const teamsChannelId =
    activity.channelData?.channel?.id ?? activity.channelData?.teamsChannelId;
  const isChannel = !!teamsChannelId;

  const store = new TaskStore(env);
  for (const d of actionable) {
    try {
      await store.create(
        {
          title: d.title,
          priority: d.priority,
          createdByAadId: activity.from.aadObjectId,
          ...(d.description ? { description: d.description } : {}),
          ...(d.ownerAadId
            ? { ownerAadId: d.ownerAadId }
            : { ownerAadId: activity.from.aadObjectId }),
          ...(d.deadlineAt ? { deadlineAt: d.deadlineAt } : {}),
          ...(isChannel && teamsChannelId
            ? { channelId: teamsChannelId }
            : { chatId: activity.conversation.id }),
        },
        "task_detect",
      );
    } catch (e) {
      log.warn("task_create_failed", { title: d.title, error: String(e) });
    }
  }
  log.info("tasks_detected", { count: actionable.length });
}

async function handleInvoke(
  env: Env,
  activity: Activity,
  log: Logger,
): Promise<Response> {
  const name = activity.name;
  const verb = activity.value?.action?.verb;
  log.info("invoke", { name, verb });

  // Only Adaptive Card Universal Actions are routed through verb
  // dispatch. Other invoke names (task/fetch, fileConsent/invoke, …)
  // can land in future commits.
  if (name && name !== "adaptiveCard/action") {
    log.info("invoke_unrouted", { name });
    return invokeResponse({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: { text: "" },
    });
  }

  const result = await dispatchInvoke(env, activity as InvokeActivity, log);
  return invokeResponse(result);
}

function invokeResponse(body: {
  statusCode: number;
  type: string;
  value: unknown;
}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleConversationUpdate(
  env: Env,
  activity: Activity,
  log: Logger,
): Promise<void> {
  const teamId =
    activity.channelData?.team?.id ?? activity.channelData?.teamsTeamId;
  const channelId =
    activity.channelData?.channel?.id ?? activity.channelData?.teamsChannelId;
  const tenantId =
    activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
  if (!teamId || !channelId || !tenantId) return;

  const now = new Date().toISOString();
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO channels (
       channel_id, team_id, tenant_id, service_url, conversation_id,
       display_name, enabled, registered_at, last_seen_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 1,
       COALESCE((SELECT registered_at FROM channels WHERE channel_id = ?), ?),
       ?)`,
  )
    .bind(
      channelId,
      teamId,
      tenantId,
      activity.serviceUrl,
      activity.conversation.id,
      null,
      channelId,
      now,
      now,
    )
    .run();

  log.info("channel_registered", { teamId, channelId, tenantId });
}

async function replyToActivity(
  env: Env,
  activity: Activity,
  text: string,
  log: Logger,
): Promise<void> {
  const token = await acquireBotToken(env);
  const base = activity.serviceUrl.replace(/\/$/, "");
  const url = `${base}/v3/conversations/${activity.conversation.id}/activities/${activity.id ?? ""}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "message",
      from: activity.recipient,
      conversation: activity.conversation,
      recipient: activity.from,
      text,
      replyToId: activity.id,
    }),
  });

  if (!res.ok) {
    log.error("reply_failed", {
      status: res.status,
      body: (await res.text()).slice(0, 200),
    });
  }
}

function stripBotMention(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}
