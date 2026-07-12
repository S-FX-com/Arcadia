# ARCHITECTURE.md — Arcadia v2

> **This document is the contract.** It supersedes every prior `PHASE*.md` and
> the v1 layout described in the historical `README.md`. `SOUL.md` remains
> canonical for character and values. `claude.md` remains canonical for
> operational instructions to agents working on the codebase. `OPERATING.md`
> and `RUNBOOK.md` will be rewritten to match v2.

---

## 1. Why we're rebuilding

Arcadia v1 was a hand-rolled Bot Framework integration over Cloudflare Workers
with a phase-by-phase evolution (Phases 0 – 17). It works, but reimplements
several layers Microsoft now provides as supported components:

- The **Microsoft 365 Agents SDK** is AI-agnostic (works with Anthropic), gives
  us a channel abstraction (Teams + Webchat + Copilot in one binary), state +
  storage + event routing primitives, and a TypeScript runtime that hosts on
  Workers.
- The **Microsoft Teams SDK** (formerly Teams AI Library v2) gives us MCP +
  A2A + streaming + memory wrappers natively.
- **Universal Actions** (`Action.Execute`), Sequential Workflows, and
  Adaptive-Card Loop components turn one-shot cards into live, refreshable,
  per-viewer surfaces that match Arcadia's ACL model.
- **Microsoft Search**, **People API**, **Presence**, **Online Meetings**,
  **Activity Feed Notifications**, and **Copilot Connectors** are first-class
  Graph capabilities the v1 stack does not yet use.
- **Agent 365** is now GA and is the governance plane every agent in the
  tenant must register against.

v2 keeps Arcadia's soul, memory model, and operational behaviours, and rebuilds
the substrate underneath them on supported foundations.

---

## 2. What is being torn down (v1 → v2)

| Removed | Why |
| --- | --- |
| `src/bot/` (raw Bot Framework handler) | Replaced by `src/runtime/` on Microsoft 365 Agents SDK |
| `src/agent/` (custom tool loop) | Replaced by SDK-native tool calling + MCP |
| `src/webapp/` (hand-rolled HTTP API) | Replaced by `src/webapp/` re-implemented as typed route table over the SDK |
| `src/index/`, `src/pipeline/`, `src/research/`, `src/responses/` | Folded into `src/intelligence/` or removed; were duplicate or scaffolding |
| `schema/d1-phase*.sql` (17 files) | Consolidated into `schema/0001_init.sql` + future numbered migrations |
| `botbuilder` direct dependency | Replaced by `@microsoft/agents` SDK |
| Phase rollout vars (`AGENT_LOOP_ENABLED`, `ACL_ENFORCEMENT`, etc.) | Removed — v2 ships strict from day one |
| `PHASE10.md`, `PHASE11.md` | Their intent is captured in this document |
| `OPERATING.md` (v1 form) | Will be replaced with v2-shaped operating guide |

All v1 production data is considered disposable (per Shane, v1 was test-only).

> **v2.1 correction (decision D4 in `EXECUTION-PLAN.md`).** The rows above
> that describe the **Microsoft 365 Agents SDK** as the runtime were the
> original v2 aspiration — they were **not** carried through. v2.1 kept the
> **hand-rolled Bot Framework runtime** (`src/runtime/*`: raw JWT verify,
> activity dispatch, outbound, invoke-dispatch, cron-dispatcher) because it
> works and the SDK's real payoff (channel abstraction for
> Copilot / Outlook / Webchat) is deferred scope (§9). MCP is likewise
> hand-rolled JSON-RPC (`src/mcp/*`), not the MCP SDK. The unused
> `@microsoft/agents-activity`, `@microsoft/agents-hosting`, and
> `@modelcontextprotocol/sdk` dependencies have accordingly been **removed**
> from `package.json`. Where §1 and this section still say "Agents SDK",
> read "hand-rolled Bot Framework runtime". The SDK will be revisited only
> if/when Copilot or Outlook channels become a priority.

## 3. What is preserved (in spirit, re-implemented in code)

