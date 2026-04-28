# CLAUDE.md — Arcadia

## File Writing
When writing any file larger than ~150 lines, write it in sequential sections
using multiple tool calls. Never attempt to generate a large file in a single write.

## Plan Files
Write plan files incrementally — structure first, then fill each section separately.

## Agent Runs
Prefer focused, scoped sub-agent tasks. Avoid chaining more than 2 agents
in a single turn on large codebases.

---

## Project Overview

Arcadia is a Teams-native AI operations layer built on Cloudflare Workers. It runs
entirely serverless: Workers (TypeScript), D1 (SQLite), KV, Workers AI (Gemma 4 26B),
and Cloudflare Vectorize. The bot is registered via Azure Bot Framework and speaks to
Microsoft Teams via the Bot Framework REST API.

**Tech stack:**
- Runtime: Cloudflare Workers (TypeScript 5.x, strict mode, exactOptionalPropertyTypes)
- Storage: D1 (persistent), KV (cache/rate limits)
- AI: Cloudflare Workers AI — `@cf/google/gemma-4-26b-a4b-it` (default model)
- Auth (bot/app): Azure AD client credentials (Application permissions) via `src/auth/token-manager.ts`
- Auth (webapp): MSAL + Authorization Code PKCE + server-side token exchange (`src/webapp/auth.ts`)
- Graph API client (app token): `src/graph/client.ts` → `graphGet`, `graphPost`
- Graph API client (user token): `src/webapp/graph-delegated.ts` → `userGraphGet`, `userGraphPost`

**Entry point:** `src/index.ts` — HTTP router + cron scheduler

---

## Architecture Layers

```
src/
  index.ts                  ← Worker entry: HTTP routes + cron dispatch
  bot/                      ← Teams bot: handler, commands, intents, memory recording
  ai/                       ← Prompt registry, model router, summarize, Q&A
  graph/                    ← App-token Graph client: messages, subscriptions, users
  intelligence/             ← Digest, morning/evening briefs, stale detection, nudge, profiles
  memory/                   ← D1 long-term memory, KV helpers, consolidation, vectors, palace
  tasks/                    ← Task detection, assignment, D1 store
  pipeline/                 ← Unified bot+webapp AI pipeline (arcadia-pipeline.ts)
  research/                 ← Autoresearch: scanner, bridge detection, questions
  webapp/                   ← SSO webapp: auth, chat handler, conversation store, M365 context
  responses/                ← Shared HTTP response formatters
  constants.ts              ← KV keys, Graph URLs, Teams constants, AI defaults
  features.ts               ← Feature flag helpers (env var → boolean)
  types.ts                  ← All shared TypeScript interfaces and row types
```

---

## Active Development Focus: Per-User Intelligence (Phase 9)

The current gap: the Teams bot uses **Application permissions** and reads only its own
conversation context. Every daily brief says "All quiet" because Arcadia isn't listening
to the tenant — it's listening only to itself.

**Goal:** Make Arcadia a personal assistant to each user by:
1. Implementing delegated OAuth flow so each user grants Arcadia access to their account
2. Reading the user's Teams/Channels/Chats via their delegated token
3. Letting users configure per-user report sources and schedules via the webapp
4. Delivering personalised daily/weekly reports based on what they care about

### What Already Exists (do not rebuild)

- `src/webapp/auth.ts` — Full MSAL + PKCE + server-side token exchange. Sessions stored
  in D1 `webapp_sessions` with AES-GCM encrypted tokens. **This is the delegated auth flow.**
- `src/webapp/graph-delegated.ts` — `userGraphGet` / `userGraphPost` using user tokens
- `src/webapp/context/teams.ts` — `getUserTeams`, `getTeamChannels`, `getUserChats`,
  `getChannelMessages`, `getChatMessages`, `fetchUserFullContext` — all delegated
- `schema/d1-phase7-webapp.sql` — `webapp_sessions`, `webapp_conversations`, `webapp_messages`
- `schema/d1-phase8-teams-auth.sql` — `linked_users` table (bot checks this before DM)
- `src/memory/d1.ts` → `isUserLinked`, `upsertLinkedUser` — bot gates DMs on webapp auth

