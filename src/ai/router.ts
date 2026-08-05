// ModelRouter — the single door every reasoning call goes through (§6).
//
// Routing is per task, stored in D1, cached in KV, and editable by a
// superadmin in the admin surface. Defaults are Cloudflare Workers AI; a task
// pointed at Anthropic goes out through AI Gateway. Call sites name a TaskKind
// and never a model, so re-routing is a config change, not a deploy.

import { advisorComplete, anthropicComplete } from "../integrations/anthropic";
import { workersAiComplete, workersAiEmbed, workersAiTranscribe } from "./workers-ai";
import {
  CLAUDE_ADVISOR,
  DEFAULT_ROUTING,
  type CompleteOptions,
  type CompletionResult,
  type ModelBinding,
  type Provider,
  type TaskKind,
  TASK_KINDS,
} from "./types";

const CACHE_KEY = "config:model_routing";
const CACHE_TTL_SECONDS = 60;

interface ModelConfigRow {
  task: string;
  provider: string;
  model: string;
  max_tokens: number;
}

export type Routing = Record<TaskKind, ModelBinding>;

function isProvider(value: string): value is Provider {
  return value === "workers-ai" || value === "anthropic";
}

function isTaskKind(value: string): value is TaskKind {
  return (TASK_KINDS as string[]).includes(value);
}

/** Resolved routing: defaults with any D1 overrides applied on top. */
export async function loadRouting(env: Env): Promise<Routing> {
  const cached = await env.CONTROL.get(CACHE_KEY, "json").catch(() => null);
  if (cached && typeof cached === "object") {
    return { ...DEFAULT_ROUTING, ...(cached as Partial<Routing>) };
  }
  const overrides = await readOverrides(env);
  await env.CONTROL.put(CACHE_KEY, JSON.stringify(overrides), { expirationTtl: CACHE_TTL_SECONDS });
  return { ...DEFAULT_ROUTING, ...overrides };
}

async function readOverrides(env: Env): Promise<Partial<Routing>> {
  const rows = await env.DB.prepare(`SELECT task, provider, model, max_tokens FROM model_config`)
    .all<ModelConfigRow>()
    .catch(() => ({ results: [] as ModelConfigRow[] }));
  const overrides: Partial<Routing> = {};
  for (const row of rows.results) {
    if (!isTaskKind(row.task) || !isProvider(row.provider)) continue;
    overrides[row.task] = {
      provider: row.provider,
      model: row.model,
      maxTokens: row.max_tokens,
    };
  }
  return overrides;
}

/** Persist an override and drop the cache so the next call sees it. */
export async function setRouting(
  env: Env,
  task: TaskKind,
  binding: ModelBinding,
  updatedBy: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_config (task, provider, model, max_tokens, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(task) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       max_tokens = excluded.max_tokens,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  )
    .bind(task, binding.provider, binding.model, binding.maxTokens, updatedBy)
    .run();
  await env.CONTROL.delete(CACHE_KEY);
}

/** Drop a task back to the built-in default. */
export async function resetRouting(env: Env, task: TaskKind): Promise<void> {
  await env.DB.prepare(`DELETE FROM model_config WHERE task = ?1`).bind(task).run();
  await env.CONTROL.delete(CACHE_KEY);
}

export class ModelRouter {
  private routing?: Routing;

  constructor(private readonly env: Env) {}

  async binding(task: TaskKind): Promise<ModelBinding> {
    this.routing ??= await loadRouting(this.env);
    return this.routing[task];
  }

  /**
   * Run a task. Returns text — callers that want JSON pass `jsonSchema` as a
   * hint and still parse defensively, because no provider guarantees schema
   * compliance.
   */
  async run(task: TaskKind, opts: CompleteOptions): Promise<CompletionResult> {
    const binding = await this.binding(task);
    const maxTokens = opts.maxTokens ?? binding.maxTokens;
    const metadata = { task, ...(opts.metadata ?? {}) };

    if (binding.provider === "anthropic") {
      // The advisor pattern (§6) applies to the judgment tier: Sonnet
      // executes, Opus advises, rather than routing whole requests to Opus.
      const useAdvisor = binding.model === CLAUDE_ADVISOR;
      const text = useAdvisor
        ? await advisorComplete(this.env, { ...opts, maxTokens, metadata })
        : await anthropicComplete(this.env, binding.model, { ...opts, maxTokens, metadata });
      return { text, provider: "anthropic", model: binding.model };
    }

    const text = await workersAiComplete(this.env, binding.model, { ...opts, maxTokens, metadata });
    return { text, provider: "workers-ai", model: binding.model };
  }

  /** Convenience: run a task and return just the text. */
  async text(task: TaskKind, opts: CompleteOptions): Promise<string> {
    return (await this.run(task, opts)).text;
  }

  /** Embeddings are always Workers AI — the index dimensions depend on it. */
  async embed(text: string): Promise<number[]> {
    const [vector] = await workersAiEmbed(this.env, [text]);
    if (!vector) throw new Error("embedding returned no vector");
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return workersAiEmbed(this.env, texts);
  }

  async transcribe(base64Audio: string): Promise<string> {
    return workersAiTranscribe(this.env, base64Audio);
  }
}

/**
 * Tolerant JSON extraction. Workers AI models ignore response_format often
 * enough that every JSON-shaped call must survive prose, code fences, and
 * reasoning preambles.
 */
export function parseJsonBlock<T>(raw: string): T {
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const firstBrace = stripped.indexOf("{");
  const firstBracket = stripped.indexOf("[");
  const start =
    firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
  if (start < 0) throw new Error(`model returned no JSON: ${raw.slice(0, 200)}`);
  const open = stripped[start];
  const close = open === "{" ? "}" : "]";
  const end = stripped.lastIndexOf(close);
  if (end <= start) throw new Error(`model returned unterminated JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(stripped.slice(start, end + 1)) as T;
}