| Preserved | Where it lives in v2 |
| --- | --- |
| The four-layer memory model (episodic / semantic / procedural / observation) | `src/memory/*` re-implemented against a unified `memories` table with a `kind` column and graph edges |
| Tiered AI router (Workers AI → Haiku → Sonnet) | `src/ai/router.ts` |
| ACL model (per-user resource access, group memberships, sensitivity labels) | `src/acl/*` — strict by default |
| Routines (cron + event triggered workflows) | `src/routines/*` on top of SDK activities |
| Digest, stale-thread detection, nudge engine, morning brief, evening wrap-up, weekly report | `src/intelligence/*` |
| Task tracking + ownership history | `src/tasks/*`, with bi-directional Planner sync added |
| Ingest pipeline (mail/drive/sharepoint/calendar/onenote/teams) | `src/ingest/*` |
| Eval harness | `src/eval/*`, `evals/cases/*.json` (kept verbatim) |
| Operator Charter (`charter` table from Phase 17) | `src/charter/*` |
| `SOUL.md`, `claude.md`, `evals/` | Kept verbatim |

---

## 4. Runtime model

```
                   Microsoft Teams        Web app (SvelteKit)
                         |                       |
                         | Bot Framework         | Nested App Auth
                         v                       v
                    +--------------------------------+
                    |   Cloudflare Worker (edge)     |
                    |   src/index.ts                 |
                    |     ├── HTTP /api/messages     |
                    |     ├── HTTP /api/webapp/*     |
                    |     ├── HTTP /api/graph/notify |
                    |     ├── HTTP /api/mcp          |
                    |     ├── HTTP /api/openapi.json |
                    |     ├── HTTP /api/agent365     |
                    |     ├── scheduled() crons      |
                    |     └── queue() consumer       |
                    |                                |
                    |   Microsoft 365 Agents SDK     |
                    |   src/runtime/*                |
                    |     ├── Activity handler       |
                    |     ├── Storage adapter        |
                    |     ├── Channel adapter        |
                    |     └── Tool registry          |
                    +--------------------------------+
                         |          |          |
                         v          v          v
                       D1        KV       Vectorize
                                            + AI Gateway
                                            + Workers AI
                                            + Anthropic
```

### Surfaces in scope for v2
1. **Microsoft Teams** — `@Arcadia` bot in channels + 1:1, proactive digests, Universal Action cards.
2. **Web app** (`web/`) — SvelteKit, Microsoft Graph Toolkit components, hostable as a Teams Dashboard Tab. Routes: `/chat`, `/dashboard`, `/routines`, `/memory`, `/sources`, `/settings`.

### Surfaces explicitly out of scope (for v2 initial cut)
- Microsoft 365 Copilot (declarative agent / API plugin) — deferred.
- Outlook taskpane / message extension — deferred.
- Foundry hosting — deferred.

### Channels the runtime nevertheless supports for free
Because the Agents SDK provides channel abstraction, adding Copilot or Webchat later is a manifest/registration task, not a code rewrite.

---

## 5. Module layout (`src/`)

> **Reflects the v2.1 build (P0–P5 shipped).** This is the real, current
> `src/` inventory — walked from the tree, not the original v2 aspiration.
> For the phase decisions behind the current shape (notably D4: the
> hand-rolled runtime was kept, not the Agents SDK), see `EXECUTION-PLAN.md`.

