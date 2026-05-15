// Typed bindings for the Arcadia Cloudflare Worker.
//
// Mirror wrangler.toml [vars] + secrets here. Add new bindings before
// referencing them from handlers — TypeScript is the contract.

export interface Env {
  // Bindings
  ARCADIA_DB: D1Database;
  ARCADIA_CACHE: KVNamespace;
  ARCADIA_VECTORS: VectorizeIndex;
  INGEST_QUEUE: Queue;
  AI: Ai;

  // Tunables (wrangler.toml [vars])
  STALE_THREAD_HOURS: string;
  MAX_MESSAGES_CACHED: string;
  DIGEST_CRON_HOUR: string;
  CF_AI_DEFAULT_MODEL: string;
  NUDGE_COOLDOWN_HOURS: string;
  NUDGE_MAX_PER_RUN: string;
  RESEARCH_QUESTION_MAX_PER_CYCLE: string;
  RESEARCH_QUESTION_MAX_PER_DAY: string;
  PROCEDURE_MIN_USES: string;
  PROCEDURE_PROMOTE_THRESHOLD: string;
  PROCEDURE_RETIRE_THRESHOLD: string;
  LOG_LEVEL?: string;

  // Secrets (wrangler secret put <KEY>)
  TEAMS_APP_ID: string;
  TEAMS_APP_PASSWORD: string;
  GRAPH_TENANT_ID: string;
  GRAPH_CLIENT_ID: string;
  GRAPH_CLIENT_SECRET: string;
  GRAPH_NOTIFICATION_SECRET: string;
  ADMIN_USER_AAD_ID: string;
  WEBAPP_CLIENT_ID: string;
  WEBAPP_CLIENT_SECRET: string;
  WEBAPP_SESSION_SECRET: string;
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_ID?: string;
  AGENT_365_AGENT_ID?: string;
  /** Optional channel id to receive the Monday weekly roll-up. */
  WEEKLY_REPORT_CHANNEL_ID?: string;
  /** Optional Microsoft Search external-connection id for Copilot Connector ingest. */
  COPILOT_CONNECTION_ID?: string;
  /** Optional HTTP endpoint that converts PDF bytes to text. */
  PDF_EXTRACT_URL?: string;
}
