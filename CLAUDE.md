# Arcadia — Build Instructions

**Project:** Arcadia — S-FX Operations Intelligence Layer
**Owner:** Shane Skwarek, Founder & Chief Technologist, S-FX.com Small Business Solutions, LLC
**Repo root:** place this file at `/CLAUDE.md`
**Version:** v5 (supersedes v4; folds in the August 25 client-workspace scope document)
**Date:** August 25, 2026

---

## 1. What you are building

Arcadia is an internal operations agent for S-FX, a 27-person outsourced technology department. She runs entirely on Cloudflare. Her unit of scope is the **client workspace**: an admin binds each client's Teams, standard channels, Planner plans, SharePoint folders, and Enque organization (S-FX's ticketing system) to one workspace, and inside that closed loop Arcadia indexes, watches, answers, and reports.

**v5 launches her as a shared resource — a project manager and project reference every team uses without friction.** Adoption is the current goal. The near-term deliverables, in priority order:

1. **Recurring-issue detection.** Cluster similar tickets across time so a fix gets implemented once, in perpetuity, instead of five times reactively.
2. **Task vigilance.** Surface tasks with little or no activity, missed tasks, duplicates, and threads that went quiet — correlated between Planner and channel discussion.
3. **Weekly EOS-style reports.** Progress, blockers, accomplishments — one internal edition, one client-facing edition, generated on schedule.
4. **Client-scoped Ask.** Members of a workspace ask questions inside that client's context and get cited answers, and can upload documents and write formatted text directly in the chat surface.

### Where she came from — do not lose this

The founder took two weeks away. A dozen projects fell behind and critical mistakes shipped, despite three competent leads and a defined hierarchy. v4 answered with accountability instruments: the Stall Radar escalation ladder, the Certification Ledger, Dispatch stage enforcement. They are built, tested — and **dormant** (§4.3). v5 deliberately trades enforcement for adoption: a tool the team reaches for daily can carry enforcement later; a tool that polices from day one gets routed around and enforces nothing. The four original failures — stalls unnoticed, deliverables unchecked, staff idle, leads not deciding — remain real and remain the long-term mandate. Decided by Shane, August 25, 2026 (`docs/decisions/2026-08-25-pm-first.md`).

### The governing rules

v4's single rule ("Arcadia surfaces and attributes; humans decide and sign") splits into a permanent rule and a posture.

> **Permanent — humans decide and sign.** Nothing reaches a client without a named human approving it. Doctrine never auto-commits. Arcadia never overrules a human: she may flag, escalate, and log. That is all.

> **v5 posture — inform, don't indict.** Arcadia surfaces work-level facts: stale tasks, quiet projects, duplicate tickets, unanswered threads, blockers. She does not compute, store, or reveal person-level judgments. Dormant means dormant: while this posture holds there are no false-certification counters, no pass-through flags, no day-3/5/7 escalation filings — not hidden, **not accumulating**. Facts already visible in the source systems may appear in reports (a task and its assignee); derived scores about a person may not. When accountability returns, each instrument launches announced, with counters starting at zero — never as a retroactive reveal. Covert scoring that surfaces later does more damage than the metric is worth (§5.7); that principle now governs the whole platform, not just person memory.

When an implementation choice arises between "quietly helpful" and "visibly informative," choose visible: reports state plainly what is stale, missed, or duplicated. What they do not do, in this posture, is grade people.

---

## 2. Stack — non-negotiable

Everything runs on Cloudflare. Nothing runs on a local machine. No step in any production path may depend on someone's laptop being awake. Cloudflare OS is the front-door and the security vocabulary (§12), **not** the engine — the engine is this stack.

| Layer | Choice | Notes |
|---|---|---|
| Agent framework | **`agents` SDK** (`npm install agents`) | Cloudflare's Agent SDK. Pre-1.0, pin the version. Not accepting external PRs — do not plan on upstreaming fixes |
| Compute | Workers | |
| Agent state + memory | Durable Objects, SQLite-backed | One DO per memory profile |
| Vector search | Vectorize | One index per profile |
| Operational data | D1 | Clients, bindings, projects, tickets, audit log |
| Object storage | R2 | Artifacts, uploads, crawl snapshots, memory exports |
| Async | Queues | Ingestion, vectorization, retries |
| Embeddings | Workers AI `@cf/baai/bge-base-en-v1.5` | |
| Reasoning | Anthropic API **via AI Gateway** | Never call Anthropic directly. See §6 |
| Auth (staff-facing) | **Microsoft SSO — Entra ID OIDC, in-Worker** | `src/lib/sso.ts`. Authorization-code flow with PKCE, signed session cookie. Cloudflare Access is **not** used |
| Scheduling | `agents` SDK scheduling | Not raw cron triggers where the SDK covers it |
| Durable multi-step | `agents` SDK Workflows | Native human-in-the-loop approval — use it, don't hand-roll |

### Reference material — set this up before writing code

**Do not vendor `cloudflare/cloudflare-docs` into this repo.** It is the full source of developers.cloudflare.com — too large, and stale the moment it's pulled. Use live sources instead:

