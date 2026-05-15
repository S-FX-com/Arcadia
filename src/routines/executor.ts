// Step runner over Arcadia's tool registry + memory + AI router.
//
// `runRoutine(env, routine, triggerKind, log, ctx)` walks
// routine.definition.steps in order, threading a shared `context`
// object that each step reads from (via {{var}} templates and step
// kind-specific fields) and writes into (via the `as` key).
//
// A run row is created in `routine_runs` before the first step and
// stamped to succeeded/failed at the end. Per-step failures abort the
// run and propagate to the run row's `error` field.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { MemoryStore } from "../memory/store";
import { tools as mcpTools, type Tool } from "../mcp/tools";
import { TaskStore } from "../tasks/store";
import { postText } from "../runtime/bot-outbound";
import { applyTemplate, type Step } from "./definition";
import { RoutineStore, type RoutineRecord } from "./store";

export interface ExecutorOpts {
  /** Optional ExecutionContext for MCP tool handlers that need it. */
  ctx?: ExecutionContext;
}

export interface RunResult {
  routineId: string;
  runId: string;
  status: "succeeded" | "failed";
  output: Record<string, unknown>;
  error?: string;
}

export async function runRoutine(
  env: Env,
  routine: RoutineRecord,
  triggerKind: string,
  log: Logger,
  opts: ExecutorOpts = {},
): Promise<RunResult> {
  const store = new RoutineStore(env);
  const run = await store.startRun(routine.id, triggerKind);
  const context: Record<string, unknown> = {};

  try {
    for (let i = 0; i < routine.definition.steps.length; i += 1) {
      const step = routine.definition.steps[i]!;
      log.info("routine_step", {
        routineId: routine.id,
        runId: run.id,
        step: i,
        kind: step.kind,
      });
      const result = await runStep(env, step, context, log, opts);
      if (step.kind !== "post_text" && "as" in step && step.as) {
        context[step.as] = result;
      }
    }
    await store.finishRun(run.id, "succeeded", context);
    return {
      routineId: routine.id,
      runId: run.id,
      status: "succeeded",
      output: context,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("routine_failed", {
      routineId: routine.id,
      runId: run.id,
      error: message,
    });
    await store.finishRun(run.id, "failed", context, message);
    return {
      routineId: routine.id,
      runId: run.id,
      status: "failed",
      output: context,
      error: message,
    };
  }
}

async function runStep(
  env: Env,
  step: Step,
  context: Record<string, unknown>,
  log: Logger,
  opts: ExecutorOpts,
): Promise<unknown> {
  switch (step.kind) {
    case "recall_memory":
      return runRecall(env, step, context);
    case "ai_complete":
      return runAi(env, step, context);
    case "tool_call":
      return runTool(env, step, context, log, opts);
    case "post_text":
      return runPostText(env, step, context, log);
    case "create_task":
      return runCreateTask(env, step, context);
    default: {
      const _exhaustive: never = step;
      throw new Error(`unknown_step_kind: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

async function runRecall(
  env: Env,
  step: Extract<Step, { kind: "recall_memory" }>,
  context: Record<string, unknown>,
): Promise<unknown> {
  const memory = new MemoryStore(env);
  return memory.recall(applyTemplate(step.query, context), {
    ...(step.scopeType ? { scopeType: step.scopeType } : {}),
    ...(step.scopeId
      ? { scopeId: applyTemplate(step.scopeId, context) }
      : {}),
    ...(step.memoryKind ? { kind: step.memoryKind } : {}),
    limit: step.limit ?? 10,
    strict: false,
  });
}

async function runAi(
  env: Env,
  step: Extract<Step, { kind: "ai_complete" }>,
  context: Record<string, unknown>,
): Promise<unknown> {
  const router = new Router(env);
  const prompt = applyTemplate(step.prompt, context);
  const result = await router.complete({
    messages: [{ role: "user", content: prompt }],
    ...(step.system ? { system: applyTemplate(step.system, context) } : {}),
    ...(step.tier ? { tier: step.tier } : {}),
    ...(step.maxTokens ? { maxTokens: step.maxTokens } : {}),
  });
  return { text: result.text, model: result.model, tier: result.tier };
}

async function runTool(
  env: Env,
  step: Extract<Step, { kind: "tool_call" }>,
  context: Record<string, unknown>,
  log: Logger,
  opts: ExecutorOpts,
): Promise<unknown> {
  const tool = findTool(step.tool);
  if (!tool) throw new Error(`unknown_tool: ${step.tool}`);
  if (!opts.ctx) throw new Error("tool_call_requires_execution_context");

  const input = interpolateInput(step.input ?? {}, context);
  return tool.handler({ env, ctx: opts.ctx, log }, input);
}

async function runPostText(
  env: Env,
  step: Extract<Step, { kind: "post_text" }>,
  context: Record<string, unknown>,
  log: Logger,
): Promise<unknown> {
  await postText(
    env,
    {
      serviceUrl: applyTemplate(step.serviceUrl, context),
      conversationId: applyTemplate(step.conversationId, context),
    },
    applyTemplate(step.text, context),
    log,
  );
  return { posted: true };
}

async function runCreateTask(
  env: Env,
  step: Extract<Step, { kind: "create_task" }>,
  context: Record<string, unknown>,
): Promise<unknown> {
  const store = new TaskStore(env);
  const created = await store.create(
    {
      title: applyTemplate(step.title, context),
      ...(step.description
        ? { description: applyTemplate(step.description, context) }
        : {}),
      ...(step.ownerAadId
        ? { ownerAadId: applyTemplate(step.ownerAadId, context) }
        : {}),
      ...(step.channelId
        ? { channelId: applyTemplate(step.channelId, context) }
        : {}),
      ...(step.chatId
        ? { chatId: applyTemplate(step.chatId, context) }
        : {}),
      ...(step.threadId
        ? { threadId: applyTemplate(step.threadId, context) }
        : {}),
      ...(step.priority ? { priority: step.priority } : {}),
      ...(step.deadlineAt
        ? { deadlineAt: applyTemplate(step.deadlineAt, context) }
        : {}),
    },
    "routine",
  );
  return { taskId: created.id };
}

function findTool(name: string): Tool | undefined {
  return mcpTools.find((t) => t.name === name);
}

function interpolateInput(
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") {
      out[k] = applyTemplate(v, context);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string" ? applyTemplate(item, context) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = interpolateInput(v as Record<string, unknown>, context);
    } else {
      out[k] = v;
    }
  }
  return out;
}
