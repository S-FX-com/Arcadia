// Universal Action card → verb dispatch.
//
// Card invoke activities arrive at /api/messages with shape:
//   activity.type = "invoke"
//   activity.name = "adaptiveCard/action"
//   activity.value.action.verb = <Verb>
//   activity.value.action.data = { ... }     // card author-supplied
//                                            // plus any Input.* values
//
// The dispatcher routes by verb. Each handler:
//   1. validates required data
//   2. mutates D1 (tasks / ownership_history / feedback / memories)
//   3. returns an InvokeResponse with either a re-rendered card
//      (vnd.microsoft.card.adaptive) or a short toast
//      (vnd.microsoft.activity.message)
//
// The HTTP layer wraps the InvokeResponse in a 200 JSON body — this
// is the Adaptive Card Universal Action response envelope; Teams reads
// the inner `type` + `value` to decide whether to swap the card body
// or surface a toast.
//
// Strict ACL lands with src/acl/* in a later commit. For now the
// handlers trust that the viewer (activity.from.aadObjectId) can see
// the resource — the card refresh block already filters who can see
// the card in the first place.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { config } from "../lib/config";
import { MemoryStore } from "../memory/store";
import { TaskStore } from "../tasks/store";
import type { Task } from "../tasks/types";
import {
  acknowledgementCard,
  taskCard,
  taskReassignPickerCard,
  type TaskInput,
  type TaskReassignPickerInput,
} from "../cards/task";
import { digestCard, type DigestSection } from "../cards/digest";
import type { AdaptiveCard, Verb } from "../cards/types";
import { confirmAction, type ConfirmDecision } from "../actions/confirm";

export interface InvokeActivity {
  id?: string;
  type: string;
  name?: string;
  serviceUrl?: string;
  conversation: { id: string; tenantId?: string };
  from?: { id?: string; aadObjectId?: string; name?: string };
  value?: {
    action?: {
      type?: string;
      verb?: Verb;
      data?: Record<string, unknown>;
    };
  };
  channelData?: { tenant?: { id?: string } };
}

export type InvokeResponse =
  | {
      statusCode: 200;
      type: "application/vnd.microsoft.card.adaptive";
      value: AdaptiveCard;
    }
  | {
      statusCode: number;
      type: "application/vnd.microsoft.activity.message";
      value: { text: string };
    };

const SURFACE_TASK = "task_card";
const SURFACE_DIGEST = "digest_card";
const SURFACE_NUDGE = "nudge_card";
const SURFACE_MEMORY = "memory";
const SURFACE_GENERIC = "generic";

export async function dispatchInvoke(
  env: Env,
  activity: InvokeActivity,
  log: Logger,
): Promise<InvokeResponse> {
  const action = activity.value?.action;
  const verb = action?.verb;
  const data = action?.data ?? {};
  const viewer = activity.from?.aadObjectId;
  const tenantId =
    activity.channelData?.tenant?.id ?? activity.conversation.tenantId;

  if (!verb) {
    log.warn("invoke_missing_verb", {});
    return toast(400, "Missing action verb.");
  }
  if (!viewer) {
    log.warn("invoke_missing_identity", { verb });
    return toast(401, "Identity required for card actions.");
  }

  log.info("invoke_dispatch", {
    verb,
    viewer,
    conversationId: activity.conversation.id,
  });

  try {
    switch (verb) {
      case "digest_refresh":
        return await digestRefresh(env, data, viewer);
      case "digest_dismiss":
        return await digestDismiss(env, data, viewer);
      case "task_accept":
        return await taskAccept(env, data, viewer);
      case "task_reassign":
        return await taskReassign(env, data, viewer, tenantId);
      case "task_reassign_submit":
        return await taskReassignSubmit(env, data, viewer);
      case "task_complete":
        return await taskComplete(env, data, viewer);
      case "task_snooze":
        return await taskSnooze(env, data, viewer);
      case "nudge_acknowledge":
        return await nudgeAcknowledge(env, data, viewer);
      case "nudge_snooze":
        return await nudgeSnooze(env, data, viewer);
      case "memory_correct":
        return await memoryCorrect(env, data, viewer);
      case "feedback":
        return await feedback(env, data, viewer);
      case "action_confirm":
        return await actionDecision(env, data, viewer, "approve", log);
      case "action_reject":
        return await actionDecision(env, data, viewer, "reject", log);
      default: {
        const _exhaustive: never = verb;
        log.warn("invoke_unknown_verb", { verb: String(_exhaustive) });
        return toast(200, "Unknown action.");
      }
    }
  } catch (e) {
    log.error("invoke_handler_failed", { verb, error: String(e) });
    return toast(200, "Something went wrong handling that action.");
  }
}

