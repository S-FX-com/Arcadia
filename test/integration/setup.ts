// Integration-test setup: apply the D1 schema migrations once, before any
// test file runs. `env.TEST_MIGRATIONS` is the array produced by
// readD1Migrations() in vitest.integration.config.ts (Node context) and passed
// through as a miniflare binding. applyD1Migrations records applied migrations
// in a `d1_migrations` table, so this is idempotent across the run.
import { env, applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.ARCADIA_DB, env.TEST_MIGRATIONS);