```
src/
  index.ts                Worker entry: fetch / scheduled / queue
  env.ts                  Typed bindings (D1, KV, Vectorize, AI, secrets)

  runtime/                Hand-rolled Bot Framework runtime (see §2 / D4)
    activity-handler.ts   Inbound activity dispatch (message, invoke, install)
    auth.ts               Bot Framework JWT verification
    bot-outbound.ts       Bot Framework outbound (proactive) helpers
    cron-dispatcher.ts    Routes scheduled() events to behaviours
    invoke-dispatch.ts    Universal Action card → verb dispatch

  ai/                     LLM access
    router.ts             Tiered router: Workers AI → Haiku → Sonnet
    types.ts              Message / CompleteRequest / Tier
    providers/anthropic.ts    Claude (balanced/deep) via fetch + SSE
    providers/cloudflare.ts   Workers AI Gemma (fast tier)

  memory/                 Arcadia's four-layer memory (one table, kind column)
    types.ts              Memory / Kind / Scope / Edge
    store.ts              add / recall / recent / link / forget / prune
    vector.ts             Embedding + Vectorize recall
    consolidation.ts      Light / deep / REM cycles
    profiles.ts           Person + customer longitudinal profiles (P3)
    procedures.ts         Procedural-memory promotion / retirement (P4)
    feedback.ts           Feedback consumption → behaviour (P4)
    self-model.ts         Weekly self-model regeneration

  graph/                  Microsoft Graph (raw fetch, no SDK client)
    client.ts             GraphRequest, retry/throttle, GraphError
    auth.ts               App-only + on-behalf-of token acquisition
    messages.ts           Channel + chat message operations
    subscriptions.ts      Change notifications + lifecycle
    delta.ts              Per-resource delta-query state
    search.ts             Microsoft Search /search/query helper (delegated)
    presence.ts           App-only presence lookups (for the nudge engine)
    calendar.ts           Calendar reads
    delegated.ts          Delegated (OBO) Graph lane — the access plane
    registry.ts           Org registry: continuous tenant enumeration → D1

  intelligence/           Always-on behaviours
    digest.ts             Daily channel digest
    stale.ts              Stale-thread detection
    nudge.ts              At-risk task nudges (rate-limited)
    briefs.ts             Morning brief + evening wrap-up
    weekly.ts             Monday operational roll-up
    decisions.ts          Decision extraction
    meeting-intel.ts      Pre-meeting briefs + post-meeting wrap-ups
    heartbeat.ts          Daily heartbeat scan (SOUL.md §Heartbeat)
    curiosity.ts          Curiosity budget: open research questions (P4)
    client-status.ts      Client-scoped cross-asset status synthesis
    org-pulse.ts          Tenant-wide "what is happening now" synthesis

  actions/                Autonomy: the ladder-gated action spine (P5)
    framework.ts          Audited, ladder-gated execution spine
    policy.ts             Action-policy store (admin control plane)
    confirm.ts            Delegated confirmation of a gated action
    verbs/                One module per action verb + registry
      index.ts, _util.ts
      create-task.ts, assign-task.ts, complete-task.ts
      draft-message.ts, send-message.ts, send-mail.ts, schedule-meeting.ts

  learning/               Self-improvement (P4)
    proposals.ts          Improvement-proposal store (operator review queue)

  tasks/                  Task + ownership tracking
    types.ts              Task domain types
    store.ts              D1 store (append-only ownership history)
    detect.ts             Natural-language task detection
    planner-sync.ts       Bi-directional Planner sync

  acl/                    Access control (strict by default)
    types.ts              Shared ACL types
    resource-acl.ts       Per-resource principal grants
    group-membership.ts   AAD group membership cache + refresh
    sensitivity.ts        Sensitivity-label policy

  clients/                Client scope (external partner asset bundles)
    types.ts, index.ts
    store.ts              Clients store on D1
    assets.ts             client_assets join-table CRUD
    membership.ts         Membership resolver (via resource_acl)
    scope.ts              Client scope resolver
    active.ts             Per-user active Client

  routines/               User- + Arcadia-authored workflows
    definition.ts         Zod schemas for routine specs
    store.ts              Routines store on D1
    executor.ts           Step runner over tools + memory + AI router
    cron.ts               Cron-trigger dispatch
    events.ts             Graph-event-trigger dispatch
    authored.ts           Arcadia-authored routines (skill acquisition, P5)

  ingest/                 Continuous content ingestion
    types.ts
    queue-consumer.ts     Cloudflare Queue consumer
    chunker.ts            Semantic chunking
    embeddings.ts         Embedding pipeline
    producers/            Per-resource delta walkers + cron entry:
      index.ts, deps.ts, mail.ts, calendar.ts, meetings.ts,
      drive.ts, sharepoint.ts, messages.ts
    parsers/              html.ts / plain.ts / onenote.ts / pdf.ts

  charter/                Operator-authored ground truth
    types.ts
    store.ts
    inject.ts             Charter injection into system prompts

  mcp/                    Arcadia-as-MCP-server
    server.ts             JSON-RPC handler over HTTP
    tools.ts              MCP tool registry

  cards/                  Adaptive Cards (Universal Actions only)
    types.ts              Shared types + verbs
    digest.ts             Daily-digest card
    task.ts               Task assignment + sequential workflow
    nudge.ts              At-risk nudge card
    action-confirm.ts     Action-confirmation card

  webapp/                 HTTP API for the SvelteKit frontend
    routes.ts             Route table
    auth.ts               Session cookie + OBO token exchange
    chat-stream.ts        Chat (streaming + non-streaming)
    dashboard-api.ts      Home-screen rollup
    routines-api.ts       Routines CRUD + manual run
    memory-api.ts         Memory read + correct
    sources-api.ts        Ingest observability + document browser
    search-api.ts         Microsoft Search (delegated)
    clients-api.ts        User-facing Client routes
    admin-clients-api.ts  Admin-only Client write paths
    charter-api.ts        Operator-only charter CRUD
    proposals-api.ts      Operator review queue (P4)
    actions-api.ts        Autonomy admin control plane (P5)
    org-pulse-api.ts      Admin tenant-wide org pulse

  openapi/                Spec publishing + Copilot Connector
    spec.ts               OpenAPI 3.1 spec for the public API
    connector.ts          Copilot Connector item adapter
    connector-sync.ts     Copilot Connector transport (sync)

  agent365/               Agent 365 manifest + identity
    manifest.ts

  eval/                   Eval harness
    types.ts
    runner.ts
    judge.ts              LLM judge
    gate.ts               PR / nightly regression gate
    propose.ts            Eval → proposal bridge (P4)

  lib/                    Shared utilities
    logger.ts             Structured JSON logger
    config.ts             Runtime-tunables parser
    entra-verify.ts       Entra ID access-token verification
```

