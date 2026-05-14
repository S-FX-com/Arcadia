// Zod schemas for routine specs.
//
// A routine is a small declarative workflow: a trigger ("when") plus
// an ordered list of steps ("what to do"). The executor runs steps
// sequentially, storing each step's result in a context map under its
// `as` key, and supports a tiny {{var}} template in string fields so a
// later step can consume an earlier one's output.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const cronTrigger = z.object({
  kind: z.literal("cron"),
  /** Five-field cron, matched verbatim against ScheduledEvent.cron. */
  cron: z.string().min(1),
});

export const eventTrigger = z.object({
  kind: z.literal("event"),
  /** Graph resource that fires this routine, e.g. /me/messages. */
  resource: z.string().min(1),
  /** Optional change-type filter. */
  changeType: z
    .enum(["created", "updated", "deleted"])
    .optional(),
});

export const manualTrigger = z.object({
  kind: z.literal("manual"),
});

export const trigger = z.discriminatedUnion("kind", [
  cronTrigger,
  eventTrigger,
  manualTrigger,
]);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const recallStep = z.object({
  kind: z.literal("recall_memory"),
  query: z.string(),
  scopeType: z
    .enum(["tenant", "channel", "chat", "user", "project", "customer"])
    .optional(),
  scopeId: z.string().optional(),
  memoryKind: z
    .enum(["episodic", "semantic", "procedural", "observation"])
    .optional(),
  limit: z.number().int().positive().max(50).optional(),
  as: z.string().min(1),
});

const aiCompleteStep = z.object({
  kind: z.literal("ai_complete"),
  system: z.string().optional(),
  prompt: z.string(),
  tier: z.enum(["fast", "balanced", "deep"]).optional(),
  maxTokens: z.number().int().positive().max(4000).optional(),
  as: z.string().min(1),
});

const toolCallStep = z.object({
  kind: z.literal("tool_call"),
  tool: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  as: z.string().min(1).optional(),
});

const postTextStep = z.object({
  kind: z.literal("post_text"),
  serviceUrl: z.string().min(1),
  conversationId: z.string().min(1),
  text: z.string(),
});

const createTaskStep = z.object({
  kind: z.literal("create_task"),
  title: z.string(),
  description: z.string().optional(),
  ownerAadId: z.string().optional(),
  channelId: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  deadlineAt: z.string().optional(),
  as: z.string().min(1).optional(),
});

export const step = z.discriminatedUnion("kind", [
  recallStep,
  aiCompleteStep,
  toolCallStep,
  postTextStep,
  createTaskStep,
]);

// ---------------------------------------------------------------------------
// Routine
// ---------------------------------------------------------------------------

export const routineDef = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger,
  steps: z.array(step).min(1).max(20),
});

export type Trigger = z.infer<typeof trigger>;
export type Step = z.infer<typeof step>;
export type RoutineDef = z.infer<typeof routineDef>;

export function parseDefinition(input: unknown): RoutineDef {
  return routineDef.parse(input);
}

export function safeParseDefinition(
  input: unknown,
): { ok: true; data: RoutineDef } | { ok: false; error: string } {
  const result = routineDef.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; "),
  };
}

// Tiny mustache-style template — replaces {{name}} or {{path.with.dots}}
// with the corresponding value from ctx, stringified. Unknown vars
// pass through unchanged.
export function applyTemplate(
  s: string,
  ctx: Record<string, unknown>,
): string {
  return s.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = lookup(ctx, String(key));
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
