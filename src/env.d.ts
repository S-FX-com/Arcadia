// Typed bindings for the Arcadia Worker. Keep in lockstep with wrangler.jsonc.
// The agents SDK constrains Agent<Env extends Cloudflare.Env>, so bindings are
// declared on the Cloudflare namespace (the same shape `wrangler types` emits).

interface ArcadiaBindings {
  // Agents (Durable Objects, SQLite-backed)
  Arcadia: DurableObjectNamespace<import("./agents/arcadia").Arcadia>;
  Hermes: DurableObjectNamespace<import("./agents/hermes").Hermes>;
  Radar: DurableObjectNamespace<import("./agents/radar").Radar>;
  Ledger: DurableObjectNamespace<import("./agents/ledger").Ledger>;
  MemoryProfile: DurableObjectNamespace<import("./memory/self-hosted").MemoryProfile>;

  // Workflows
  PUBLISH_WORKFLOW: Workflow;
  RATIFY_WORKFLOW: Workflow;

  // Storage
  DB: D1Database;
  CONTROL: KVNamespace;
  ARTIFACTS: R2Bucket;

  // Vector search — one index per memory profile (§5.2), plus the
  // published-log index Hermes dedupes against.
  VEC_DOCTRINE_CANONICAL: VectorizeIndex;
  VEC_DOCTRINE_STAGING: VectorizeIndex;
  VEC_EPISODIC: VectorizeIndex;
  VEC_PUBLISHED_LOG: VectorizeIndex;

  // Async
  VECTORIZE_QUEUE: Queue<import("./memory/self-hosted").VectorizeJob>;

  // Workers AI (embeddings; Whisper later)
  AI: Ai;

  // Vars
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  WP_BASE_URL: string;
  WP_USERNAME: string;
  WP_TUTORIALS_REST_BASE?: string;
  PUBLISH_TZ?: string;
  PUBLISH_WINDOW?: string;
  HERMES_CRON?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma-separated emails allowed to operate the kill switch (§4). */
  KILL_SWITCH_OPERATORS?: string;
  /** JSON map of SEO field → SureRank meta key, read off a live post (§9.6). */
  SURERANK_META_KEYS?: string;
  OPUS_ADVISOR_MODEL?: string;
  DEV_MODE?: string;

  // Secrets
  ANTHROPIC_API_KEY: string;
  WP_APP_PASSWORD: string;
  AI_GATEWAY_TOKEN?: string;
  SERPAPI_KEY?: string;
}

declare namespace Cloudflare {
  interface Env extends ArcadiaBindings {}
}

interface Env extends Cloudflare.Env {}
