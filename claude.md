# claude.md — Operating instructions for AI agents on the Arcadia codebase

> **Three canonical documents. Know which one you're reading.**
>
> - **`SOUL.md`** — Arcadia's character, voice, values, commitments. Canon. Do not edit.
> - **`ARCHITECTURE.md`** — How v2 is built. The technical contract. Read this before writing code.
> - **`claude.md`** — How to work in this codebase as an AI agent. (This document.)

---

## v2 context (read this once)

This is the v2 rebuild. v1 was a hand-rolled Bot Framework integration with phase-by-phase
evolution (Phases 0–17). v2 is a clean cut on the **Microsoft 365 Agents SDK**, with the
same character (`SOUL.md`) and the same operational behaviours (digests, stale detection,
nudges, briefs, memory, routines) but a supported substrate.

If you reach for a file from v1 (`src/bot/handler.ts`, `src/agent/loop.ts`,
`src/webapp/auth.ts`, `src/memory/d1.ts`, `schema/d1-phase*.sql`, etc.) — it's gone.
Look at `ARCHITECTURE.md §5` for the v2 module layout.

---

## Stack

- **Runtime**: Cloudflare Workers (TypeScript 5.7, strict mode)
- **Agent framework**: Microsoft 365 Agents SDK (npm: `@microsoft/agents-bot-*`)
- **Storage**: D1 (durable) + KV (ephemeral/cache) + Vectorize (768-dim embeddings) + Queues (ingest)
- **AI**: Anthropic Claude (Haiku 4.5, Sonnet 4.6) + Cloudflare Workers AI (Gemma 4 26B)
- **Graph**: Raw `fetch` (no SDK client) via `src/graph/client.ts`
- **Frontend**: SvelteKit + Microsoft Graph Toolkit (under `web/`)

**Entry point**: `src/index.ts` — lazy-imports per-route handlers under each module.

---

## Module map (v2)

```
src/
  index.ts                   Worker entry: fetch / scheduled / queue routing
  env.ts                     Typed bindings (D1, KV, Vectorize, AI, secrets)

  runtime/                   Microsoft 365 Agents SDK runtime
    activity-handler.ts        Inbound activity dispatch (real)
    auth.ts                    Bot Framework JWT verification (real)
    storage-adapter.ts         SDK Storage adapter (stub — v2 may not need)
    cron-dispatcher.ts         Cron routing (stub — fills with intelligence)

  ai/                        Tiered AI router
    router.ts                  fast → balanced → deep cascade (real)
    types.ts                   Message / CompleteRequest / Tier
    providers/anthropic.ts     Claude via fetch + SSE (real)
    providers/cloudflare.ts    Workers AI Gemma (real)

  memory/                    Four-layer memory store
    types.ts                   Memory / Kind / Scope / Edge
    store.ts                   add / recall / recent / byId / link / forget / prune (real)
    vector.ts                  Embedding + Vectorize integration (real)
    consolidation.ts           light/deep/REM cycles (stub)

  graph/                     Microsoft Graph
    auth.ts                    app-only + OBO token acquisition (real)
    client.ts                  GraphRequest, retry/throttle, GraphError (real)
    messages.ts                channel + chat message ops (real)
    subscriptions.ts           webhook + CRUD with HMAC clientState (real)
    delta.ts                   per-resource delta cursor state (real)

  cards/                     Universal Action cards (real)
    types.ts                   Verb / ActionExecute / AdaptiveCard
    digest.ts                  daily digest card
    task.ts                    task assignment + sequential workflow
    nudge.ts                   at-risk nudge

  mcp/                       Arcadia-as-MCP-server
    server.ts                  JSON-RPC handler (real)
    tools.ts                   8-tool registry: 5 real, 3 stub

  webapp/                    HTTP API for the SvelteKit frontend
    routes.ts                  Route table (stub — /api/webapp/health is live)

  openapi/spec.ts            OpenAPI 3.1 publishing (stub — minimal placeholder)
  agent365/manifest.ts       Agent 365 capability manifest (stub — minimal placeholder)
  ingest/queue-consumer.ts   Cloudflare Queue consumer (stub)

  lib/                       Shared utilities
    logger.ts                  Structured JSON logger (real)
    config.ts                  Tunables parser (real)
    result.ts                  Result<T, E> discriminated union (real)
```

**Real** = production-shape implementation. **Stub** = compiles, route is reachable, returns
501 or no-op until that module's commit lands.

---

## Build order (commit sequence)

1. ✦ Foundation: package, wrangler, schema, README, migrator
2. ✦ src/ skeleton: env, logger, config, route stubs
3. ✦ AI router with tiered providers
4. ✦ Memory store on D1 + Vectorize
5. ✦ Graph layer foundation
6. ✦ Universal Action cards
7. ✦ MCP server with tool surface
8. ✦ Agents SDK runtime (JWT verify + message + reply + episodic memory)
9. **next** — Invoke dispatch for card verbs (digest_refresh, task_*, nudge_*, memory_correct, feedback)
10. **next** — Intelligence layer (digest, stale, nudge, briefs, weekly) + cron dispatcher wiring
11. **next** — Tasks store + ownership_history + Planner sync
12. **next** — ACL strict mode (resource_acl + group_membership + sensitivity)
13. **next** — Routines engine
14. **next** — Webapp HTTP API + SvelteKit frontend with MGT
15. **next** — OpenAPI real spec + Copilot Connector + Agent 365 manifest fleshed out
16. **next** — Ingest pipeline (queue producers + parsers + chunker + embeddings)
17. **next** — Eval harness runner + nightly regression gate

