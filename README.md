# Arcadia

**Arcadia** is a Teams-native AI operations layer built on Cloudflare Workers. It acts as a persistent intelligence layer inside Microsoft Teams channels — understanding conversations, surfacing decisions, tracking task ownership, detecting stalled work, and proactively nudging the team to keep projects moving.

---

## What it does

Arcadia transforms raw Teams channel conversations into actionable intelligence:

- **Daily digests** — summarizes the last 24h of channel activity, decisions made, and open items
- **On-demand summarization** — `@Arcadia summarize` produces a structured summary of any thread
- **Decision & task extraction** — pulls decisions and next steps from conversation history
- **Ownership tracking** — detects who owns what from natural language, with a full immutable audit trail
- **Stale thread detection** — flags threads with no activity beyond a configurable threshold
- **Proactive nudges** — identifies at-risk tasks (no owner, missed deadline, no progress) and posts reminders, rate-limited to avoid spam
- **Weekly reports** — Monday morning operational roll-ups per channel
- **Context-aware Q&A** — `@Arcadia who owns X?` and similar queries answered from channel history

---

## Architecture

```
Microsoft Teams
     |
     | Bot Framework (webhook)
     v
Cloudflare Worker (src/index.ts)
     |
     +---> Bot Layer          (src/bot/)          — command parsing, auth, responses
     +---> AI Layer           (src/ai/)           — tiered model router, prompts, summarization
     +---> Graph Layer        (src/graph/)         — Teams API client, messages, subscriptions
     +---> Intelligence Layer (src/intelligence/)  — digests, stale detection, nudge engine, weekly reports
     +---> Tasks Layer        (src/tasks/)         — task detection, assignment, ownership
     |
     +---> KV Store   (ARCADIA_CACHE)   — cache, tokens, rate limits
     +---> D1 SQLite  (ARCADIA_DB)      — threads, tasks, ownership history, digests
```

### Scheduled jobs

| Schedule | Job |
|---|---|
| `0 8 * * *` (daily) | Stale detection → Digest → Nudge engine → Subscription renewal |
| `0 8 * * 1` (weekly Monday) | Operational report per channel |

---

## AI model routing

Arcadia automatically picks the cheapest model that can handle the job:

| Token count | Model | Cost |
|---|---|---|
| < 4K | Cloudflare Workers AI — Gemma 4 26B | Free |
| < 16K | Claude Haiku | Low |
| 16K+ | Claude Sonnet | Higher quality |

Fallback cascades automatically on error. Streaming is supported via SSE.

---

## Bot commands

| Command | What it does |
|---|---|
| `@Arcadia summarize` | Summarizes the current thread |
| `@Arcadia decisions` | Lists decisions made in the channel |
| `@Arcadia next steps` | Extracts open action items |
| `@Arcadia status` | Current thread status and owner |
| `@Arcadia who owns [X]` | Resolves ownership of a topic or task |
| `@Arcadia assign [task] to [name]` | Creates a tracked task with explicit owner |
| `@Arcadia draft [context]` | Drafts a message based on conversation context |
| `@Arcadia tasks` | Lists open tasks in this channel |

---

## Tech stack

- **Runtime**: Cloudflare Workers (serverless, edge)
- **Language**: TypeScript 5.7 (strict)
- **Storage**: Cloudflare KV (cache/rate limits) + Cloudflare D1 SQLite (persistent data)
- **AI**: Cloudflare Workers AI (Gemma 4 26B) + Anthropic Claude (Haiku / Sonnet)
- **Auth**: JWT (Bot Framework) + OAuth 2.0 client credentials (Microsoft Graph)
- **External APIs**: Microsoft Bot Framework, Microsoft Graph API, Anthropic API

---

## Database schema

**D1 tables:**

| Table | Purpose |
|---|---|
| `threads` | Thread activity tracking, staleness, ownership |
| `channels` | Registered Teams channels (team ID, service URL, conversation ID) |
| `digest_log` | Audit trail of every posted digest |
| `tasks` | Task tracking with deadline, priority, nudge state |
| `ownership_history` | Immutable append-only ownership change log |
| `graph_subscriptions` | Microsoft Graph change notification subscriptions |
| `weekly_report_log` | Weekly report archive |