1. **Cloudflare MCP server** — semantic search over current documentation:
   ```
   claude mcp add cloudflare --transport http https://mcp.cloudflare.com/mcp
   ```
   OAuth on first connect, credentials reused after.

2. **Cloudflare Skills plugin** (`github.com/cloudflare/skills`) — bundles the Cloudflare MCP servers with contextual skills and slash commands for building on Cloudflare. Preferred over the bare MCP server if available. Follow that repo's README for install.

3. **Documentation index:** `https://developers.cloudflare.com/agents/llms.txt` — fetch this to discover available pages before exploring further.

4. **Clone `github.com/cloudflare/agents` into `/reference` (gitignored).** Worth having locally, unlike the docs repo. Read before implementing:
   - `guides/human-in-the-loop` — the approval-gate pattern used in doctrine ratification, site plans, and the external EOS report
   - `guides/anthropic-patterns` — sequential, routing, parallel, orchestrator, evaluator
   - `examples/workflows`, `examples/agents-as-tools`, `examples/mcp-client`
   - `design/` — architecture decision records for sub-agents, workspace, retries

**Do not use** `cloudflare/computer`. It is preview-only, explicitly not production-suitable, and Arcadia needs no virtual filesystem.

**Do not recall API surfaces from memory.** The `agents` SDK is pre-1.0 and moving fast. Verify every binding, method signature, and config key against the MCP server or the cloned repo before using it.

---

## 3. Repository structure

Abridged — directories and load-bearing files, not every file. Entries marked *(v5)* do not exist yet.

```
arcadia/
├── CLAUDE.md
├── wrangler.jsonc
├── package.json
├── doctrine/                     # curated doctrine markdown, bundled with the Worker
├── docs/decisions/               # decision records (v5)
├── scripts/
│   └── setup.sh                  # creates D1, Vectorize, R2, KV, queues
├── reference/                    # gitignored — clone of cloudflare/agents
├── src/
│   ├── index.ts                  # Worker entry; exports ArcadiaOsGatekeeper
│   ├── agents/                   # root Agent + Radar, Ledger, Dispatcher DOs
│   ├── memory/
│   │   ├── driver.ts             # MemoryDriver interface — §5.1
│   │   ├── self-hosted.ts        # DO + Vectorize + FTS5 + RRF
│   │   ├── curated.ts, seed.ts   # doctrine import paths (§5.5 C)
│   │   └── agent-memory.ts       # stub; implement when CF Agent Memory hits GA
│   ├── workflows/                # ratify, siteplan, seed; EOS reports land here (v5)
│   ├── clients/                  # (v5.0) bindings, membership cache
│   ├── integrations/
│   │   ├── anthropic.ts          # AI Gateway-wrapped client
│   │   ├── graph.ts              # raw Graph client — gatekeeper-only import
│   │   └── enque.ts              # (v5.1) raw Enque client — gatekeeper-only import
│   ├── gatekeepers/              # types, log, graph, site-crawl, project-context
│   │   └── enque.ts              # (v5.1)
│   ├── patterns/                 # (v5.2) recurring-issue clustering
│   ├── reports/                  # (v5.3) eos-internal, eos-external
│   ├── radar/                    # signals.ts — five ground-truth stall signals
│   ├── certification/            # checklists, verify — dormant surfaces (§4.3)
│   ├── dispatch/                 # stages.ts — dormant enforcement (§4.3)
│   ├── site/                     # plan.ts — site planning
│   ├── ai/                       # router.ts, types.ts — per-task model routing
│   ├── approval/                 # SSO-protected dashboard (shell, nav, sections)
│   ├── os-bridge/                # ArcadiaOsGatekeeper WorkerEntrypoint (§12.2)
│   ├── lib/                      # sso, rbac, org, ask, brand
│   └── schema/
│       ├── d1.sql
│       └── types.ts
```

---

## 4. Build state and build order

### 4.1 Built through v4 — keep working, do not reopen

| Component | Path | v5 status |
|---|---|---|
| Entra OIDC sign-in | `src/lib/sso.ts` | Live. v5 adds an authorization axis (§8), not an authentication one |
| Memory engine | `src/memory/` | Live. New profile family (§5.2), same engine |
| Doctrine pipeline | `curated.ts`, `seed.ts`, `workflows/ratify.ts` | Live and load-bearing — staging → human tap → canonical is unchanged |
| Gatekeeper layer | `src/gatekeepers/` | Live. Scope *shape* changes in v5.0 (§8); contract does not |
| os-bridge | `src/os-bridge/` | Built, deliberately unbound until an OS deployment exists (§12) |
| Radar detection | `src/radar/signals.ts` | **Live as a PM signal source** — feeds task vigilance and reports |
| Radar escalation ladder | day 3/5/7, board, digests | **Dormant** (§4.3) |
| Certification Ledger | `src/certification/` | **Dormant** (§4.3) |
| Dispatch stage enforcement | `src/dispatch/stages.ts` | **Dormant** (§4.3) |
| Site planning | `src/site/plan.ts` | Live. Unchanged |
| Model routing | `src/ai/` | Live. v5 tasks join the registry (§6) |