// ===========================================================================
// Digest
// ===========================================================================

interface DigestRow {
  id: string;
  channel_id: string;
  body: string;
  message_id: string | null;
  posted_at: string;
}

interface DigestBody {
  channelDisplayName?: string;
  sections?: DigestSection[];
  followUpUrl?: string;
}

async function digestRefresh(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const digestId = strField(data, "digestId");
  if (!digestId) return toast(400, "Missing digestId.");

  const row = await env.ARCADIA_DB.prepare(
    `SELECT id, channel_id, body, message_id, posted_at
       FROM digests WHERE id = ?`,
  )
    .bind(digestId)
    .first<DigestRow>();
  if (!row) {
    return cardResponse(
      acknowledgementCard({
        title: "Digest unavailable",
        body: "This digest is no longer available.",
      }),
    );
  }

  let parsed: DigestBody = {};
  try {
    parsed = JSON.parse(row.body) as DigestBody;
  } catch {
    parsed = {};
  }

  const channelName =
    parsed.channelDisplayName ??
    (await channelDisplayName(env, row.channel_id)) ??
    "Channel";

  return cardResponse(
    digestCard({
      digestId: row.id,
      channelDisplayName: channelName,
      generatedAt: row.posted_at,
      viewerAadIds: [viewer],
      sections: parsed.sections ?? [],
      ...(parsed.followUpUrl ? { followUpUrl: parsed.followUpUrl } : {}),
    }),
  );
}

async function digestDismiss(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const digestId = strField(data, "digestId");
  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_DIGEST,
    targetKind: "digest",
    targetId: digestId ?? null,
    signal: "negative",
    note: "dismissed",
  });

  return cardResponse(
    acknowledgementCard({
      title: "Dismissed",
      body: "I'll skip this digest for you.",
    }),
  );
}

// ===========================================================================
// Tasks
// ===========================================================================

async function userDisplayName(
  env: Env,
  aadId: string | null | undefined,
): Promise<string | undefined> {
  if (!aadId) return undefined;
  const row = await env.ARCADIA_DB.prepare(
    `SELECT display_name FROM users WHERE aad_id = ?`,
  )
    .bind(aadId)
    .first<{ display_name: string | null }>();
  return row?.display_name ?? undefined;
}