The webapp SSO already works. Users who sign in via `/app` get a session with delegated
tokens. The `linked_users` table already gates bot DMs. The **missing piece** is using
those delegated tokens to power scheduled per-user reports.

### What Needs to Be Built (Phase 9)

**Schema additions (d1-phase9.sql):**
- `user_report_configs` — user_id, config_name, report_type (daily|weekly), schedule_hour,
  active, created_at, updated_at
- `report_sources` — id, user_id, config_id, source_type (team|channel|chat), source_id,
  source_name, label (user-defined e.g. "GNC Project"), created_at
- `report_log` — id, user_id, config_id, generated_at, delivered_at, status, content_preview

**New modules:**
- `src/intelligence/user-reports.ts` — per-user report generation using delegated tokens
  - `generateUserReport(userId, configId, env)` — fetches sources via user's delegated token,
    calls Claude API with Arcadia voice, returns formatted report
  - `runUserReportCron(env)` — scans `user_report_configs` for due reports, calls above
- `src/webapp/api/reports.ts` — REST endpoints for report config CRUD
  - `GET /api/webapp/reports/configs` — list user's report configs
  - `POST /api/webapp/reports/configs` — create config
  - `PUT /api/webapp/reports/configs/:id` — update config
  - `DELETE /api/webapp/reports/configs/:id` — delete config
  - `GET /api/webapp/reports/configs/:id/sources` — list sources for a config
  - `POST /api/webapp/reports/configs/:id/sources` — add source
  - `DELETE /api/webapp/reports/configs/:id/sources/:sourceId` — remove source
  - `GET /api/webapp/reports/history` — list past reports for user
  - `POST /api/webapp/reports/configs/:id/run` — trigger report manually

**Bot changes:**
- `src/bot/handler.ts` → after DM auth check passes, detect report setup intent and send
  webapp deep link: `[Set up your reports →](${workerUrl}/app?tab=reports)`
- Add `report-setup` to `CommandIntent` type and intent registry

**Cron changes (`src/index.ts`):**
- Add `"0 * * * *"` (hourly) cron to `handleScheduled` → calls `runUserReportCron`
- Delivery: post completed report to user's Teams DM using Bot Framework proactive messaging
  (same pattern as `src/intelligence/digest.ts` → `postToChannel`)

**Webapp UI additions (`src/webapp/frontend/`):**
- Add "Reports" tab to the webapp sidebar
- Source picker: calls `/api/webapp/context/teams` and `/api/webapp/context/chats` to
  populate a selectable list of Teams/Channels/Chats
- Report config form: name, type (daily/weekly), delivery hour, sources list, labels
- Report history view: past reports with content preview

---

## Key Patterns — Follow These

### Token retrieval for delegated calls
```typescript
// Always get token via getSessionAccessToken — it handles refresh
import { getSessionAccessToken } from "../webapp/auth.js";
const accessToken = await getSessionAccessToken(session, env);
```

### Delegated Graph calls
```typescript
import { userGraphGet } from "../webapp/graph-delegated.js";
const msgs = await userGraphGet<GraphListResponse<GraphMessageRaw>>(
  `/teams/${teamId}/channels/${channelId}/messages?$top=25`,
  accessToken
);
```

### Token retrieval for per-user report cron (no active session)
The report cron runs on schedule — no HTTP request, no session cookie. Decrypt the stored
token directly from `webapp_sessions`:
```typescript
import { decryptToken } from "../webapp/crypto.js";
const row = await env.ARCADIA_DB.prepare(
  "SELECT * FROM webapp_sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1"
).bind(userId).first<WebappSessionRow>();
const accessToken = await decryptToken(row.access_token, env.WEBAPP_SESSION_SECRET);
```

### Proactive bot DM delivery
Follow the pattern in `src/intelligence/digest.ts` → `postToChannel`. The conversation
reference for a user's DM with Arcadia is stored in `linked_users` (add `conversation_id`
and `service_url` columns in Phase 9 schema if not present).

### AI call pattern
```typescript
import { callAI } from "../ai/router.js";
const { text } = await callAI(systemPrompt, userPrompt, env);
```

