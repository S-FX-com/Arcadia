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
  /** Refresh a person profile every N handled messages. Default 20. */
  PROFILE_REFRESH_EVERY?: string;
  /** Minimum recent memories before a person profile is (re)built. Default 5. */
  PROFILE_MIN_MEMORIES?: string;
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
  /**
   * Cloudflare account id. Only consulted to route Anthropic calls through
   * the AI Gateway; the gateway is used only when both this and
   * AI_GATEWAY_ID are set, otherwise calls hit api.anthropic.com directly.
   */
  CF_ACCOUNT_ID?: string;
  /**
   * Optional alerting webhook. When set, cron/queue failures POST a compact
   * JSON payload here (fire-and-forget) in addition to error-level logs.
   */
  ALERT_WEBHOOK_URL?: string;
  AGENT_365_AGENT_ID?: string;
  /** Optional channel id to receive the Monday weekly roll-up. */
  WEEKLY_REPORT_CHANNEL_ID?: string;
  /** Optional Microsoft Search external-connection id for Copilot Connector ingest. */
  COPILOT_CONNECTION_ID?: string;
  /** Optional HTTP endpoint that converts PDF bytes to text. */
  PDF_EXTRACT_URL?: string;
  /**
   * Optional public hostname of this Worker (no scheme), e.g.
   * "arcadia.example.com". Used to build the Graph change-notification
   * webhook URL (https://{PUBLIC_HOST}/api/graph/notify). When unset,
   * ensureSubscriptions is a no-op so hostname-less deploys don't crash.
   */
  PUBLIC_HOST?: string;

  /** Max autonomous/confirmed actions per day (executeAction budget). Default 50. */
  ACTION_DAILY_BUDGET?: string;
}
