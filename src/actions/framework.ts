// Action framework — the audited, ladder-gated spine for autonomy.
//
// EXECUTION-PLAN §Phase 5, decision D5. Nothing Arcadia *does* (as
// opposed to observes) runs except through executeAction. That function
// is the single choke point enforcing, in order:
//
//   1. Global kill switch (KV flag) — one switch disables all action.
//   2. Per-verb, per-scope capability ladder (action_policy):
//        observe → refuse; draft → prepare only; confirm → require a
//        human confirmation; auto → execute within budget.
//   3. Per-day action budget (KV counter) — a ceiling on autonomous acts.
//   4. Append-only audit (action_log) — every attempt, decision, outcome.
//
// A verb is a small module ({ name, defaultLevel, execute }). Verbs
// never touch policy, budget, kill switch, or logging themselves — the
// framework owns all of that, so a new verb can't accidentally bypass a
// control. Verbs receive an already-authorized context and just do the
// Graph write.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export type Ladder = "observe" | "draft" | "confirm" | "auto";

export interface ActionScope {
  type: "tenant" | "channel" | "chat" | "user" | "client";
  id: string;
}

export interface ActionContext {
  env: Env;
  log: Logger;
  /** The human on whose behalf Arcadia is acting. */
  actorAadId: string;
  /** Delegated user token, when the verb must act AS the user (OBO). */
  userToken?: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface ActionVerb<P = unknown> {
  name: string;
  /** Level applied when no action_policy row exists. Never higher than 'confirm'. */
  defaultLevel: Ladder;
  /** Validate/normalize raw params; throw to reject. */
  parse(raw: unknown): P;
  /** Human-readable one-line description of what THIS invocation will do. */
  describe(p: P): string;
  /** Perform the side effect. Only called after the ladder authorizes execution. */
  execute(ctx: ActionContext, p: P): Promise<ActionResult>;
}

export interface ExecuteOptions {
  /** Skip the confirmation wait because a human just confirmed (card verb). */
  confirmed?: boolean;
  /** Idempotency key — a duplicate key returns the prior log row's outcome. */
  idempotencyKey?: string;
}

export interface ExecuteOutcome {
  /** Terminal or intermediate state written to action_log. */
  status:
    | "executed"
    | "drafted"
    | "awaiting_confirmation"
    | "rejected"
    | "failed"
    | "blocked";
  actionId: string;
  level: Ladder;
  description: string;
  result?: ActionResult;
}

const KILL_SWITCH_KEY = "actions:kill_switch";
const BUDGET_PREFIX = "actions:budget:";

function defaultDailyBudget(env: Env): number {
  const n = Number(env.ACTION_DAILY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/** True when all autonomous action is disabled tenant-wide. */
export async function isKillSwitchOn(env: Env): Promise<boolean> {
  const v = await env.ARCADIA_CACHE.get(KILL_SWITCH_KEY);
  return v === "1";
}

export async function setKillSwitch(env: Env, on: boolean): Promise<void> {
  if (on) await env.ARCADIA_CACHE.put(KILL_SWITCH_KEY, "1");
  else await env.ARCADIA_CACHE.delete(KILL_SWITCH_KEY);
}

/** Resolve the configured ladder level for a verb in a scope (fail-closed). */
export async function resolveLevel(
  env: Env,
  verb: string,
  scope: ActionScope,
  fallback: Ladder,
): Promise<Ladder> {
  // Most specific first: exact scope id, then wildcard for the type.
  const row = await env.ARCADIA_DB.prepare(
    `SELECT level FROM action_policy
      WHERE verb = ? AND scope_type = ? AND scope_id IN (?, '*')
      ORDER BY CASE scope_id WHEN '*' THEN 1 ELSE 0 END
      LIMIT 1`,
  )
    .bind(verb, scope.type, scope.id)
    .first<{ level: Ladder }>();
  return row?.level ?? fallback;
}

function budgetKey(day: string): string {
  return `${BUDGET_PREFIX}${day}`;
}

async function overBudget(env: Env, day: string): Promise<boolean> {
  const raw = await env.ARCADIA_CACHE.get(budgetKey(day));
  const spent = raw ? Number(raw) : 0;
  return spent >= defaultDailyBudget(env);
}

async function chargeBudget(env: Env, day: string): Promise<void> {
  const raw = await env.ARCADIA_CACHE.get(budgetKey(day));
  const spent = (raw ? Number(raw) : 0) + 1;
  // 2-day TTL so counters self-expire.
  await env.ARCADIA_CACHE.put(budgetKey(day), String(spent), {
    expirationTtl: 172800,
  });
}

async function writeLog(
  env: Env,
  row: {
    id: string;
    verb: string;
    actorAadId: string;
    onBehalf: string;
    scope: ActionScope;
    level: Ladder;
    params: unknown;
    status: string;
    result?: ActionResult;
    idempotencyKey?: string;
    executed?: boolean;
  },
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO action_log
       (id, verb, actor_aad_id, on_behalf, scope_type, scope_id, level,
        params_json, status, result_json, idempotency_key, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.verb,
      row.actorAadId,
      row.onBehalf,
      row.scope.type,
      row.scope.id,
      row.level,
      JSON.stringify(row.params),
      row.status,
      row.result ? JSON.stringify(row.result) : null,
      row.idempotencyKey ?? null,
      row.executed ? new Date().toISOString() : null,
    )
    .run();
}

/**
 * The single entry point for performing an action. Enforces kill switch,
 * ladder, budget, and audit around the verb's execute(). `today` is
 * injectable for tests.
 */
export async function executeAction<P>(
  ctx: ActionContext,
  verb: ActionVerb<P>,
  scope: ActionScope,
  rawParams: unknown,
  opts: ExecuteOptions = {},
  today: string = new Date().toISOString().slice(0, 10),
): Promise<ExecuteOutcome> {
  const { env } = ctx;
  const id = crypto.randomUUID();
  const onBehalf = ctx.userToken ? "delegated" : "app-only";

  let params: P;
  try {
    params = verb.parse(rawParams);
  } catch (e) {
    return { status: "rejected", actionId: id, level: "observe", description: `invalid params: ${String(e)}` };
  }
  const description = verb.describe(params);

  // Idempotency: a prior row with the same key short-circuits.
  if (opts.idempotencyKey) {
    const prior = await env.ARCADIA_DB.prepare(
      `SELECT id, status, level, result_json FROM action_log WHERE idempotency_key = ? LIMIT 1`,
    )
      .bind(opts.idempotencyKey)
      .first<{ id: string; status: string; level: Ladder; result_json: string | null }>();
    if (prior) {
      return {
        status: prior.status as ExecuteOutcome["status"],
        actionId: prior.id,
        level: prior.level,
        description,
        ...(prior.result_json ? { result: JSON.parse(prior.result_json) as ActionResult } : {}),
      };
    }
  }

  // 1. Kill switch.
  if (await isKillSwitchOn(env)) {
    await writeLog(env, { id, verb: verb.name, actorAadId: ctx.actorAadId, onBehalf, scope, level: "observe", params, status: "blocked", ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
    return { status: "blocked", actionId: id, level: "observe", description };
  }

  // 2. Ladder.
  const level = await resolveLevel(env, verb.name, scope, verb.defaultLevel);
  const base = { id, verb: verb.name, actorAadId: ctx.actorAadId, onBehalf, scope, level, params, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) };

  if (level === "observe") {
    await writeLog(env, { ...base, status: "rejected" });
    return { status: "rejected", actionId: id, level, description };
  }
  if (level === "draft") {
    await writeLog(env, { ...base, status: "drafted" });
    return { status: "drafted", actionId: id, level, description };
  }
  if (level === "confirm" && !opts.confirmed) {
    await writeLog(env, { ...base, status: "awaiting_confirmation" });
    return { status: "awaiting_confirmation", actionId: id, level, description };
  }

  // 3. Budget (applies to any actual execution — confirmed or auto).
  if (await overBudget(env, today)) {
    await writeLog(env, { ...base, status: "blocked" });
    return { status: "blocked", actionId: id, level, description };
  }

  // 4. Execute + audit.
  let result: ActionResult;
  try {
    result = await verb.execute(ctx, params);
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  await chargeBudget(env, today);
  await writeLog(env, { ...base, status: result.ok ? "executed" : "failed", result, executed: result.ok });
  return { status: result.ok ? "executed" : "failed", actionId: id, level, description, result };
}