Hermes (content publishing) was cut August 18, 2026 and removed from the codebase — do not rebuild any of it as a side effect of another phase. Its two survivors stand: the S-FX voice rules (§7, `src/lib/brand.ts`) and the approval-gate pattern, now exercised by ratification, site plans, and the external EOS report.

### 4.2 v5 build order

Cheapest data first; value before ingestion. The tempting order — ingest everything, then build features — is backwards: if the reports aren't useful on structured data, they will not become useful with chat added, and it's better to learn that in October than in February.

| Stage | Scope | Done when | Gate to clear first |
|---|---|---|---|
| **v5.0 — Spine** | `clients`, `client_bindings`, `client_members` schema; binding admin (typed, attributed, admin-bound); Graph-derived membership cache; client-scoped gatekeeper sessions (frozen-set rule, §8); Clients dashboard pages replace the placeholders; dormancy flags for §4.3 instruments. **No new data sources.** | An admin binds a real client's sources; a bound Team's members see that workspace and nobody else does | Graph application consent incl. `GroupMember.Read.All` (§9) |
| **v5.1 — Enque** | `integrations/enque.ts` + `gatekeepers/enque.ts` + `tickets`/`ticket_events` schema + incremental sync | Tickets for one bound client sync incrementally and appear in the workspace | Enque API confirmed: `updated_since` filter + stable org id (§10.1) |
| **v5.2 — Signal** | Pattern detection (`src/patterns/`): embed ticket titles + resolutions, cluster, flag clusters crossing a frequency threshold — the model only names and summarizes clusters. Stall correlation: four deterministic rules over Planner + channel **metadata** (past-due with no discussion; no assignee; near-duplicate titles; thread names a task then stops) | At least one real recurring-issue cluster or a documented null result; stale/duplicate flags on a live board | v5.1 for patterns; Graph consent for correlation |
| **v5.3 — Reports** | Two EOS workflows, **not one workflow with two prompts**: internal (Planner, Enque, bound channels) and external (Planner, Enque, one designated client-visible channel — nothing else). The external agent must be *structurally incapable* of reading internal commentary — prompt discipline is not a control. External edition ships only through the approval gate | Both editions generate weekly for one client; external requires a named human tap | v5.2 |
| **v5.4 — Files + uploads** | SharePoint content from bound folders (broken-inheritance items excluded at ingest, §8); member uploads into the workspace chat (R2 + indexed, uploader attributed); formatted text (markdown) in chat | An uploaded doc and a bound-folder doc both answer a workspace question with citations | Retention answered (§10.4) |
| **v5.5 — Messages** | Teams standard-channel message bodies into `sfx-client-{id}`. 60–70% of v5's total work; produces nothing until Ask and reports consume it | Workspace Q&A cites real threads | Microsoft protected-API approval + licensing verified (§10.2) |
| **v5.6 — Mining** | Ambient doctrine proposal (§5.5 B): when Shane answers in a workspace, the reply becomes a doctrine *candidate* in staging. Proposer, never writer | Candidates appear in staging with source citations; zero autonomous canonical writes | v5.5 |

Standing items, any time:
- **Teams-native Ask** — Azure Bot registration makes the workspace chat available inside Teams. The dashboard chat is the interim surface.
- **Cloudflare Agent Memory migration** — when it exits private beta: implement `AgentMemoryDriver` against §5.1, dual-write, compare recall, cut over.

Viva Updates is **not** a binding type — its API surface is weak and the signal is already carried by Planner and channels. Revisit only if Microsoft invests in it.

### 4.3 Dormant instruments — and how they come back

Dormant, not deleted. The code stays in the repo behind per-instrument config flags (`config` table, default off), because deleting tested modules to rebuild them later is waste. Dormant means the full definition in §1: no enforcement, no public naming, **and no silent accumulation** of the person-level data the instrument would score.

| Instrument | What sleeps |
|---|---|
| Escalation ladder | Day 3/5/7 DMs, pod posts, founder digests, the public accountability board |
| Certification Ledger | Signing requirements as stage gates, false-certification events and per-person rates |
| Dispatch enforcement | Stage SLAs, breach escalation, pass-through detection |

What does **not** sleep: Radar's detection signals, stall correlation, and every §8 safety control. Detection is a PM feature now — "this task is stale" appears on workspace surfaces and in reports as a fact about the work.

Re-enablement protocol, per instrument: (1) Shane decides adoption is proven (§10.3 names the trigger question); (2) it is announced to all staff before the flag flips — never discovered; (3) counters start at zero from the announcement date; (4) the accountability/reference split gets written into §1 of this file at that time — accountability instruments name humans publicly and do not soften; reference surfaces answer and summarize and never absorb accountability.

---

## 5. Memory

### 5.1 Driver interface — build against this from day one

Cloudflare Agent Memory is private beta and cannot carry a production dependency yet. Build our own behind an interface that mirrors its API surface so migration is a driver swap, not a rewrite.