async function channelDisplayName(
  env: Env,
  channelId: string,
): Promise<string | undefined> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT display_name FROM channels WHERE channel_id = ?`,
  )
    .bind(channelId)
    .first<{ display_name: string | null }>();
  return row?.display_name ?? undefined;
}

async function renderTaskCard(
  env: Env,
  task: Task,
  viewer: string,
): Promise<AdaptiveCard> {
  const ownerName = await userDisplayName(env, task.ownerAadId ?? null);
  const input: TaskInput = {
    taskId: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    viewerAadIds: [viewer],
    ...(task.description ? { description: task.description } : {}),
    ...(ownerName ? { ownerDisplayName: ownerName } : {}),
    ...(task.ownerAadId ? { ownerAadId: task.ownerAadId } : {}),
    ...(task.deadlineAt ? { deadlineAt: task.deadlineAt } : {}),
  };
  return taskCard(input);
}

async function taskAccept(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const taskId = strField(data, "taskId");
  if (!taskId) return toast(400, "Missing taskId.");

  const store = new TaskStore(env);
  const task = await store.byId(taskId);
  if (!task) return toast(404, "I can't find that task.");

  if (task.ownerAadId !== viewer) {
    await store.assign(taskId, viewer, "self-accept via card", "card_action");
  }
  if (task.status === "open") {
    await store.update(taskId, { status: "in_progress" }, "card_action");
  }

  const fresh = await store.byId(taskId);
  if (!fresh) return toast(500, "Lost track of that task after accepting.");
  return cardResponse(await renderTaskCard(env, fresh, viewer));
}

async function taskReassign(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
  tenantId: string | undefined,
): Promise<InvokeResponse> {
  const taskId = strField(data, "taskId");
  if (!taskId) return toast(400, "Missing taskId.");

  const store = new TaskStore(env);
  const task = await store.byId(taskId);
  if (!task) return toast(404, "I can't find that task.");

  const currentOwnerName = await userDisplayName(env, task.ownerAadId ?? null);
  const candidates = await reassignCandidates(
    env,
    tenantId,
    viewer,
    task.ownerAadId ?? null,
  );

  const input: TaskReassignPickerInput = {
    taskId: task.id,
    title: task.title,
    candidates,
    viewerAadIds: [viewer],
    ...(currentOwnerName
      ? { currentOwnerDisplayName: currentOwnerName }
      : {}),
  };
  return cardResponse(taskReassignPickerCard(input));
}

async function reassignCandidates(
  env: Env,
  tenantId: string | undefined,
  viewer: string,
  currentOwner: string | null,
): Promise<{ aadId: string; displayName: string }[]> {
  const exclude = new Set<string>();
  exclude.add(viewer);
  if (currentOwner) exclude.add(currentOwner);

  const rows = tenantId
    ? await env.ARCADIA_DB.prepare(
        `SELECT aad_id, display_name FROM users
          WHERE tenant_id = ?
          ORDER BY COALESCE(last_seen_at, registered_at) DESC
          LIMIT 25`,
      )
        .bind(tenantId)
        .all<{ aad_id: string; display_name: string | null }>()
    : await env.ARCADIA_DB.prepare(
        `SELECT aad_id, display_name FROM users
          ORDER BY COALESCE(last_seen_at, registered_at) DESC
          LIMIT 25`,
      ).all<{ aad_id: string; display_name: string | null }>();

  return rows.results
    .filter((r) => !exclude.has(r.aad_id))
    .map((r) => ({
      aadId: r.aad_id,
      displayName: r.display_name ?? r.aad_id,
    }));
}

async function taskReassignSubmit(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const taskId = strField(data, "taskId");
  const targetAadId = strField(data, "targetAadId");
  const reason = strField(data, "reason");
  if (!taskId) return toast(400, "Missing taskId.");
  if (!targetAadId)
    return toast(400, "Pick someone to reassign this task to.");

  const store = new TaskStore(env);
  const task = await store.byId(taskId);
  if (!task) return toast(404, "I can't find that task.");

  await store.assign(
    taskId,
    targetAadId,
    reason ?? "reassigned via card",
    "card_action",
  );

  const fresh = await store.byId(taskId);
  if (!fresh) return toast(500, "Lost track of that task after reassign.");
  return cardResponse(await renderTaskCard(env, fresh, viewer));
}

async function taskComplete(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const taskId = strField(data, "taskId");
  if (!taskId) return toast(400, "Missing taskId.");

  const store = new TaskStore(env);
  const fresh = await store.complete(taskId, "card_action");
  if (!fresh) return toast(404, "I can't find that task.");

  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_TASK,
    targetKind: "task",
    targetId: taskId,
    signal: "positive",
    note: "completed",
  });

  return cardResponse(await renderTaskCard(env, fresh, viewer));
}

async function taskSnooze(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const taskId = strField(data, "taskId");
  if (!taskId) return toast(400, "Missing taskId.");

  const store = new TaskStore(env);
  const fresh = await store.snooze(taskId);
  if (!fresh) return toast(404, "I can't find that task.");

  const cooldown = config(env).nudgeCooldownHours;
  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_TASK,
    targetKind: "task",
    targetId: taskId,
    signal: "negative",
    note: `snoozed_${cooldown}h`,
  });

  return cardResponse(await renderTaskCard(env, fresh, viewer));
}

// ===========================================================================
// Nudges
// ===========================================================================

async function nudgeAcknowledge(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const nudgeId = strField(data, "nudgeId");
  const taskId = strField(data, "taskId");

  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_NUDGE,
    targetKind: "nudge",
    targetId: nudgeId ?? null,
    signal: "positive",
    note: "acknowledged",
  });

  if (taskId) {
    const store = new TaskStore(env);
    const task = await store.byId(taskId);
    if (task) {
      if (task.status === "open") {
        await store.update(taskId, { status: "in_progress" }, "card_action");
      }
      await store.snooze(taskId);
    }
  }

  return cardResponse(
    acknowledgementCard({
      title: "On it",
      body: "Got it — I'll back off.",
    }),
  );
}

async function nudgeSnooze(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const nudgeId = strField(data, "nudgeId");
  const taskId = strField(data, "taskId");

  if (taskId) {
    const store = new TaskStore(env);
    await store.snooze(taskId);
  }

  const cooldown = config(env).nudgeCooldownHours;
  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_NUDGE,
    targetKind: "nudge",
    targetId: nudgeId ?? null,
    signal: "negative",
    note: `snoozed_${cooldown}h`,
  });

  return cardResponse(
    acknowledgementCard({
      title: "Snoozed",
      body: `I'll come back to this in about ${cooldown}h.`,
    }),
  );
}