Pick the next item in the list when starting a new chunk. Don't skip ahead.

---

## TypeScript rules

- `exactOptionalPropertyTypes: true` — never pass `undefined` for optional properties.
  Omit the property or use a conditional spread:
  `...(val !== undefined ? { key: val } : {})`
- `noUncheckedIndexedAccess: true` — array/map access returns `T | undefined`; always
  check before use.
- No `any` except at SDK boundaries that genuinely need it (rare).
- D1 row types live alongside their store (e.g. `MemoryRow` inside `src/memory/store.ts`);
  domain objects (`Memory`) live in `<module>/types.ts`.
- Cloudflare Workers globals (`D1Database`, `KVNamespace`, `VectorizeIndex`, `Ai`,
  `Queue`, `MessageBatch`, `ScheduledEvent`, `ExecutionContext`, `ExportedHandler`) are
  ambient — no imports needed.

---

## Schema conventions

- Migrations: `schema/NNNN_<name>.sql`. Numbered. Forward-only. Re-runnable
  (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).
- Primary keys: UUID (`crypto.randomUUID()`) for entity tables; `INTEGER PRIMARY KEY
  AUTOINCREMENT` only for append-only log tables (`ownership_history`, `feedback`).
- **Timestamps: ISO 8601 strings** stored as `TEXT NOT NULL DEFAULT (datetime('now'))`.
  v1 used Unix seconds; v2 switched because ISO is human-readable in D1 console output and
  natively sortable. Don't mix.
- JSON columns: stringify on write, parse on read. Never store nested JSON across separate
  columns when one JSON column captures the shape.
- `_schema_migrations` tracks applied filenames — every numbered file inserts its own
  `INSERT OR IGNORE` row at the bottom.

---

## Voice and prompts

- Arcadia's voice is canon — see `SOUL.md`. Smart, concise, no filler, leads with the
  answer. Names people. Cites ownership signals when relevant.
- System prompts are assembled at the call site (no central registry in v2 yet — the
  charter store + `src/charter/inject.ts` will arrive with the intelligence layer).
- When in doubt about tone or framing, re-read `SOUL.md`.

---

## Key patterns

### AI router
```typescript
import { Router } from "../ai/router";
const router = new Router(env);
const result = await router.complete({
  system: "...",
  messages: [{ role: "user", content: "..." }],
  tier: "balanced",        // optional; auto-selected from prompt length if omitted
  maxTokens: 600,
});
```

### Memory recall (always pass `viewer` for permission-aware reads)
```typescript
import { MemoryStore } from "../memory/store";
const store = new MemoryStore(env);
const hits = await store.recall("who owns onboarding for ACME?", {
  scopeType: "channel",
  scopeId,
  viewer: userAadId,
  limit: 5,
});
```

### Graph call (app-only by default; pass `token` for delegated)
```typescript
import { graph } from "../graph/client";
const msgs = await graph(env, {
  path: `/teams/${teamId}/channels/${channelId}/messages`,
  query: { $top: 50 },
});
```

### Adaptive Cards — always Universal Actions
- Every card uses `Action.Execute` with a typed `Verb` from `src/cards/types.ts`.
- Every card includes a `refresh` block keyed to recipient AAD ids so each viewer sees
  an ACL-filtered render.
- Never use `Action.Submit`.

### Logging
```typescript
import { logger } from "../lib/logger";
const log = logger({ env, requestId });
log.info("event_name", { field: value });
```

---

## Do not touch (stable / canonical)

- `SOUL.md` — read it; don't modify it.
- `ARCHITECTURE.md` — modify only when intentionally revising the v2 contract, and update
  this file (`claude.md`) in the same commit.
- Applied migrations under `schema/` — never edit a file already listed in
  `_schema_migrations`. Add a new numbered migration instead.
- `evals/` — eval cases are kept stable across commits. Add new ones; don't rewrite
  existing ones unless reviewing the harness explicitly.

---

## Working notes

- This is a Worker. There is no Node filesystem at runtime. Don't reach for `fs`,
  `path`, `child_process`. Build-time scripts (`scripts/migrate.ts`) run under `tsx`
  and can use Node modules; runtime code under `src/` cannot.
- The Workers bundle stays slim — prefer raw `fetch` over heavy SDKs. The
  `@microsoft/agents-bot-*` packages are pulled in because the SDK is the architectural
  contract; `@anthropic-ai/sdk` is in deps but the runtime uses fetch directly.
- `ctx.waitUntil(...)` extends a Worker's lifetime beyond the response. Use it for
  fire-and-forget memory writes and outbound posts. Don't use it for anything the user
  needs to see succeed before getting a reply.
- When a route returns 501, the module's commit hasn't landed yet. Check the build order
  above — if the next entry covers it, that's the next commit to make.
