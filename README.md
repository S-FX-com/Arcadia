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
| **Cloudflare OS integration** | Gatekeeper capability layer over WordPress / Graph / project memory, plus the os-bridge entrypoint an OS deployment binds | **Built** — see below |

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
                              — raw clients; only their gatekeeper may import them
  gatekeepers/                Cloudflare OS capability layer: types.ts (mirrored contract),
                              log.ts (D1 observation/action queue), wordpress.ts, graph.ts,
                              project-context.ts
  os-bridge/                  ArcadiaOsGatekeeper entrypoint + doctrine skill + Ask Arcadia
                              for a Cloudflare OS deployment to bind as a service
  approval/                   dashboard, admin (models/staff), ledger, board, ask, gatekeepers
  lib/                        access, rbac, audit, brand/voice, controls
  schema/                     d1.sql (operational schema), types.ts
reference/                    gitignored clones of cloudflare/agents and cloudflare/cloudflare-os
                              — never vendored
```

## Cloudflare OS integration

Arcadia adopts the [Cloudflare OS](https://github.com/cloudflare/cloudflare-os)
Gatekeeper security model — capability-based sessions, observation logging,
and an action approval queue — as her own enforcement layer, and exposes an
entrypoint so an OS deployment can front her later. Details:

- **Sessions are scoped at mint.** A WordPress session is pinned to the
  tutorials CPT on one site; a Graph session to one project's plan, folder,
  and channel; a memory session to one `sfx-project-{id}` profile. There is
  no method to point a session anywhere else, and none of these modules can
  address `sfx-doctrine-canonical` at all — promotion stays the only write
  path (§5.6.1).
- **Reads are observations.** Logged append-only to `gk_observations` before
  data returns to the caller. Visible on the dashboard under Gatekeepers.
- **Side effects are actions.** Queued in `gk_actions` and applied only with
  recorded authorization the gatekeeper verifies itself: a live WordPress
  publish requires a matching approved row in `approvals` (or the human-enabled
  auto-publish control) and re-checks the kill switch; a Planner write requires
  a dispatch rule naming the human it acts for. A `pending`/`failed` row here
  is the guardrail firing.
- **Credentials stay in the gatekeeper.** `src/integrations/wordpress.ts` and
  `graph.ts` are imported only by their gatekeepers; workflow and agent code
  gets capabilities, never clients or secrets.
- **os-bridge** (`src/os-bridge/`) exports `ArcadiaOsGatekeeper`, a
  WorkerEntrypoint a Cloudflare OS deployment (from
  [cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter))
  binds as a service. It serves canonical doctrine + brand voice as an agent
  catalog with search/read, and Ask Arcadia with the confidence floor intact.
  Every response is `{ data, observation }`; the OS-side adapter must
  authorize the observation against its ApprovalQueue before handing data to
  a gadget. It is read-only, RBAC-checked per actor, and unreachable over HTTP.

To study the OS side, clone it into the gitignored reference directory:
`git clone https://github.com/cloudflare/cloudflare-os reference/cloudflare-os`.

## Controls that must never regress (§4, §8)

- Doctrine never auto-commits: staging → human tap → canonical.
- Hermes publishes nothing without a named human approval for the first 60
  clean days; the kill switch (Shane/Diego/Vicky) halts the next run.
- Rate ceiling is enforced in D1 against what actually shipped.
- Every action is audited append-only with the doctrine entries that informed it.
