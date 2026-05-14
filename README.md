# Arcadia

**Arcadia** is a Microsoft 365 AI operations layer for staff. She runs on
Cloudflare Workers, speaks to Microsoft Teams and to a web dashboard, holds
context across conversations, and surfaces what matters — decisions, owners,
stalled work, customer signals.

She is built on the **Microsoft 365 Agents SDK**, uses **Anthropic Claude**
for reasoning, and uses **Microsoft Graph** as her view into the tenant.

## Read these first

- **`SOUL.md`** — Arcadia's character, voice, values, commitments. Canonical.
- **`ARCHITECTURE.md`** — How v2 is built. The technical contract.
- **`claude.md`** — Operating instructions for AI agents editing this codebase.

## Quick start

```bash
npm install
npx wrangler login

# Create Cloudflare resources (once per environment)
npx wrangler d1 create arcadia-db
npx wrangler kv namespace create ARCADIA_CACHE
npx wrangler vectorize create arcadia-memory-vectors --dimensions=768 --metric=cosine
npx wrangler queues create arcadia-ingest

# Apply schema (idempotent)
npm run db:migrate            # local
npm run db:migrate:remote     # production

# Set secrets — see .env.example
npx wrangler secret put TEAMS_APP_ID
# …

# Deploy
npm run deploy
```

## Stack

- **Runtime**: Cloudflare Workers (edge serverless)
- **Agent framework**: Microsoft 365 Agents SDK (TypeScript)
- **Language**: TypeScript 5.7 strict
- **Storage**: D1 + KV + Vectorize + Queues
- **AI**: Anthropic Claude (Haiku / Sonnet) + Cloudflare Workers AI (Gemma)
- **Graph**: Microsoft Graph (app-only + delegated, MSAL on-behalf-of)
- **Frontend**: SvelteKit + Microsoft Graph Toolkit, hostable as a Teams Tab

## Surfaces (v2 launch)

- **Microsoft Teams** — `@Arcadia` bot in channels + 1:1, Universal-Action digests + task cards
- **Web dashboard** (`web/`) — chat, routines, memory, sources, settings
- **Teams Dashboard Tab** — the web app, embedded

Microsoft 365 Copilot, Outlook, and Foundry hosting are deferred from v2 launch.
See `ARCHITECTURE.md §9`.

## What v2 inherits from v1 (re-implemented)

- Four-layer memory: episodic / semantic / procedural / observation
- Tiered AI router (Workers AI → Haiku → Sonnet)
- Per-user ACL with sensitivity-label redaction
- Routines (cron + event triggered)
- Digest, stale detection, nudge engine, morning brief, evening wrap-up, weekly report
- Eval harness with nightly regression gate
- Operator Charter (ground-truth injection)

## What v2 adds

- Microsoft 365 Agents SDK runtime (replaces hand-rolled Bot Framework)
- Universal Actions on every Adaptive Card (refresh + sequential workflows)
- Microsoft Search API (people, files, messages) as a recall surface
- Presence API (don't nudge people who are busy)
- OnlineMeeting transcripts → decisions + tasks
- Activity Feed Notifications as the first-class proactive surface
- Bi-directional Planner / To Do sync
- Arcadia-as-MCP-server (interoperable with Claude Desktop, Foundry, Copilot Studio)
- OpenAPI 3.1 publishing → Power Automate connector for free
- Microsoft 365 Copilot Connector — Arcadia outputs indexed into tenant search
- Agent 365 manifest (Entra Agent ID, Purview eDiscovery, Defender mapping)
- Microsoft Graph Toolkit components in the web app

## License

Proprietary. © S-FX.com.