---

## 6. Data model

A single forward-only migration chain under `schema/`:

- `schema/0001_init.sql` — full v2 baseline
- `schema/0002_*.sql` … going forward

Tables (consolidated; see `schema/0001_init.sql` plus numbered migrations):

| Table | Purpose |
| --- | --- |
| `channels` | Registered Teams channels (team / channel / service URL) |
| `chats` | Registered group + 1:1 chats |
| `threads` | Thread activity, staleness, ownership |
| `users` | AAD user profiles (light, refreshed via Graph), incl. `active_client_id` |
| `clients` | Client object — external partner served by a bundle of assets |
| `client_assets` | Assets attached to a Client (Teams team/channel/chat, Planner plan, SharePoint site, Loop workspace, Enque team) |
| `memories` | Unified memory store, `kind` ∈ {episodic, semantic, procedural, observation} |
| `memory_edges` | Graph relations between memories |
| `tasks` | Tasks with deadline, priority, owner, Planner sync state |
| `ownership_history` | Append-only ownership log |
| `decisions` | Extracted decisions with provenance |
| `digests` | Posted digest audit log |
| `briefs` | Morning / evening / weekly briefs |
| `routines` | Routine definitions |
| `routine_runs` | Execution log |
| `resource_acl` | Per-resource principal grants (incl. `resource_type='client'`) |
| `group_membership` | AAD group membership cache |
| `graph_subscriptions` | Active change notifications |
| `delta_state` | Per-resource delta tokens |
| `documents` | Ingested document metadata |
| `document_chunks` | Chunked text + embedding refs |
| `charter` | Operator-authored ground truth |
| `eval_cases` | Eval inputs |
| `eval_runs` | Eval results |
| `feedback` | User feedback signal |

### Clients

A `Client` is a first-class scope alongside channel / chat / user. It
bundles every M365 + Enque asset used to serve one external partner
(e.g. Morgan Stanley, Wells Fargo). Membership is governed by the
existing `resource_acl` machinery — a `resource_type='client'` row per
principal, typically `principal_type='group'` pointing at the M365
group that backs the Teams team, so Teams membership is the source of
truth.

Each user has one optional `active_client_id`. When set:

- `/api/webapp/chat` recall federates across the Client's
  channels + chats and the Client scope itself.
- `/api/webapp/dashboard` aggregates tasks + digests within the
  Client's asset bundle.
- `/api/webapp/clients/:id/status` returns a Copilot-style cross-asset
  status via `src/intelligence/client-status.ts`.

