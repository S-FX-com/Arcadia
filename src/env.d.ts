// Typed bindings for the Arcadia Worker. Keep in lockstep with wrangler.jsonc.
// The agents SDK constrains Agent<Env extends Cloudflare.Env>, so bindings are
// declared on the Cloudflare namespace (the same shape `wrangler types` emits).

interface ArcadiaBindings {
  // Agents (Durable Objects, SQLite-backed)
  Arcadia: DurableObjectNamespace<import("./agents/arcadia").Arcadia>;
  Radar: DurableObjectNamespace<import("./agents/radar").Radar>;
  Ledger: DurableObjectNamespace<import("./agents/ledger").Ledger>;
  Dispatcher: DurableObjectNamespace<import("./agents/dispatcher").Dispatcher>;
  MemoryProfile: DurableObjectNamespace<import("./memory/self-hosted").MemoryProfile>;

  // Workflows
  RATIFY_WORKFLOW: Workflow;
  SITEPLAN_WORKFLOW: Workflow;
  SEED_WORKFLOW: Workflow;

  // Storage
  DB: D1Database;
  CONTROL: KVNamespace;
  ARTIFACTS: R2Bucket;

  // Vector search — one index per memory profile (§5.2).
  VEC_DOCTRINE_CANONICAL: VectorizeIndex;
  VEC_DOCTRINE_STAGING: VectorizeIndex;
  VEC_EPISODIC: VectorizeIndex;

  // Async
  VECTORIZE_QUEUE: Queue<import("./memory/self-hosted").VectorizeJob>;

  // Workers AI — the default reasoning provider (§6), plus embeddings/Whisper.
  AI: Ai;

  // Browser Rendering — the 390px mobile certification verifier. Optional:
  // the verifier reports "unverifiable" rather than passing when absent.
  BROWSER?: Fetcher;

  // Vars
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  // Microsoft Entra — one app registration serves both staff sign-in
  // (src/lib/sso.ts) and Graph (src/integrations/graph.ts), so both read the
  // same GRAPH_ names. Tenant and client id are public identifiers, not
  // secrets; only GRAPH_CLIENT_SECRET is.
  /** Entra directory (tenant) id. */
  GRAPH_TENANT_ID?: string;
  /** Application (client) id. */
  GRAPH_CLIENT_ID?: string;
  /**
   * Overrides the redirect URI derived from the request origin. Only needed
   * when the Worker is reached on a hostname other than the one registered
   * in Entra.
   */
  SSO_REDIRECT_URI?: string;
  OPUS_ADVISOR_MODEL?: string;
  /**
   * "true" bypasses SSO with a fake identity. Honored only on a loopback
   * host, so setting it in deployed vars still cannot open the real Worker.
   */
  DEV_MODE?: string;

  /** Founder digest recipient (§4 M1 day 7). */
  FOUNDER_EMAIL?: string;
  /** Escalation email sender, e.g. "Arcadia <arcadia@s-fx.com>". */
  EMAIL_FROM?: string;
  /** Defaults to the Resend API; any same-shaped provider works. */
  EMAIL_API_URL?: string;

  // Secrets
  /** Optional — only needed for tasks an admin routes to Claude (§6). */
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  /** Stall Radar git signal. */
  GITHUB_TOKEN?: string;
  /** Escalation email provider key. Unset = accountability board only. */
  EMAIL_API_KEY?: string;
  /**
   * Client secret of the Entra app registration. Required for staff sign-in;
   * also completes the Graph client-credentials trio (Phase 1b+, §9.7) —
   * unset, Graph signals report unavailable and sign-in refuses to serve.
   */
  GRAPH_CLIENT_SECRET?: string;
  /** HMAC key sealing the session cookie. Rotating it logs everyone out. */
  SSO_SESSION_SECRET?: string;
}

declare namespace Cloudflare {
  interface Env extends ArcadiaBindings {}
}

interface Env extends Cloudflare.Env {}