```typescript
interface MemoryDriver {
  getProfile(name: string): Promise<Profile>;
}

interface Profile {
  ingest(messages: Message[], opts: { sessionId: string }): Promise<IngestResult>;
  remember(m: { content: string; sessionId?: string }): Promise<Memory>;
  recall(query: string, opts?: RecallOpts): Promise<RecallResult>;
  list(filter?: ListFilter): Promise<Memory[]>;
  forget(id: string): Promise<void>;
}
```

One advantage of the self-hosted path: synthesis runs on Claude, so the voice is right. Agent Memory's synthesizer runs on Workers AI models.

### 5.2 Profiles carry governance, not just isolation

| Profile | Contains | Write policy |
|---|---|---|
| `sfx-doctrine-canonical` | Shane's rules, positions, pricing philosophy, bid criteria, voice | **No autonomous writes, ever.** Promotion from staging, or a curated import the ratifying authority runs by hand (§5.5 C) |
| `sfx-doctrine-staging` | Candidates awaiting ratification | Auto-writes |
| `sfx-client-{id}` | The workspace corpus: tickets, task metadata, bound-channel messages (v5.5), bound-folder files (v5.4), member uploads | Auto-writes from bound sources only; reads membership-gated (§8); **never person-performance data** (§5.8) |
| `sfx-project-{id}` | Per-engagement facts, client constraints, decisions — nests inside its client | Auto-commits facts, flags conflicts |
| `sfx-person-{id}` | Per-staff patterns, certification reliability | Auto-observes, never auto-acts. Dormant instruments (§4.3) do not feed it while the posture holds |
| `sfx-episodic` | Append-only decision log | Auto, immutable |

**Doctrine Ask recalls only from `canonical`.** Staging is a queue, not a memory. Client-scoped Ask recalls from `sfx-client-{id}` plus canonical (§5.8).

**Layer discipline matters.** A client's contract price belongs in that client's profile. The principle behind it — rate locks yes, discounts no, deferred payment is a convenience not a savings offer — belongs in doctrine. Never promote a client-specific figure into doctrine, or Arcadia will quote one client's number at another. The same discipline runs the other way: nothing from a client corpus reaches doctrine automatically (mining proposes into staging only, §4.2 v5.6), and no person-performance judgment is ever written into a client corpus.

### 5.3 Ingestion pipeline

```
capture
  → content-addressed ID (SHA-256 of profile+role+content, 128-bit)  [idempotent]
  → extraction pass A: full chunk, ~10K chars, 2-message overlap     [fast tier]
  → extraction pass B: detail sweep for concrete values              [fast tier]
  → verification against source transcript                           [fast tier]
  → classify: fact | event | instruction | task + normalized topic key
  → dedupe: vector similarity within profile
  → conflict check on matching topic key:
      ├─ client/project/person → supersede, keep version chain
      └─ doctrine              → HALT. Surface both. Human chooses.
  → write (INSERT OR IGNORE)
  → background vectorize via Queue
```

**Pass B is mandatory.** S-FX material is dense with specific figures — dates, rates, term lengths, ticket numbers. Broad extraction reliably loses exactly those. The detail sweep uses overlapping windows prompted specifically for names, prices, dates, version numbers, entity attributes.

**Embedding trick:** prepend 3–5 generated search queries to memory content before embedding. Memories are written declaratively ("no discounts, rate locks only") but searched interrogatively ("can I discount this?"). Bridging that is most of the recall quality.

### 5.4 Retrieval

Three channels in parallel, fused by Reciprocal Rank Fusion:

| Channel | Weight |
|---|---|
| Exact topic-key lookup | Highest |
| Full-text (FTS5 in the DO, Porter stemming) | Medium |
| Vector (Vectorize cosine) | Medium |

Ties break by recency. Top candidates go to the synthesis model.

**Held in reserve:** HyDE — generate a hypothetical answer, embed *that*, search on it. Better on abstract and multi-hop queries, costs one extra small model call. Add only if recall quality disappoints. Do not build day one.

### 5.5 Capture channels

- **A — Direct deposit.** DM to Arcadia, typed or voice (Workers AI Whisper). Must take under 15 seconds or it won't get used.
- **B — Ambient extraction.** Watch designated channels, propose doctrine candidates from decisions made in normal work — concretely: when Shane answers in a client workspace, the reply is a doctrine candidate. Ships as v5.6. Proposer only, into staging, with source citations.
- **C — Bulk seed.** One-time import: this file, Kamino CLAUDE.md, Koerner communication directives, website redesign export, brand positioning docs, past proposals, pricing history, Blueprint posts. Targets ~60% doctrine coverage on day one.
  - **Curated import — added August 18, 2026.** A document the ratifying authority wrote himself, one numbered statement at a time, does not go through extraction: running it through pass A would paraphrase his sentences and drop the `[HARD]`/`[JUDGMENT]`/`[VERIFY]` markers that carry the enforcement level. `doctrine/*.md` is bundled with the Worker, parsed deterministically (`src/memory/curated.ts`), and written straight into canonical under the name of the human who ran it. It replaces the corpus rather than adding to it: canonical and staging are exported to R2, emptied, and rewritten. The control this preserves is the one that matters — Arcadia never writes canonical on her own, and every entry still carries a named ratifier.
