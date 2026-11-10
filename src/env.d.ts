// Typed bindings for the Arcadia Worker. Keep in lockstep with wrangler.jsonc.
// The agents SDK constrains Agent<Env extends Cloudflare.Env>, so bindings are
// declared on the Cloudflare namespace (the same shape `wrangler types` emits).

interface ArcadiaBindings {
  // Durable Objects (SQLite-backed). Arcadia is the scheduler agent;
  // MemoryProfile is the hybrid retrieval engine Phase 9 adopts or deletes.
  Arcadia: DurableObjectNamespace<import("./agents/arcadia").Arcadia>;
  MemoryProfile: DurableObjectNamespace<import("./memory/self-hosted").MemoryProfile>;

  // Storage
  DB: D1Database;
  CONTROL: KVNamespace;
  ARTIFACTS: R2Bucket;

  // Vector search — one index per memory profile. Phase 9 decides.
  VEC_DOCTRINE_CANONICAL: VectorizeIndex;
  VEC_DOCTRINE_STAGING: VectorizeIndex;
  VEC_EPISODIC: VectorizeIndex;

  // Async
  VECTORIZE_QUEUE: Queue<import("./memory/self-hosted").VectorizeJob>;

  // Workers AI — the default reasoning provider, plus embeddings.
  AI: Ai;

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

  // Secrets
  /** Optional — only needed for tasks an admin routes to Claude. */
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  /**
   * Client secret of the Entra app registration. Required for staff sign-in
   * (src/lib/sso.ts) and for the app-only Graph client
   * (src/integrations/graph.ts: roster sync, Shifts). Unset, sign-in refuses
   * to serve and Graph reports not connected.
   */
  GRAPH_CLIENT_SECRET?: string;
  /** HMAC key sealing the session cookie. Rotating it logs everyone out. */
  SSO_SESSION_SECRET?: string;
}

declare namespace Cloudflare {
  interface Env extends ArcadiaBindings {}
}

interface Env extends Cloudflare.Env {}