### D1 query pattern
```typescript
const result = await env.ARCADIA_DB.prepare(
  "SELECT * FROM table WHERE user_id = ? AND active = 1"
).bind(userId).all<RowType>();
return result.results;
```

### Feature flags
```typescript
import { features } from "../features.js";
if (!features.webapp(env)) return;
```

### New feature flags needed
Add to `Env` interface in `src/types.ts`:
```typescript
USER_REPORTS_ENABLED: string;  // "true" | "false"
```
Add to `src/features.ts`:
```typescript
userReports: (env: Env) => flag(env.USER_REPORTS_ENABLED),
```
Add to `wrangler.toml` `[vars]`:
```
USER_REPORTS_ENABLED = "true"
```

---

## TypeScript Rules

- **`exactOptionalPropertyTypes: true`** — never pass `undefined` for optional properties;
  omit the property entirely or use a conditional spread: `...(val !== undefined ? { key: val } : {})`
- **`noUncheckedIndexedAccess: true`** — array/map access returns `T | undefined`; always
  check or use `!` with intent
- All imports use `.js` extension (ESM, bundler resolution)
- No `any` unless wrapping CF Workers AI (which uses overloaded signatures)
- D1 row types live in `src/types.ts`; domain objects are separate interfaces

---

## Schema Conventions

- Primary keys: UUID (`crypto.randomUUID()`) for app-created rows, integers for log tables
- Timestamps: Unix seconds (`Math.floor(Date.now() / 1000)`) stored as INTEGER
- JSON columns: stringify on write, parse on read; never store nested JSON in separate columns
- All migrations are additive — never drop or rename columns in existing tables
- New schema files go in `schema/` as `d1-phase{N}.sql`

---

## Prompt / AI Conventions

- All prompts live in `src/ai/prompts.ts` or `src/ai/prompts-phase6.ts`
- Register every new prompt builder via `registerPrompt(key, builder)` from `prompt-registry.ts`
- Arcadia's voice: smart, concise, no filler, leads with the answer — see `SOUL.md`
- Report summaries should use `buildDMSystemPrompt` or a new `buildReportSystemPrompt`
  that injects the user's name, their configured source labels, and Arcadia's base persona

---

## Files You Will Touch Most

| File | Why |
|------|-----|
| `src/types.ts` | Add new row types and Env vars |
| `src/intelligence/user-reports.ts` | **New** — core report generation logic |
| `src/webapp/api.ts` | Add report config endpoints |
| `src/webapp/chat.ts` | Minor: pass report context if relevant |
| `src/bot/handler.ts` | Add report-setup intent routing |
| `src/index.ts` | Add hourly cron, register new handlers |
| `schema/d1-phase9.sql` | New tables |
| `src/features.ts` | Add USER_REPORTS_ENABLED |
| `wrangler.toml` | Add new var |

---

## Do Not Touch (Stable)

- `src/memory/` — Memory system is stable through Phase 6. Do not alter consolidation logic.
- `src/research/` — Autoresearch is complete. Add nothing unless fixing a bug.
- `src/webapp/auth.ts` — Session/token logic is correct and tested. Do not modify.
- `src/webapp/crypto.ts` — Crypto primitives. Do not modify.
- `schema/d1-phase*.sql` (phases 1–8) — Never modify existing migrations.
- `SOUL.md` — Canonical character document. Read it; don't modify it.

---

## Bot Proactive DM Pattern (reference for report delivery)

```typescript
// From src/intelligence/digest.ts — replicate this pattern for user report delivery
const tokenRes = await fetch(GRAPH.TOKEN_URL(env.GRAPH_TENANT_ID), {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.TEAMS_APP_ID,
    client_secret: env.TEAMS_APP_PASSWORD,
    scope: BOT_FRAMEWORK.SCOPE,
  }).toString(),
});
const { access_token } = await tokenRes.json() as { access_token: string };
const url = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "message", text: content, textFormat: "markdown" }),
});
```

The user's `serviceUrl` and DM `conversationId` must be stored when the user first
messages Arcadia in Teams. Add these columns to `linked_users` in Phase 9 schema,
and populate them in `src/bot/handler.ts` → `handleConversationUpdate` when `isDM === true`
and the user is already linked.