- **D — Gap interrogation.** *Highest value.* When Arcadia can't answer confidently, she queues the question for Shane. His answer becomes permanent doctrine. Every gap closes once, forever. This is what makes her useful during absences rather than confidently wrong.

### 5.6 Controls — implement all of these

1. **Doctrine never auto-commits.** Staging → human tap → canonical. Most important control in the system. The curated import (§5.5 C) skips staging but not the human: it is capability-gated, typed-confirmation gated, audited, and attributed. Nothing Arcadia does on her own reaches canonical by either path.
2. **Contradiction halts.** Conflicting input surfaces both versions. No silent overwrite.
3. **Supersession, never deletion.** Version chain with forward pointer. One exception, and it is explicit: a curated import replaces a corpus rather than versioning each entry, so it exports both profiles to R2 before emptying them. "Wiped" means out of recall, not gone.
4. **Provenance on every entry** — captured when, from where, ratified by whom; for workspace entries, a pointer to the source message/file/ticket and its author.
5. **Decay review.** Unused >180 days surfaces for confirmation, not deletion.
6. **Full action audit.** Every output logs which memory entries informed it.
7. **Confidence floor.** For doctrine, the floor decides the mode (Cited vs Inferred). For a client corpus it decides whether she answers at all (§5.8) — a confidently-invented client fact is worse than an invented Shane opinion; it has a client's name on it.
8. **Export on demand.** Dump DO SQLite to R2 any time.
9. **No person-performance data in workspace corpora.** And Ask refuses to synthesize it from client data — enforced in the code path, not the prompt (§5.8).

### 5.7 Person memory

Sensitive layer. Read access: the person themselves, their lead, Shane. Nobody else. Build it assuming staff know it exists and can see their own numbers — covert scoring that surfaces later does more damage than the metric is worth.

### 5.8 Client workspace corpus — v5

What flows in, per stage: Enque tickets and ticket events (v5.1), Planner task metadata (v5.0 sessions), bound-folder file contents (v5.4), member uploads and chat (v5.4), standard-channel message bodies (v5.5). Every entry carries provenance: source pointer, author, timestamps; uploads carry the uploader. Exclusions happen **at ingest, never at retrieval** (§8): private channels, 1:1 and group chats, SharePoint items with broken permission inheritance.

Client-scoped Ask rules:

- Recall = `sfx-client-{id}` + `sfx-doctrine-canonical`. Citations point at the source message, file, or ticket. The Cited/Inferred distinction matters *more* here, not less: a workspace answer citing a real thread is high-value; the same answer inferred is a liability.
- **Below the confidence floor on a client question, she does not infer.** She says the workspace doesn't contain the answer and names where to look. (Doctrine Ask keeps its existing behavior: the floor decides Cited vs Inferred mode.)
- **Person-performance questions are refused in the Ask path, not the prompt.** "Who keeps missing deadlines on this account" is a §5.7 question wearing a client-workspace costume; membership in a workspace must not route around the person/lead/Shane access rule. The refusal is code, because a prompt is not a control.

---

## 6. Model routing

**Cloudflare Workers AI is the default provider.** Everything stays on Cloudflare: no third-party key required to run Arcadia, inference is billed in Neurons against the Workers plan, and Workers AI calls go through the AI Gateway binding option so per-call cost stays observable — which is how the monthly spend ceiling gets enforced rather than hoped for.

**Routing is per task, not per tier, and every task is admin-configurable.** Call sites name a `TaskKind` (`src/ai/types.ts`) and never a model; `ModelRouter` (`src/ai/router.ts`) resolves it from D1 (`model_config`, KV-cached) falling back to the built-in defaults. A superadmin can point any single task at a different Workers AI model or at Claude from the admin surface, and the change takes effect within a minute without a deploy.

| Tier | Default model | Tasks |
|---|---|---|
| fast | `@cf/meta/llama-3.1-8b-instruct-fast` | stall sweeps, classification, extraction, detail sweep, verification, search queries, spellcheck |
| balanced | `@cf/openai/gpt-oss-120b` | summaries, digests, synthesis, copy diff, EOS report synthesis, cluster naming |
| deep | `@cf/zai-org/glm-5.2` | doctrine conflicts, novel judgment, site IA, page specs |
| embeddings | `@cf/baai/bge-base-en-v1.5` | fixed — the Vectorize indexes are 768-dim |
| transcription | `@cf/openai/whisper-large-v3-turbo` | capture channel A voice deposits |

v5 tasks join the registry the same way: EOS synthesis and cluster naming default to balanced; client-ask synthesis follows the existing ask task; ticket clustering itself is embeddings plus deterministic code — no reasoning call reads every ticket.

Deep-tier models need a Workers Paid plan. Verify model IDs against the live catalog before changing them — never recall them from memory.

**Anthropic remains available per task, always via AI Gateway.** Never call `api.anthropic.com` directly. Route a task to Claude when the quality genuinely justifies the cost — doctrine conflicts and site IA are the honest candidates, because Workers AI's strongest reasoning model is still weaker than Opus on novel judgment. `ANTHROPIC_API_KEY` is optional; the admin surface refuses to route a task to Claude until it is set.

