// Ambient types for the `cloudflare:test` module used by integration tests.
// Extends the pool's ProvidedEnv with the worker's real bindings plus the
// TEST_MIGRATIONS payload injected via miniflare options.
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
