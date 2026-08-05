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
| 1b — Stall Radar + Certification Ledger | Ground-truth stall signals; signed, verified checklists | Stubs + D1 schema in place; blocked on §10.1 |
| 2 — Memory core + Ask Arcadia | Full ingestion pipeline, Teams surface | Driver + self-hosted profiles live; pipeline pending |
| 3 — Dispatch + escalation enforcement | Next-action dispatch, pass-through detection | Not started |
| 4 — Site planning | Kamino successor | Not started |
| 5 — Agent Memory migration | Driver swap when GA | Stub in place |

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
  agents/                     Arcadia (root), Hermes, Radar (1b), Ledger (1b)
  workflows/                  publish.ts (9-step Hermes chain), ratify.ts (doctrine)
  memory/                     driver.ts (§5.1 interface), self-hosted.ts (DO+Vectorize+FTS5+RRF)
  integrations/               anthropic.ts (AI Gateway), wordpress.ts, graph.ts (1b stub)
  approval/dashboard.tsx      Access-protected approval UI (server-rendered)
  lib/                        access, audit, brand/voice, controls (kill switch, rate, window)
  schema/                     d1.sql (operational schema), types.ts
reference/                    gitignored clone of cloudflare/agents — never vendored
```

## Controls that must never regress (§4, §8)

- Doctrine never auto-commits: staging → human tap → canonical.
- Hermes publishes nothing without a named human approval for the first 60
  clean days; the kill switch (Shane/Diego/Vicky) halts the next run.
- Rate ceiling is enforced in D1 against what actually shipped.
- Every action is audited append-only with the doctrine entries that informed it.
