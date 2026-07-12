// MCP tool registry. Each tool declares its name, description, JSON
// schema, and an async handler. Tools that depend on modules not yet
// shipped are wired as stubs that throw; they appear in tools/list so
// clients can see Arcadia's full capability surface, and they fail
// loudly when called.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { listChannelReplies } from "../graph/messages";
import { MemoryStore } from "../memory/store";
import type { Kind, Scope } from "../memory/types";
import { ProfileStore } from "../memory/profiles";
import { ResourceAcl } from "../acl/resource-acl";
import {
  executeAction,
  type ActionScope,
  type ExecuteOutcome,
} from "../actions/framework";
import { assignTaskVerb, verbs } from "../actions/verbs/index";
import { confirmAction, type ConfirmDecision } from "../actions/confirm";
import { RoutineStore } from "../routines/store";

export interface ToolContext {
  env: Env;
  ctx: ExecutionContext;
  log: Logger;
  /**
   * Verified caller identity, derived server-side by handleMcp from the
   * sealed session cookie or a verified Entra bearer token. Tools MUST
   * scope their reads to this identity — never to a caller-supplied
   * viewer parameter.
   */
  caller: { aadId: string; tenantId: string; isAdmin: boolean };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const summarizeThread: Tool = {
  name: "summarize_thread",
  description:
    "Summarise a Teams channel thread in 3–6 bullets. Captures decisions, open questions, and named owners.",
  inputSchema: {
    type: "object",
    properties: {
      team_id: { type: "string" },
      channel_id: { type: "string" },
      message_id: { type: "string" },
      max_bullets: { type: "number", default: 6 },
    },
    required: ["team_id", "channel_id", "message_id"],
  },
  handler: async (ctx, args) => {
    const teamId = String(args.team_id);
    const channelId = String(args.channel_id);
    const messageId = String(args.message_id);
    const maxBullets = Number(args.max_bullets ?? 6);

    // Per-channel ACL check (P2): admins recall tenant-wide; every other
    // caller must hold a derived grant on the channel scope. The AclContext
    // is built exactly like filterAccessible callers (viewerAadId + tenantId);
    // group membership is consulted inside canAccess against resource_acl.
    if (!ctx.caller.isAdmin) {
      const acl = new ResourceAcl(ctx.env);
      const allowed = await acl.canAccess("channel", channelId, {
        viewerAadId: ctx.caller.aadId,
        tenantId: ctx.caller.tenantId,
      });
      if (!allowed) {
        throw new Error(`access_denied: no ACL grant for channel ${channelId}`);
      }
    }

    const replies = await listChannelReplies(
      ctx.env,
      teamId,
      channelId,
      messageId,
      { top: 100 },
    );
    const transcript = replies.value
      .map((m) => {
        const name = m.from?.user?.displayName ?? "unknown";
        const text =
          m.body.contentType === "html"
            ? m.body.content.replace(/<[^>]*>/g, "")
            : m.body.content;
        return `${name}: ${text}`;
      })
      .join("\n");

    const router = new Router(ctx.env);
    const result = await router.complete({
      system: `You are Arcadia. Summarise the following thread in up to ${maxBullets} concise bullets. Each bullet should capture either a decision, an open question, or a named owner. Be specific. Avoid filler.`,
      messages: [{ role: "user", content: transcript }],
      maxTokens: 600,
    });

    return { summary: result.text, model: result.model, tier: result.tier };
  },
};

const recallMemory: Tool = {
  name: "recall_memory",
  description:
    "Search Arcadia's memory across the four cognitive layers (episodic, semantic, procedural, observation). Returns top semantic matches, score-ranked.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      kind: {
        type: "string",
        enum: ["episodic", "semantic", "procedural", "observation"],
      },
      scope_type: { type: "string" },
      scope_id: { type: "string" },
      limit: { type: "number", default: 10 },
    },
    required: ["query"],
  },
  handler: async (ctx, args) => {
    const store = new MemoryStore(ctx.env);
    // Viewer is always the verified caller — never a caller-supplied id.
    // Admins recall tenant-wide (no viewer filter); everyone else is
    // strictly ACL-scoped to their own identity.
    const hits = await store.recall(String(args.query), {
      limit: Number(args.limit ?? 10),
      ...(args.kind ? { kind: args.kind as Kind } : {}),
      ...(args.scope_type ? { scopeType: args.scope_type as Scope } : {}),
      ...(args.scope_id ? { scopeId: String(args.scope_id) } : {}),
      ...(ctx.caller.isAdmin
        ? {}
        : {
            viewer: ctx.caller.aadId,
            tenantId: ctx.caller.tenantId,
            strict: true,
          }),
    });
    return hits.map((h) => ({
      id: h.memory.id,
      kind: h.memory.kind,
      content: h.memory.content,
      score: h.score,
      occurred_at: h.memory.occurredAt,
      confidence: h.memory.confidence,
    }));
  },
};