```typescript
const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`,
});
```

| Job | Claude model, when routed there |
|---|---|
| Stall sweeps, extraction, classification, verification | `claude-haiku-4-5` |
| Summaries, digests, synthesis | `claude-sonnet-4-6` |
| Doctrine conflicts, novel judgment, site IA | `claude-opus-4-7` via advisor tool |

Selecting the advisor model uses the advisor pattern rather than routing whole requests to Opus — Sonnet executes, Opus advises. (The advisor tool's pairing table rejects `claude-opus-4-6` as an advisor; 4-7 is the nearest accepted model at the same price.)

**No provider guarantees JSON.** Workers AI accepts `response_format.json_schema` on some models and ignores it on others, so every JSON-shaped call passes a schema as a hint *and* parses defensively through `parseJsonBlock`.

---

## 7. Voice

Arcadia writes in Shane's register. Rules, applied to every staff-facing output:

- Direct, short declarative sentences. No hedging, no softening qualifiers.
- Specific numbers, dates, and names instead of vague adjectives. If the real figure isn't available, say so — never invent one.
- Sixth-grade clarity. No jargon unless the recipient works in that register and the term is load-bearing.
- Vary sentence length. Strongest line lands at the end.
- Close with a specific next action, never an open question.
- Never explain someone's own work back to them.
- S-FX is an **outsourced technology department**. Never "MSP," "agency," "IT company," "vendor," or "fractional technology department." Staff are **S-FX Specialists**.

The external EOS report is a client-facing document: every rule above applies to it, and it ships only after a named human approves it (§8).

---

## 8. Governance

**Roles and capabilities.** Microsoft SSO authenticates (`src/lib/sso.ts`); `src/lib/rbac.ts` authorizes. Every mutating route checks a capability server-side — the dashboard only hides what the caller cannot do anyway.

The sign-in path is the Worker's own OIDC authorization-code flow against Entra: `state` for CSRF, `nonce` for replay, PKCE S256 on the code, and the `tid` claim pinned to the S-FX directory so a guest or another tenant cannot enter. Identity leaves the flow as an HMAC-signed, HttpOnly session cookie valid for eight hours; `SSO_SESSION_SECRET` signs it, and rotating that secret logs everyone out. `DEV_MODE=true` bypasses sign-in but only on a loopback host, so the flag reaching deployed vars still cannot open the real Worker.

| Role | Holds |
|---|---|
| `superadmin` | Everything, including model routing and user administration. **shane@s-fx.com and alex@s-fx.com only.** |
| `founder` | Approvals, ratification, client bindings, projects — but not tenancy administration |
| `lead` | Approvals, projects; `manage_clients` grantable |
| `specialist` | The board, Ask Arcadia within their memberships |

An authenticated email with no `users` row gets the specialist baseline. The last active superadmin cannot be deactivated. Person-level records follow §5.7: the person, their lead, and Shane — enforced in queries, not markup.

### Access is capability × membership — both must pass

Role decides *what a person may do*; membership decides *whose data they may do it to*.

```
may_read(person, client) =
      can(person, "ask_arcadia")                    -- capability, rbac.ts
  AND client_members contains (person, client)      -- membership, Graph-derived
