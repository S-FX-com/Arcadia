import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Integration tests run inside a real workerd runtime via
// @cloudflare/vitest-pool-workers. We deliberately do NOT point the pool at
// wrangler.toml: that config declares Vectorize + Workers AI bindings that
// miniflare cannot simulate. Instead the miniflare options below describe an
// explicit, simulatable subset (D1 + KV + Queue + plain vars).

export default defineWorkersConfig(async () => {
  // Read + split the forward-only schema migrations in Node context and pass
  // them into the worker as a plain (JSON-serialisable) binding. setup.ts
  // applies them against the D1 database before any test runs.
  const migrations = await readD1Migrations(path.join(__dirname, "schema"));

  return {
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/setup.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2026-05-14",
            compatibilityFlags: ["nodejs_compat"],

            // Simulatable bindings.
            d1Databases: ["ARCADIA_DB"],
            kvNamespaces: ["ARCADIA_CACHE"],
            queueProducers: { INGEST_QUEUE: "arcadia-ingest" },

            // Plain vars: the [vars] block from wrangler.toml (copied verbatim)
            // plus fake values for the secrets the code reads at runtime.
            bindings: {
              // Migrations payload consumed by test/integration/setup.ts.
              TEST_MIGRATIONS: migrations,

              // --- [vars] from wrangler.toml (verbatim) ---
              STALE_THREAD_HOURS: "48",
              MAX_MESSAGES_CACHED: "100",
              DIGEST_CRON_HOUR: "8",
              CF_AI_DEFAULT_MODEL: "@cf/google/gemma-4-26b-a4b-it",
              NUDGE_COOLDOWN_HOURS: "8",
              NUDGE_MAX_PER_RUN: "5",
              RESEARCH_QUESTION_MAX_PER_CYCLE: "3",
              RESEARCH_QUESTION_MAX_PER_DAY: "5",
              PROCEDURE_MIN_USES: "5",
              PROCEDURE_PROMOTE_THRESHOLD: "0.65",
              PROCEDURE_RETIRE_THRESHOLD: "0.35",

              // --- secrets / vars the code reads (test-only fakes) ---
              TEAMS_APP_ID: "10000000-0000-0000-0000-0000000000aa",
              TEAMS_APP_PASSWORD: "integration-test-teams-app-password",
              GRAPH_TENANT_ID: "10000000-0000-0000-0000-000000000001",
              GRAPH_CLIENT_ID: "10000000-0000-0000-0000-0000000000bb",
              GRAPH_CLIENT_SECRET: "integration-test-graph-client-secret",
              GRAPH_NOTIFICATION_SECRET: "integration-test-graph-notification-secret",
              ADMIN_USER_AAD_ID: "admin-aad-id",
              WEBAPP_CLIENT_ID: "20000000-0000-0000-0000-000000000002",
              WEBAPP_CLIENT_SECRET: "integration-test-webapp-client-secret",
              WEBAPP_SESSION_SECRET: "integration-test-session-secret-32b",
              ANTHROPIC_API_KEY: "test-key",
            },
          },
        },
      },
    },
  };
});