const draftMessage: Tool = {
  name: "draft_message",
  description:
    "Draft a Teams message in Arcadia's voice given an intent and optional tone hint. Returns plain text suitable for posting.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "What the message needs to communicate.",
      },
      tone: {
        type: "string",
        enum: ["neutral", "warm", "urgent", "celebratory"],
        default: "neutral",
      },
      audience: {
        type: "string",
        description: "Who the message is to.",
      },
      max_words: { type: "number", default: 80 },
    },
    required: ["intent"],
  },
  handler: async (ctx, args) => {
    const router = new Router(ctx.env);
    const tone = String(args.tone ?? "neutral");
    const audience = args.audience ? `Audience: ${args.audience}. ` : "";
    const result = await router.complete({
      system: `You are Arcadia drafting a Teams message. Keep it under ${Number(args.max_words ?? 80)} words. Direct. No filler. Match this tone: ${tone}. ${audience}Do not invent facts.`,
      messages: [{ role: "user", content: String(args.intent) }],
      maxTokens: 400,
    });
    return { draft: result.text, model: result.model };
  },
};

const findOwner: Tool = {
  name: "find_owner",
  description:
    "Find the most likely owner of a topic by consulting Arcadia's memory of past ownership signals.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      channel_id: { type: "string" },
      limit: { type: "number", default: 3 },
    },
    required: ["topic"],
  },
  handler: async (ctx, args) => {
    const store = new MemoryStore(ctx.env);
    // ACL-scope recall to the verified caller (admins recall tenant-wide).
    const hits = await store.recall(`owner: ${args.topic}`, {
      kind: ["observation", "semantic"],
      limit: Number(args.limit ?? 3),
      ...(args.channel_id
        ? {
            scopeType: "channel" as const,
            scopeId: String(args.channel_id),
          }
        : {}),
      ...(ctx.caller.isAdmin
        ? {}
        : {
            viewer: ctx.caller.aadId,
            tenantId: ctx.caller.tenantId,
            strict: true,
          }),
    });
    // Non-admins get owner identity only; the raw memory rationale (which
    // can leak third-party behavioral content) is admin-gated.
    return {
      candidates: hits
        .filter((h) => h.memory.subjectAadId)
        .map((h) => ({
          aad_id: h.memory.subjectAadId,
          score: h.score,
          ...(ctx.caller.isAdmin ? { rationale: h.memory.content } : {}),
        })),
    };
  },
};

const listStaleThreads: Tool = {
  name: "list_stale_threads",
  description:
    "List threads that have gone silent past their staleness threshold. Useful before posting a digest or running the nudge engine.",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: { type: "string" },
      since: {
        type: "string",
        description: "ISO timestamp — threads with no activity since.",
      },
      limit: { type: "number", default: 20 },
    },
  },
  handler: async (ctx, args) => {
    const limit = Number(args.limit ?? 20);
    const channelId = args.channel_id as string | undefined;
    const since = args.since as string | undefined;
    const stmt = channelId
      ? ctx.env.ARCADIA_DB.prepare(
          `SELECT * FROM threads
             WHERE channel_id = ?
               AND stale_at IS NOT NULL
               AND (? IS NULL OR last_activity_at < ?)
             ORDER BY last_activity_at ASC
             LIMIT ?`,
        ).bind(channelId, since ?? null, since ?? null, limit)
      : ctx.env.ARCADIA_DB.prepare(
          `SELECT * FROM threads
             WHERE stale_at IS NOT NULL
               AND (? IS NULL OR last_activity_at < ?)
             ORDER BY last_activity_at ASC
             LIMIT ?`,
        ).bind(since ?? null, since ?? null, limit);
    const rows = await stmt.all<{ channel_id: string }>();

    // Admins see every stale thread; everyone else is trimmed to the
    // channels they can access via derived ACL grants (P2).
    if (ctx.caller.isAdmin) return { threads: rows.results };

    const acl = new ResourceAcl(ctx.env);
    const distinct = [
      ...new Set(rows.results.map((r) => r.channel_id)),
    ].map((id) => ({ resourceType: "channel", resourceId: id }));
    const allowed = await acl.filterAccessible(distinct, {
      viewerAadId: ctx.caller.aadId,
      tenantId: ctx.caller.tenantId,
    });
    const allowedIds = new Set(allowed.map((a) => a.resourceId));
    return {
      threads: rows.results.filter((r) => allowedIds.has(r.channel_id)),
    };
  },
};

