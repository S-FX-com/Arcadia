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
    // Thread summarization crosses channel boundaries; until per-channel
    // ACL derivation lands (P2), restrict to admin callers.
    if (!ctx.caller.isAdmin) {
      throw new Error("admin_required (channel ACL derivation lands in P2)");
    }
    const teamId = String(args.team_id);
    const channelId = String(args.channel_id);
    const messageId = String(args.message_id);
    const maxBullets = Number(args.max_bullets ?? 6);

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
    // Cross-channel staleness view; restrict to admins until per-channel
    // ACL derivation lands (P2).
    if (!ctx.caller.isAdmin) {
      throw new Error("admin_required (channel ACL derivation lands in P2)");
    }
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
    const rows = await stmt.all();
    return { threads: rows.results };
  },
};

const stub = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Tool => ({
  name,
  description,
  inputSchema,
  handler: async () => {
    throw new Error(`${name}: not implemented yet`);
  },
});

const queryCustomer = stub(
  "query_customer",
  "Look up a customer profile (Arcadia's client index entry) by id or name. Lands with the customer index module.",
  {
    type: "object",
    properties: { id_or_name: { type: "string" } },
    required: ["id_or_name"],
  },
);

const assignTask = stub(
  "assign_task",
  "Create a task and assign an owner. Optionally syncs to Microsoft Planner. Lands with the tasks module.",
  {
    type: "object",
    properties: {
      channel_id: { type: "string" },
      title: { type: "string" },
      owner_aad_id: { type: "string" },
      deadline_at: { type: "string" },
      priority: {
        type: "string",
        enum: ["low", "normal", "high", "urgent"],
      },
      description: { type: "string" },
    },
    required: ["title"],
  },
);

const queryRoutines = stub(
  "query_routines",
  "List routines for the operator or a specific owner. Lands with the routines module.",
  {
    type: "object",
    properties: {
      owner_aad_id: { type: "string" },
      enabled_only: { type: "boolean", default: true },
    },
  },
);

export const tools: Tool[] = [
  summarizeThread,
  recallMemory,
  draftMessage,
  findOwner,
  listStaleThreads,
  queryCustomer,
  assignTask,
  queryRoutines,
];