// ===========================================================================
// Memory + feedback
// ===========================================================================

async function memoryCorrect(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const memoryId = strField(data, "memoryId");
  const correction = strField(data, "correction");
  if (!memoryId) return toast(400, "Missing memoryId.");

  const store = new MemoryStore(env);
  const mem = await store.byId(memoryId);
  if (!mem) return toast(404, "I can't find that memory.");

  await writeFeedback(env, {
    userAadId: viewer,
    surface: SURFACE_MEMORY,
    targetKind: "memory",
    targetId: memoryId,
    signal: "correction",
    note: correction ?? null,
  });

  // Soft-delete: future recalls will skip this row.
  await store.forget(memoryId);

  return cardResponse(
    acknowledgementCard({
      title: "Noted",
      body: "I've retired that memory and recorded the correction.",
    }),
  );
}

async function feedback(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
): Promise<InvokeResponse> {
  const signal = strField(data, "signal");
  if (
    signal !== "positive" &&
    signal !== "negative" &&
    signal !== "correction"
  ) {
    return toast(400, "Signal must be positive, negative, or correction.");
  }

  await writeFeedback(env, {
    userAadId: viewer,
    surface: strField(data, "surface") ?? SURFACE_GENERIC,
    targetKind: strField(data, "targetKind") ?? "unknown",
    targetId: strField(data, "targetId") ?? null,
    signal,
    note: strField(data, "note") ?? null,
  });

  return cardResponse(
    acknowledgementCard({
      title: "Thanks",
      body: "Logged your feedback.",
    }),
  );
}

// ===========================================================================
// Action confirmation
// ===========================================================================

// Human confirmation surface for 'confirm'-level actions. The invoking
// user (viewer) is the actor whose approval/rejection we record; the card
// carries the awaiting action_log id. confirmAction re-runs the ladder with
// confirmed:true (approve) or flips the row to 'rejected' (reject).
async function actionDecision(
  env: Env,
  data: Record<string, unknown>,
  viewer: string,
  decision: ConfirmDecision,
  log: Logger,
): Promise<InvokeResponse> {
  const actionId = strField(data, "actionId");
  if (!actionId) return toast(400, "Missing actionId.");

  const outcome = await confirmAction(env, log, actionId, viewer, decision);

  if (decision === "reject") {
    return cardResponse(
      acknowledgementCard({
        title: "Dismissed",
        body: "I won't take that action.",
      }),
    );
  }

  if (outcome.status === "executed") {
    return cardResponse(
      acknowledgementCard({
        title: "Done",
        body: outcome.description,
      }),
    );
  }

  // approved but did not execute (blocked, failed, already resolved, OBO…)
  const detail =
    outcome.result && !outcome.result.ok && outcome.result.error
      ? ` (${outcome.result.error})`
      : "";
  return cardResponse(
    acknowledgementCard({
      title: "Couldn't complete that",
      body: `Status: ${outcome.status}${detail}.`,
    }),
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

interface FeedbackInsert {
  userAadId: string;
  surface: string;
  targetKind: string;
  targetId: string | null;
  signal: "positive" | "negative" | "correction";
  note: string | null;
}

async function writeFeedback(
  env: Env,
  input: FeedbackInsert,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO feedback (user_aad_id, surface, target_kind, target_id, signal, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.userAadId,
      input.surface,
      input.targetKind,
      input.targetId,
      input.signal,
      input.note,
    )
    .run();
}

function strField(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function cardResponse(card: AdaptiveCard): InvokeResponse {
  return {
    statusCode: 200,
    type: "application/vnd.microsoft.card.adaptive",
    value: card,
  };
}

function toast(statusCode: number, text: string): InvokeResponse {
  return {
    statusCode,
    type: "application/vnd.microsoft.activity.message",
    value: { text },
  };
}