---

## Setup

### 1. Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers, KV, D1, and Workers AI enabled
- Azure AD app registration with Graph API permissions (`ChannelMessage.Read.All`, `User.Read.All`)
- Azure Bot Service registration (Bot Framework)
- Node.js 18+, Wrangler 3.x

### 2. Install dependencies

```bash
npm install
```

### 3. Create Cloudflare resources

```bash
# Create KV namespace
wrangler kv:namespace create ARCADIA_CACHE

# Create D1 database
wrangler d1 create arcadia-db
```

Update the IDs returned into `wrangler.toml`.

### 4. Initialize the database

```bash
# Local dev
wrangler d1 execute arcadia-db --file=schema/d1-init.sql

# Remote (production)
wrangler d1 execute arcadia-db --remote --file=schema/d1-init.sql
wrangler d1 execute arcadia-db --remote --file=schema/d1-phase2.sql
```

### 5. Set secrets

```bash
wrangler secret put TEAMS_APP_ID
wrangler secret put TEAMS_APP_PASSWORD
wrangler secret put GRAPH_TENANT_ID
wrangler secret put GRAPH_CLIENT_ID
wrangler secret put GRAPH_CLIENT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GRAPH_NOTIFICATION_SECRET   # Phase 2 only
```

See `.env.example` for all required values.

### 6. Deploy

```bash
npm run deploy
```

### 7. Configure the Teams app

- Set your Worker URL as the messaging endpoint in Azure Bot Service: `https://<your-worker>.workers.dev/api/messages`
- Package and upload `manifest/manifest.json` to the Teams Admin Center or sideload via App Studio

---

## Development

```bash
npm run dev              # Local dev server (wrangler dev)
npm run type-check       # TypeScript type check
npm run test:scheduled   # Test cron triggers locally
```

---

## Configuration reference

Set in `wrangler.toml` under `[vars]`:

| Variable | Default | Description |
|---|---|---|
| `STALE_THREAD_HOURS` | `48` | Hours before a thread is considered stale |
| `MAX_MESSAGES_CACHED` | `100` | Max messages stored in KV per channel |
| `DIGEST_CRON_HOUR` | `8` | UTC hour for daily digest |
| `CF_AI_DEFAULT_MODEL` | `@cf/google/gemma-3-27b-it` | Default Cloudflare AI model |
| `NUDGE_COOLDOWN_HOURS` | `8` | Minimum hours between nudges per task |
| `NUDGE_MAX_PER_RUN` | `5` | Max nudges posted per cron run |
| `WEEKLY_REPORT_ENABLED` | `true` | Enable/disable weekly reports |

---

## Design decisions

- **KV for cache, D1 for persistence** — ephemeral data (messages, tokens, rate limits) lives in KV with TTLs; structured audit data lives in D1
- **Regex intent detection** — commands are parsed with regex patterns, not ML, for sub-millisecond latency and zero cost
- **Tiered AI router** — automatic cost optimization; small prompts use free Gemma 4, larger ones escalate to Claude
- **Append-only ownership log** — `ownership_history` is never mutated, only appended, for a complete audit trail
- **KV TTL for rate limiting** — nudge cooldowns are implemented as KV keys with expiry, no cron cleanup needed
- **Language-aware responses** — conversation language is detected via Unicode block analysis; Arcadia responds in the same language

---

## Project structure

```
src/
  index.ts              — Worker entry point, HTTP + cron routing
  types.ts              — Shared TypeScript interfaces
  bot/                  — Bot Framework handler, command parser, auth
  ai/                   — Model router, prompts, summarize, Q&A
  graph/                — Graph API client, messages, subscriptions, users
  intelligence/         — Digest, stale detection, nudge engine, weekly reports
  memory/               — KV helpers, D1 query layer
  tasks/                — Task detection, assignment, store
schema/
  d1-init.sql           — Core schema (Phase 1)
  d1-phase2.sql         — Task/subscription schema (Phase 2)
manifest/
  manifest.json         — Teams app manifest
```