```

`client_members` is derived from Graph membership of the Teams bound to that client, cached in D1 with a **15-minute staleness ceiling** — someone removed from a Team loses workspace access within that window, and deactivated staff are refused at session mint regardless. If 15-minute polling proves too costly, move to membership change notifications; do not lengthen the window silently.

### Binding policy — the §6.5 answer

A client **is** whatever an admin binds to it. Bindings are typed (`team | channel | planner_plan | sharepoint_folder | enque_org | repo | staging_url`), attributed to the person who added them, and admin-bound only — no auto-detection. `manage_clients` holds the power: binding is the access-granting act, since a binding decides whose Teams membership unlocks the workspace. Superadmin and founder by default; grantable to leads.

Bind conservatively:

- **Standard channels only.** No private channels, no 1:1 or group chats — neither has a usable group ACL, so binding them over-grants silently. Revisit after the membership cache has run clean for a month.
- **SharePoint binds at the folder level** and folder membership is the ACL. Items with broken permission inheritance are **excluded at ingest, never filtered at retrieval** — filtering at retrieval is where leaks come from.

### Gatekeeper session rule — frozen at mint

Client-scoped sessions resolve bindings from D1 **at mint**, freeze them into the session object, and never re-read them. No method takes an id — same rule as today's project sessions, iterating a frozen set instead of reading a frozen field. A binding added mid-session does not appear in that session. **Write this rule into `src/gatekeepers/types.ts` as a comment before writing the code** — it is the single place where the security model can quietly degrade.

### Observations — two classes

Metadata observations stay exactly as they are (timestamps, names, states — no bodies). **Content observations** (v5.4+) log a SHA-256 hash and a source pointer to `gk_observations`, never the body; the body lives only in the membership-governed client profile. `view_audit` therefore never becomes read-access to every message Arcadia has seen.

**Graph permissions — minimum, application-scoped:**
`Files.Read.All`, `Sites.Read.All`, `Tasks.ReadWrite.All`, `ChannelMessage.Read.All`, `Chat.Read.All`, `User.Read.All`, `GroupMember.Read.All`, `Presence.Read.All`, `Calendars.Read`

**Arcadia may never do autonomously:**
- Send anything to a client
- Publish anything to a live site
- Modify or delete a file
- Write to `sfx-doctrine-canonical`
- Any compensation or HR action
- Compute, store, or reveal person-level performance judgments while the v5 posture holds (§1)
- Overrule a human — she may flag, escalate, and log. That is all.

**Audit:** every action, memory entry used, and approval, append-only in D1, queryable from the dashboard.

---

## 9. Human-only steps — do not attempt to automate

Flag these to Shane and stop.

**Before first deploy (unchanged from v4):**
1. Create an Anthropic API key (console) — optional, only for tasks an admin routes to Claude
2. Create an AI Gateway in the Cloudflare dashboard, note the gateway ID
3. Create a Cloudflare API token for `wrangler`
4. **Entra ID app registration for staff sign-in.** Platform **Web** (not SPA — the Worker is a confidential client and redeems the code with a secret), redirect URI `https://arcadia.s-fx.com/auth/callback`, plus `http://localhost:8787/auth/callback` for `wrangler dev`. Delegated `openid`, `profile`, `email` — default-consentable, so no Global Admin. Restrict assignment to S-FX staff. **This is the same registration Graph uses** (step 5 adds application permissions to it), so its credentials carry the `GRAPH_` names — there is no separate `SSO_CLIENT_ID`. Then:
   - `GRAPH_TENANT_ID` + `GRAPH_CLIENT_ID` → vars in `wrangler.jsonc` (public identifiers, not secrets)
   - `wrangler secret put GRAPH_CLIENT_SECRET`
   - `wrangler secret put SSO_SESSION_SECRET` (`openssl rand -base64 32`)

**Before v5.0 goes live:**
5. Application-scoped Graph permissions (§8 list, now including `GroupMember.Read.All`) on the step-4 registration + Global Admin consent. The credentials are already in place — only the consent grant is new.

**Before v5.1:**
6. Enque API credential, base URL, and written confirmation of the API surface: list tickets by org, fetch comments/updates, `updated_since` filter, stable org identifier (§10.1).

**Before v5.5:**
7. Verify Microsoft's current protected-API approval and licensing terms for application-scoped channel-message reads, directly against current documentation (§10.2).

**For Teams-native Ask (any time after v5.0):**
8. Azure Bot registration + Teams consent.

Everything else is `./scripts/setup.sh` then `wrangler deploy`, repeatable from a clean clone.

---

## 10. Open questions

**Resolved (August 5, 2026):** Planner is the system of record for task state, progress lives in Teams threads; escalation channel is board + email until Teams bot (now dormant with the ladder, §4.3); default reasoning provider is Workers AI, per-task configurable (§6).

**Resolved (August 25, 2026):** unit of scope is the client workspace; the v5 posture is inform-don't-indict with accountability instruments dormant (§1, §4.3); a client is whatever an admin binds — typed, attributed, no auto-detection (§8); content observations store hash + pointer, bodies live only in the membership-governed profile (§8).

**Still open:**

1. **Enque's API surface.** List by org, comments/updates, `updated_since`, stable org id. Cheapest question on this list and it gates the cheapest build (v5.1). If `updated_since` doesn't exist, everything downstream gets more expensive — say so early rather than designing around a full re-pull.
2. **Protected-API approval + licensing for channel-message reads.** Was open question #5 in v4, deferred because Radar polls velocity. Full-corpus ingest cannot be a poll, so it now gates v5.5. Microsoft's terms have changed more than once — verify directly, don't trust notes.
3. **What proves adoption?** The trigger for re-enabling each dormant instrument (§4.3) needs a number — weekly active staff? reports consumed without prompting? — and a decision date. Owner: Shane. Left implicit, "later" means never.
4. **Retention for workspace content.** Message bodies and file text in `sfx-client-{id}` are a second copy of client communication. How long does it live, and what does client offboarding look like? (Likely answer: export to R2 + wipe, mirroring the curated-import mechanics — but write it down.)
5. **Monthly spend ceiling** — still needs a number in AI Gateway.
6. **Who maintains Arcadia?** Bigger question than in v4 — v5 is materially more surface. If the answer is still "Shane," this file describes a system that stalls the next time he steps away, which is the exact failure it was built to catch.
7. **Is Foundry (dev team) work in Git?** The git signal is implemented and needs only a `GITHUB_TOKEN` plus per-client repo bindings.

---

## 11. Known limitations — state these honestly, don't design around them

