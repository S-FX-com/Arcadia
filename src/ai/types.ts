// Model routing types. Arcadia defaults to Cloudflare Workers AI; Anthropic
// is available per task via admin config (§6). Every task in the system names
// its own routing slot so the model behind it can change without touching
// call sites.

export type Provider = "workers-ai" | "anthropic";

/**
 * Task slots. Each is a distinct job with its own cost/quality tradeoff, so
 * each gets its own configurable model binding.
 */
export type TaskKind =
  // --- fast tier: high volume, low stakes, cheap ---
  | "stall_sweep" // Radar signal interpretation
  | "classification" // memory kind + topic key
  | "extraction" // ingestion pass A (broad)
  | "detail_sweep" // ingestion pass B (concrete values — mandatory, §5.3)
  | "verification" // ingestion verification against source
  | "search_queries" // embedding query prefixes (§5.3 trick)
  | "seo" // title/meta description
  | "spellcheck" // certification verifier: typos in rendered DOM
  // --- balanced tier: writing and synthesis ---
  | "drafting" // Hermes articles
  | "brand_revision" // rewrite to clear brand doctrine
  | "summary" // digests, briefs
  | "digest" // founder digest
  | "synthesis" // memory recall synthesis (Ask Arcadia)
  | "copy_diff" // certification verifier: copy vs approved doc
  // --- deep tier: judgment ---
  | "judgment" // doctrine conflicts, novel calls
  | "site_ia" // site planning information architecture
  | "site_page_spec"; // per-page section specs

export interface ModelBinding {
  provider: Provider;
  model: string;
  maxTokens: number;
}

export interface CompleteOptions {
  system?: string;
  prompt?: string;
  maxTokens?: number;
  /** Attached to AI Gateway analytics for per-call cost attribution. */
  metadata?: Record<string, string>;
  /**
   * When supplied, Workers AI models that support structured outputs receive
   * it as response_format.json_schema. Callers must still tolerate prose —
   * Workers AI does not guarantee schema compliance, so the parser stays.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  provider: Provider;
  model: string;
}

// ---------------------------------------------------------------------------
// Defaults — Workers AI everywhere (verified against the live model catalog,
// 2026-08-05). Anthropic is opt-in per task from the admin surface.
// ---------------------------------------------------------------------------

/** 128K context, cheapest useful instruct model. JSON mode supported. */
export const WA_FAST = "@cf/meta/llama-3.1-8b-instruct-fast";
/** 128K context, $0.35/$0.75 per M, reasoning + function calling. */
export const WA_BALANCED = "@cf/openai/gpt-oss-120b";
/** 262K context, $1.40/$4.40 per M, flagship agentic reasoning. Paid plan. */
export const WA_DEEP = "@cf/zai-org/glm-5.2";
/** 768-dim — matches the Vectorize index dimensions; do not change casually. */
export const WA_EMBEDDING = "@cf/baai/bge-base-en-v1.5";
/** Base64 audio in, text out. Capture channel A voice deposits (§5.5). */
export const WA_TRANSCRIPTION = "@cf/openai/whisper-large-v3-turbo";

// Anthropic models, used only where an admin routes a task to them (§6).
export const CLAUDE_FAST = "claude-haiku-4-5";
export const CLAUDE_BALANCED = "claude-sonnet-4-6";
/**
 * Advisor for the deep tier. The spec named claude-opus-4-6, but the advisor
 * tool's pairing table rejects it as an advisor (400) — 4-7 is the nearest
 * accepted model at the same price.
 */
export const CLAUDE_ADVISOR = "claude-opus-4-7";

const fast = (maxTokens = 1024): ModelBinding => ({ provider: "workers-ai", model: WA_FAST, maxTokens });
const balanced = (maxTokens = 4096): ModelBinding => ({
  provider: "workers-ai",
  model: WA_BALANCED,
  maxTokens,
});
const deep = (maxTokens = 8192): ModelBinding => ({ provider: "workers-ai", model: WA_DEEP, maxTokens });

export const DEFAULT_ROUTING: Record<TaskKind, ModelBinding> = {
  stall_sweep: fast(1024),
  classification: fast(512),
  extraction: fast(4096),
  detail_sweep: fast(4096),
  verification: fast(2048),
  search_queries: fast(300),
  seo: fast(400),
  spellcheck: fast(2048),

  drafting: balanced(8192),
  brand_revision: balanced(8192),
  summary: balanced(2048),
  digest: balanced(4096),
  synthesis: balanced(2048),
  copy_diff: balanced(2048),

  judgment: deep(4096),
  site_ia: deep(8192),
  site_page_spec: deep(8192),
};

export const TASK_KINDS = Object.keys(DEFAULT_ROUTING) as TaskKind[];

/** Human-readable grouping for the admin UI. */
export const TASK_TIERS: Record<TaskKind, "fast" | "balanced" | "deep"> = {
  stall_sweep: "fast",
  classification: "fast",
  extraction: "fast",
  detail_sweep: "fast",
  verification: "fast",
  search_queries: "fast",
  seo: "fast",
  spellcheck: "fast",
  drafting: "balanced",
  brand_revision: "balanced",
  summary: "balanced",
  digest: "balanced",
  synthesis: "balanced",
  copy_diff: "balanced",
  judgment: "deep",
  site_ia: "deep",
  site_page_spec: "deep",
};

/** Models offered in the admin dropdowns, with the tradeoff stated plainly. */
export const MODEL_CATALOG: Array<{
  provider: Provider;
  model: string;
  label: string;
  note: string;
}> = [
  { provider: "workers-ai", model: WA_FAST, label: "Llama 3.1 8B Fast", note: "128K ctx · cheapest · JSON mode" },
  {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B Fast",
    note: "24K ctx · $0.29/$2.25 per M · JSON mode",
  },
  {
    provider: "workers-ai",
    model: WA_BALANCED,
    label: "GPT-OSS 120B",
    note: "128K ctx · $0.35/$0.75 per M · reasoning",
  },
  {
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    note: "262K ctx · $0.95/$4.00 per M · reasoning + structured outputs · paid plan",
  },
  { provider: "workers-ai", model: WA_DEEP, label: "GLM-5.2", note: "262K ctx · $1.40/$4.40 per M · paid plan" },
  {
    provider: "workers-ai",
    model: "@cf/nvidia/nemotron-3-120b-a12b",
    label: "Nemotron 3 120B",
    note: "reasoning + function calling",
  },
  { provider: "anthropic", model: CLAUDE_FAST, label: "Claude Haiku 4.5", note: "via AI Gateway · $1/$5 per M" },
  {
    provider: "anthropic",
    model: CLAUDE_BALANCED,
    label: "Claude Sonnet 4.6",
    note: "via AI Gateway · $3/$15 per M",
  },
  {
    provider: "anthropic",
    model: CLAUDE_ADVISOR,
    label: "Claude Opus 4.7 (advisor)",
    note: "via AI Gateway · Sonnet executes, Opus advises · strongest judgment",
  },
];