const queryCustomer: Tool = {
  name: "query_customer",
  description:
    "Look up a customer profile — contacts, recurring topics, sentiment, and recent context — built passively from the work already happening.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Customer / organisation name.",
      },
    },
    required: ["name"],
  },
  handler: async (ctx, args) => {
    // Accept `name` (canonical) and fall back to the legacy `id_or_name`.
    const name = String(args.name ?? args.id_or_name ?? "").trim();
    if (!name) throw new Error("query_customer: name is required");

    // Viewer is always the verified caller. getCustomerProfile applies the
    // normal ACL gate (admins bypass; others need a grant on the customer
    // scope) and returns null when not entitled or no profile exists yet.
    const profile = await new ProfileStore(ctx.env).getCustomerProfile(name, {
      aadId: ctx.caller.aadId,
      tenantId: ctx.caller.tenantId,
      isAdmin: ctx.caller.isAdmin,
    });

    if (!profile) {
      return { found: false, message: `No profile yet for "${name}".` };
    }
    return { found: true, profile };
  },
};

// A verb invocation returns its ladder outcome verbatim. A 'confirm'-level
// verb surfaces { status: "awaiting_confirmation", actionId } so the MCP
// client can round-trip a human confirmation (confirm_action) instead of
// the tool silently executing. An 'observe' verb surfaces
// { status: "rejected" } and never runs.
function outcomeView(o: ExecuteOutcome): Record<string, unknown> {
  return {
    status: o.status,
    action_id: o.actionId,
    level: o.level,
    description: o.description,
    ...(o.result ? { result: o.result } : {}),
  };
}

/** Build an ActionScope from a client-supplied { type, id }, else null. */
function parseScope(raw: unknown): ActionScope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  const id = o.id;
  const types = ["tenant", "channel", "chat", "user", "client"] as const;
  if (
    typeof type !== "string" ||
    !(types as readonly string[]).includes(type) ||
    typeof id !== "string" ||
    !id
  ) {
    return null;
  }
  return { type: type as ActionScope["type"], id };
}

const assignTask: Tool = {
  name: "assign_task",
  description:
    "Set or replace a task's owner. Routed through the action ladder — a 'confirm' policy returns awaiting_confirmation + an action_id for a human to confirm, rather than assigning silently.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      owner_aad_id: { type: "string" },
      channel_id: {
        type: "string",
        description:
          "Scope the ladder decision to this channel; defaults to the caller's user scope.",
      },
    },
    required: ["task_id", "owner_aad_id"],
  },
  handler: async (ctx, args) => {
    const taskId = String(args.task_id ?? "").trim();
    const ownerAadId = String(args.owner_aad_id ?? "").trim();
    if (!taskId) throw new Error("assign_task: task_id is required");
    if (!ownerAadId) throw new Error("assign_task: owner_aad_id is required");

    const channelId =
      typeof args.channel_id === "string" && args.channel_id
        ? args.channel_id
        : undefined;
    const scope: ActionScope = channelId
      ? { type: "channel", id: channelId }
      : { type: "user", id: ctx.caller.aadId };

    const outcome = await executeAction(
      { env: ctx.env, log: ctx.log, actorAadId: ctx.caller.aadId },
      assignTaskVerb,
      scope,
      { taskId, ownerAadId },
    );
    return outcomeView(outcome);
  },
};