- **The original failure mode is unsolved while the posture holds.** v5 detects and reports stalls; nobody gets named. The bet is that visibility alone improves behavior — it is a bet, and it is unproven. If Friday reports get ignored the way the founder's absence did, the answer is §4.3 re-enablement, not softer reports.
- **Retrofitting accountability is the hard direction.** A team that learns Arcadia as the helpful assistant may read later enforcement as a bait-and-switch. Mitigations are built into §4.3 — announced launch, zero counters — and into the roadmap being stated openly from day one: reporting and accountability features are coming, staff should hear that at v5 launch, not discover it.
- **Membership-derived access is the highest-risk surface in v5.** Every other failure mode is embarrassing; this one is a disclosure of one client's data to the wrong audience. Bind conservatively, exclude at ingest, accept the signal loss.
- **Pattern detection may find nothing.** 100+ organizations sounds like enough volume for recurring-issue clustering; it may be 100 organizations with 100 different problems. v5.2 is the cheap test of the premise the short-term goals rest on — treat it as an experiment with a result, not a feature with a ship date.
- **Ambient doctrine mining is the least reliable idea in v5.** A fast reply in a channel at 11pm is not canon. Without the ratification gate it produces confident wrong rules in Shane's voice. The gate exists; keep it.
- **Self-hosted memory is noisier than a managed service.** Four verification checks instead of Cloudflare's eight, no HyDE at launch. The ratification gate absorbs it for doctrine; citations absorb it for workspaces.
- **Arcadia cannot replicate judgment that was never articulated.** She applies stated rules to new situations. Capture channel D narrows this; it never closes it.

---

## 12. Cloudflare OS integration

Cloudflare OS (`github.com/cloudflare/cloudflare-os`, open-sourced August 2026) is Cloudflare's AI productivity environment: workspaces, sandboxed Gadgets, and the **Gatekeeper** capability-security model. Arcadia is not being rewritten onto it — she is the ops-intelligence backend; the OS is the front-door and the security vocabulary, never the engine (§2). It is also weeks old: when the front-door lands, consume `cloudflare-os-starter` and never patch core — breaking changes are coming. Two legs, both built:

### 12.1 In-process gatekeeper layer — `src/gatekeepers/`

The OS Gatekeeper model (capability sessions, observation logging, action approval queues) is adopted as Arcadia's own enforcement layer. The contract types are mirrored by hand in `src/gatekeepers/types.ts` from `packages/workshop-shared/src/gatekeeper.ts` in the OS repo — that package is workspace-only, not on npm; diff against a clone in `/reference` when it moves.

Rules, enforced by construction:

- **Sessions are scoped at mint and cannot be re-pointed.** Site crawl → one site's origin, read-only (`gatekeepers/site-crawl.ts`); Graph → one project's — v5.0: one client's frozen binding set (§8) — plan/folder/channel (`gatekeepers/graph.ts`); memory → one `sfx-client-{id}`, `sfx-project-{id}`, or `sfx-person-{id}` profile (§5.7 and §8 membership checked at mint). No session minted anywhere can address `sfx-doctrine-canonical` — ratification stays the only write path.
- **Every read is an observation**, logged append-only to `gk_observations` before data returns — metadata class or content class per §8.
- **Every side effect is an action** in `gk_actions`, applied only with authorization the gatekeeper verifies itself: a Planner write needs a dispatch rule naming a human, or a matching approved `approvals` row. Project-fact writes are `autoApprovable` — never client-visible. The site-crawl session has no action at all; it only reads. A `pending`/`failed` action row is the guardrail firing.
- **Credentials never leave the gatekeeper.** `src/integrations/graph.ts` and `src/integrations/enque.ts` are raw clients importable only by their gatekeepers. Workflows and agents receive capabilities.
- The dashboard's **Gatekeepers** section (view_audit) shows observations, actions, and blocked actions.

### 12.2 os-bridge — `src/os-bridge/`

`ArcadiaOsGatekeeper` is a named WorkerEntrypoint (exported from `src/index.ts`, unreachable over HTTP) that a Cloudflare OS deployment binds as a service, the same way the OS binds its own `gatekeeper-*` workers. It serves:

- **Doctrine + brand as shared context** — agent catalog / search / read over `sfx-doctrine-canonical` plus the brand-voice document. Read-only, like the OS Context Library.
- **Ask Arcadia** — the same agent code path as the dashboard. `ask_arcadia` capability checked per actor.

Adapter contract: every session method returns `{ data, observation }`; the OS-side gatekeeper package must `authorizeObservation(observation)` against its ApprovalQueue before handing `data` to a gadget. Deactivated staff are refused at session mint. Any client-corpus method added to the bridge authorizes by **membership**, not RBAC alone — the adapter has to know which check applies to which observation class.

### 12.3 What deploying the OS looks like (when S-FX is ready)

1. Deploy `github.com/cloudflare/cloudflare-os-starter` into the S-FX account, behind the same Entra ID directory Arcadia signs staff in against.
2. Add a thin `gatekeeper-arcadia` package there that service-binds this Worker's `ArcadiaOsGatekeeper` entrypoint and adapts it to the kernel's `Gatekeeper` interface (the observation envelope makes this mechanical).
3. Gadgets (client status board, site-diagnosis viewer, report viewer) come after — they consume the same sessions.

Non-negotiables carry over unchanged: doctrine never auto-commits, nothing reaches a client without a named human, RBAC × membership and Microsoft SSO stay authoritative, and every action stays append-only audited.
