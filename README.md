# Arcadia — S-FX Operations Intelligence Layer (v4)

Internal operations agent for S-FX.com Small Business Solutions. Runs entirely
on Cloudflare — Workers, the `agents` SDK on SQLite-backed Durable Objects,
Workflows, D1, Vectorize, R2, Queues, Workers AI, and Anthropic via AI
Gateway. She reads the tenant, watches project activity, enforces quality
gates, holds institutional memory, and publishes content.

**She is not a chatbot with a nice personality. She is an accountability
instrument.** Arcadia surfaces and attributes; humans decide and sign. The
full spec is [CLAUDE.md](./CLAUDE.md) — v4, which supersedes the v2/v3 scope
docs (v2 lives in git history before the v4 restructure commit).

## Status

| Phase | Scope | State |
|---|---|---|
| **1a — Hermes** | SEO tutorials → WordPress with a human approval gate | **Built** — awaiting the human-only steps in §9, then acceptance |
| **1b — Certification Ledger** | Signed immutable checklists + six independent verifiers; false-certification rate per person and pod | **Built** |
| **1b — Stall Radar** | Ground-truth signals, day 3/5/7 public escalation ladder | **Built** — git + staging live; Planner/SharePoint/Teams need Graph consent (§9.7) |
| **2 — Memory core** | Full §5.3 ingestion (pass A + mandatory pass B + verification), Ask Arcadia with confidence floor and gap queue | **Built** on the dashboard; Teams surface needs the Azure Bot |
| **3 — Dispatch + enforcement** | Skill-matched dispatch, idle→lead pings, unskippable stages, SLA breaches, pass-through detection | **Built** |
| **4 — Site planning** | Crawl → diagnose → nav map → page specs, reasoning on every decision | **Built** |
| 5 — Agent Memory migration | Driver swap when Cloudflare Agent Memory hits GA | Stub against the same interface |

Every phase past 1a is code-complete but unexercised against real data — the
acceptance criteria in CLAUDE.md §4 are the bar, and they need live tenant
data plus the §9 human steps to meet.

## Quick start

```sh
npm install
npm run setup          # creates D1, KV, R2, queues, Vectorize indexes
# paste the printed D1/KV ids into wrangler.jsonc, then do the §9 human steps
npm run db:apply:remote
npx wrangler deploy
```

Then open `/approval` (behind Cloudflare Access) — queue a topic, trigger a
run, approve the draft, watch it land on `/how-do-i/`.

## Layout

```
CLAUDE.md                     the spec — read it before writing code
wrangler.jsonc                bindings: 5 DOs, 2 workflows, D1/KV/R2/Vectorize/Queues/AI
scripts/setup.sh              repeatable provisioning (human steps excluded)
src/
  index.ts                    worker entry: fetch / scheduled (bootstrap) / queue
  ai/                         router.ts (task→model routing), types.ts (defaults), workers-ai.ts
  agents/                     Arcadia (root), Hermes, Radar, Ledger, Dispatcher
  workflows/                  publish.ts (9-step Hermes chain), ratify.ts, siteplan.ts
  memory/                     driver.ts (§5.1), self-hosted.ts (DO+Vectorize+FTS5+RRF), ingest.ts (§5.3)
  certification/              checklists.ts (5 launch checklists), verify.ts (6 verifiers)
  radar/signals.ts            ground-truth stall signals
  dispatch/stages.ts          the review chain, SLAs, pass-through floors
  site/plan.ts                crawl, diagnose, nav map, page specs
  integrations/               anthropic.ts (AI Gateway), wordpress.ts, graph.ts, notify.ts
  approval/                   dashboard, admin (models/staff), ledger, board, ask
  lib/                        access, rbac, audit, brand/voice, controls
  schema/                     d1.sql (operational schema), types.ts
reference/                    gitignored clone of cloudflare/agents — never vendored
```

## Controls that must never regress (§4, §8)

- Doctrine never auto-commits: staging → human tap → canonical.
- Hermes publishes nothing without a named human approval for the first 60
  clean days; the kill switch (Shane/Diego/Vicky) halts the next run.
- Rate ceiling is enforced in D1 against what actually shipped.
- Every action is audited append-only with the doctrine entries that informed it.