Admins (`users.is_admin = 1` or `ADMIN_USER_AAD_ID`) create Clients,
attach assets, and grant ACL. Users switch their own active Client
freely among the ones they're entitled to.

Vectorize index: `arcadia-memory-vectors` (768-dim, cosine).

Queue: `arcadia-ingest`.

KV: `ARCADIA_CACHE` (token cache, rate limits, ephemeral session state).

---

## 7. Cards and UX

All Adaptive Cards in v2 use:
- **`Action.Execute`** (Universal Actions) — no `Action.Submit` anywhere.
- **`refresh`** — automatic per-user refresh; each viewer sees content filtered by their ACL.
- **Sequential workflows** for multi-step flows (e.g. assign task → confirm owner → set deadline → render success — all in a single card).
- **Adaptive-Card Loop components** for digests so they remain live + portable across Teams + Outlook.

---

## 8. Phase A quick wins (in scope for v2 from day one)

1. **OpenAPI spec publishing** — `src/openapi/spec.ts` emits OpenAPI 3.1 for the public API. Becomes the source of truth for downstream tools (Power Automate connector, Copilot Connector, the MCP tool list).
2. **Universal Actions** — all v2 cards use `Action.Execute` + `refresh`.
3. **Copilot Connector** — `src/openapi/connector.ts` publishes Arcadia's `digests`, `tasks`, `ownership_history`, customer profile entries into Microsoft Search, ACL-aware.
4. **Microsoft Graph Toolkit** — `web/` uses `@microsoft/mgt-svelte` (or the web-component path) for person / agenda / file-list / search-box / teams-channel-picker primitives.
5. **Agent 365 manifest** — `src/agent365/manifest.ts` publishes Arcadia's identity, capabilities, and dependencies to Agent 365 for tenant-wide governance.

---

## 9. Explicitly out of scope (do not build in v2 without a new decision)

- Microsoft 365 Copilot declarative agent / API plugin (deferred).
- Outlook taskpane / message extension (deferred).
- Foundry hosting (deferred — Workers stay the runtime).
- Replacing Arcadia's memory model with the SDK's built-in storage (we wrap, not replace).
- Routing answers through generic Copilot rather than Arcadia's voice.
- Power Automate custom connector (will fall out of the OpenAPI spec — not separately built).

---

## 10. Build order (commit sequence)

1. **Foundation** — this commit: ARCHITECTURE.md ✦
2. **Tear-down + new package + wrangler + schema** — strip v1, install Agents SDK, consolidated schema.
3. **Runtime** — `src/runtime/*` + `src/index.ts` wiring with Agents SDK on Workers.
4. **Memory + AI** — `src/memory/*`, `src/ai/*`.
5. **Graph** — `src/graph/*` including Search, Presence, Meetings, Activity Feed.
6. **Intelligence + cards** — `src/intelligence/*`, `src/cards/*` (Universal Actions).
7. **ACL + tasks + routines + charter** — `src/acl/*`, `src/tasks/*`, `src/routines/*`, `src/charter/*`.
8. **MCP server** — `src/mcp/*`.
9. **Webapp HTTP API** — `src/webapp/*`.
10. **Web frontend** — `web/` SvelteKit + MGT + Teams Tab manifest.
11. **OpenAPI + Copilot Connector + Agent 365** — Phase A quick wins.
12. **Ingest + Eval** — `src/ingest/*`, `src/eval/*`.

---

## 11. References

- `SOUL.md` — Arcadia's character. Canonical. Do not edit without operator direction.
- `claude.md` — Operational instructions for AI agents working on this codebase.
- `evals/` — Eval cases + judge prompt.
- Microsoft 365 Agents SDK: <https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/agents-sdk-overview>
- Microsoft Teams SDK: <https://github.com/microsoft/teams-sdk>
- Microsoft 365 Agents Toolkit: <https://github.com/OfficeDev/microsoft-365-agents-toolkit>
- Microsoft Graph: <https://learn.microsoft.com/en-us/graph/>
- Microsoft Graph Toolkit: <https://github.com/microsoftgraph/microsoft-graph-toolkit>
- Universal Actions for Adaptive Cards: <https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview>
- Microsoft Agent 365: <https://www.microsoft.com/en-us/microsoft-agent-365>