const performAction: Tool = {
  name: "perform_action",
  description:
    "General autonomy entry point: invoke a named action verb through the ladder. The ladder still gates every call — an 'observe'/'confirm' verb will not execute, it returns rejected / awaiting_confirmation. Use confirm_action to complete a confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      verb: {
        type: "string",
        description:
          "One of the registered action verbs (draft_message, send_message, send_mail, schedule_meeting, create_task, assign_task, complete_task).",
      },
      params: {
        type: "object",
        description: "Verb-specific parameters.",
      },
      scope: {
        type: "object",
        description: "Scope for the ladder decision: { type, id }.",
        properties: {
          type: {
            type: "string",
            enum: ["tenant", "channel", "chat", "user", "client"],
          },
          id: { type: "string" },
        },
        required: ["type", "id"],
      },
      idempotency_key: { type: "string" },
    },
    required: ["verb", "params"],
  },
  handler: async (ctx, args) => {
    const verbName = String(args.verb ?? "").trim();
    const verb = verbs[verbName];
    if (!verb) throw new Error(`perform_action: unknown verb "${verbName}"`);

    // Client-supplied scope, or default to the caller's own user scope.
    const scope = parseScope(args.scope) ?? {
      type: "user" as const,
      id: ctx.caller.aadId,
    };

    const idempotencyKey =
      typeof args.idempotency_key === "string" && args.idempotency_key
        ? args.idempotency_key
        : undefined;

    const outcome = await executeAction(
      { env: ctx.env, log: ctx.log, actorAadId: ctx.caller.aadId },
      verb,
      scope,
      args.params ?? {},
      idempotencyKey ? { idempotencyKey } : {},
    );
    return outcomeView(outcome);
  },
};

const confirmActionTool: Tool = {
  name: "confirm_action",
  description:
    "Approve or reject an action that is awaiting confirmation (as returned by perform_action / assign_task). Only the original actor or an admin may confirm.",
  inputSchema: {
    type: "object",
    properties: {
      action_id: { type: "string" },
      decision: { type: "string", enum: ["approve", "reject"] },
    },
    required: ["action_id", "decision"],
  },
  handler: async (ctx, args) => {
    const actionId = String(args.action_id ?? "").trim();
    const decision = String(args.decision ?? "");
    if (!actionId) throw new Error("confirm_action: action_id is required");
    if (decision !== "approve" && decision !== "reject") {
      throw new Error("confirm_action: decision must be approve or reject");
    }

    // Only the original actor (or an admin) may confirm an action.
    if (!ctx.caller.isAdmin) {
      const row = await ctx.env.ARCADIA_DB.prepare(
        `SELECT actor_aad_id FROM action_log WHERE id = ? LIMIT 1`,
      )
        .bind(actionId)
        .first<{ actor_aad_id: string }>();
      if (!row) throw new Error(`confirm_action: unknown action ${actionId}`);
      if (row.actor_aad_id !== ctx.caller.aadId) {
        throw new Error(
          `access_denied: only the original actor or an admin may confirm ${actionId}`,
        );
      }
    }

    const outcome = await confirmAction(
      ctx.env,
      ctx.log,
      actionId,
      ctx.caller.aadId,
      decision as ConfirmDecision,
    );
    return outcomeView(outcome);
  },
};

const queryRoutines: Tool = {
  name: "query_routines",
  description:
    "List routines for the caller (or, for admins, a specified owner). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      owner_aad_id: {
        type: "string",
        description: "Admin-only: list another owner's routines.",
      },
      enabled_only: { type: "boolean", default: false },
    },
  },
  handler: async (ctx, args) => {
    // Non-admins are restricted to their own routines; only an admin may
    // name another owner.
    const requested =
      typeof args.owner_aad_id === "string" && args.owner_aad_id
        ? args.owner_aad_id
        : undefined;
    const owner =
      ctx.caller.isAdmin && requested ? requested : ctx.caller.aadId;
    const enabledOnly = args.enabled_only === true;

    const store = new RoutineStore(ctx.env);
    const routines = await store.listByOwner(owner, enabledOnly);
    return {
      owner,
      routines: routines.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        trigger: r.trigger,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        ...(r.description ? { description: r.description } : {}),
      })),
    };
  },
};

export const tools: Tool[] = [
  summarizeThread,
  recallMemory,
  draftMessage,
  findOwner,
  listStaleThreads,
  queryCustomer,
  assignTask,
  performAction,
  confirmActionTool,
  queryRoutines,
];
