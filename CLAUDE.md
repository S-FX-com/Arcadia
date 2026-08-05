# Arcadia — Build Instructions

**Project:** Arcadia — S-FX Operations Intelligence Layer
**Owner:** Shane Skwarek, Founder & Chief Technologist, S-FX.com Small Business Solutions, LLC
**Repo root:** place this file at `/CLAUDE.md`
**Version:** v4 (supersedes scope docs v2 and v3)
**Date:** August 5, 2026

---

## 1. What you are building

Arcadia is an internal operations agent for S-FX, a 27-person fractional technology department. She runs entirely on Cloudflare. She reads the Microsoft 365 tenant, watches project activity, enforces quality gates, holds institutional memory, and publishes content.

**She is not a chatbot with a nice personality. She is an accountability instrument.**

### The problem she exists to solve

The founder took two weeks away. A dozen projects fell behind and multiple critical mistakes shipped, despite three competent leads and a defined hierarchy. Four specific failures:

1. Projects stall for weeks with nobody noticing
2. Deliverables ship without proofreading or testing
3. Staff sit idle when not given explicit instruction
4. Leads don't make judgment calls they're authorized to make

### The governing design rule — do not violate this

> **Arcadia surfaces and attributes. Humans decide and sign.**

Every stall, miss, and skipped check gets a human name attached, visible to that person's lead. Arcadia never quietly fixes a problem a human should have caught. If she absorbs accountability instead of exposing it, the entire project is worthless — the team simply learns that Arcadia catches things, the same way they learned the founder catches things.

When you face an implementation choice between "Arcadia handles it" and "Arcadia flags it to a named human," **choose flagging.**

---

## 2. Stack — non-negotiable

Everything runs on Cloudflare. Nothing runs on a local machine. No step in any production path may depend on someone's laptop being awake.

| Layer | Choice | Notes |
|---|---|---|
| Agent framework | **`agents` SDK** (`npm install agents`) | Cloudflare's Agent SDK. Pre-1.0, pin the version. Not accepting external PRs — do not plan on upstreaming fixes |
| Compute | Workers | |
| Agent state + memory | Durable Objects, SQLite-backed | One DO per memory profile |
| Vector search | Vectorize | One index per profile |
| Operational data | D1 | Projects, certifications, stall events, audit log |
| Object storage | R2 | Artifacts, crawl snapshots, memory exports |
| Async | Queues | Ingestion, vectorization, retries |
| Embeddings | Workers AI `@cf/baai/bge-base-en-v1.5` | |
| Reasoning | Anthropic API **via AI Gateway** | Never call Anthropic directly. See §6 |
| Auth (staff-facing) | Cloudflare Access + Entra ID | Already in use for `kamino.s-fx.com` |
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
   - `guides/human-in-the-loop` — the approval-gate pattern used in Phase 1a and doctrine ratification
   - `guides/anthropic-patterns` — sequential, routing, parallel, orchestrator, evaluator
   - `examples/workflows`, `examples/agents-as-tools`, `examples/mcp-client`
   - `design/` — architecture decision records for sub-agents, workspace, retries

**Do not use** `cloudflare/computer`. It is preview-only, explicitly not production-suitable, and Arcadia needs no virtual filesystem.

**Do not recall API surfaces from memory.** The `agents` SDK is pre-1.0 and moving fast. Verify every binding, method signature, and config key against the MCP server or the cloned repo before using it.

---

## 3. Repository structure

```
arcadia/
├── CLAUDE.md
├── wrangler.jsonc
├── package.json
├── scripts/
│   └── setup.sh                  # creates D1, Vectorize, R2, KV, queues
├── reference/                    # gitignored — clone of cloudflare/agents
├── src/
│   ├── index.ts                  # Worker entry, routeAgentRequest
│   ├── agents/
│   │   ├── arcadia.ts            # root Agent
│   │   ├── hermes.ts             # sub-agent: content publishing
│   │   ├── radar.ts              # sub-agent: stall detection
│   │   └── ledger.ts             # sub-agent: certification ledger
│   ├── memory/
│   │   ├── driver.ts             # MemoryDriver interface — see §5.1
│   │   ├── self-hosted.ts        # DO + Vectorize implementation
│   │   └── agent-memory.ts       # stub; implement when CF Agent Memory hits GA
│   ├── workflows/
│   │   ├── publish.ts            # Hermes publish chain
│   │   └── ratify.ts             # doctrine ratification
│   ├── integrations/
│   │   ├── anthropic.ts          # AI Gateway-wrapped client
│   │   ├── wordpress.ts          # WP REST
│   │   └── graph.ts              # Microsoft Graph (phase 1b+)
│   ├── approval/
│   │   └── dashboard.tsx         # Cloudflare Access-protected approval UI
│   └── schema/
│       ├── d1.sql
│       └── types.ts
```

---

## 4. Build order

Build strictly in this order. Do not start a phase before the prior one has met its acceptance criteria.

### Phase 1a — Hermes (build this first)

Content agent. Publishes SEO tutorials to WordPress under the `/how-do-i/` slug prefix, `tutorials` custom post type.

Hermes is first **not because it's the most valuable, but because it exercises the entire plumbing chain** — Worker → SDK Agent → Workflow → AI Gateway → Anthropic → WordPress → approval gate — on a low-stakes artifact. Find the foundation problems on a blog post, not on the accountability system.

**Critical: Hermes has zero Microsoft dependency.** The approval gate is a Cloudflare Access-protected page, not a Teams card. This means Phase 1a ships without Azure Bot registration, app registration, or Global Admin consent — the single largest configuration burden in the project. Do not introduce a Microsoft dependency into Phase 1a for any reason.

**Workflow steps** (each independently durable and retryable):

1. `selectTopic` — pull from D1 topic queue, semantic-dedupe against `published_log`
2. `research` — web fetch, SERP check
3. `draft` — Claude Sonnet, recalls from `sfx-doctrine-canonical` for voice and positioning
4. `brandCheck` — validate against doctrine: never "MSP," "agency," "IT company," or "vendor"; always "fractional technology department"
5. `seoFields` — title, meta description, slug, SureRank meta
6. `linkCheck` — validate internal links resolve, no 404s
7. `approvalGate` — **human tap required.** SDK human-in-the-loop pause/resume
8. `publish` — WP REST, `tutorials` CPT
9. `log` — D1: post ID, doctrine entries used, sources

**Controls:**
- Draft-first for 60 days. No auto-publish until 60 clean days.
- Kill switch: KV flag checked at workflow start. Reachable by Shane, Diego, Vicky.
- Rate ceiling enforced in D1, not just schedule frequency.
- Publish window: business hours only.
- Provenance per post: which doctrine entries and sources produced it.

**Acceptance criteria:**
- [ ] `wrangler deploy` from clean clone produces a running Hermes
- [ ] Scheduled run produces a draft and an approval notification without human intervention
- [ ] Approving publishes to WordPress; the post appears with correct CPT, slug, and SEO fields
- [ ] Rejecting discards cleanly and returns the topic to the queue
- [ ] Kill switch halts the next scheduled run
- [ ] Full run costs are visible in AI Gateway analytics
- [ ] Nothing in the path touches a local machine

### Phase 1b — Stall Radar + Certification Ledger (30 days)

This is the slice that would have caught the two-week absence. Read-only Graph. No memory layer, no persona.

**M1 Stall Radar** — ground-truth signals only. Self-reported status is the mechanism that already failed; do not build on it.

| Signal | Source |
|---|---|
| File mtime in project folder | SharePoint / OneDrive via Graph |
| Planner task state transitions | Graph Planner API |
| Project channel message velocity | Teams change notifications |
| Git commit activity | GitHub API |
| Staging site HTTP diff | Direct crawl from Worker |

Escalation — **public at pod level. Never a private nudge only.**
- Day 3: DM to named owner
- Day 5: pod channel post naming owner **and** lead
- Day 7: founder digest, filed under the **lead's** name, not the doer's

The publicness is the mechanism. A quiet DM is one more thing to ignore.

**M2 Certification Ledger** — the highest-leverage component in the project.

Work cannot advance a stage until the doer signs a pre-flight checklist — timestamped, immutable, attributed. Checklist items must be concrete and certifiable. Never "check your work."

Then: **Arcadia independently verifies the subset she can.** This is what makes it real.

| Item | Human signs | Arcadia verifies |
|---|---|---|
| No typos in headings/body | ✓ | Yes — spell/grammar pass on rendered DOM |
| All links resolve | ✓ | Yes — crawl, report non-200s |
| Tested at mobile width | ✓ | Yes — Browser Rendering at 390px |
| Forms submit and deliver | ✓ | Partial |
| Meta title/description present | ✓ | Yes |
| Copy matches approved doc | ✓ | Partial — diff against source |

When someone signs "all links resolve" and the crawler finds 404s, that is a **false certification event** — logged, attributed, surfaced to their lead. Not "the project had errors." Specifically: *you signed for something untrue.*

**False-certification rate must be queryable per person.** That number is the whole point of the module.

Launch checklists: web build, SEO deliverable, social post, IT ticket close, client-facing document.

**Acceptance criteria:**
- [ ] Stall detection fires on real project data with <10% false positives over two weeks
- [ ] Escalation ladder posts publicly at day 5 with correct owner and lead
- [ ] Certification cards render and sign; signatures are immutable
- [ ] At least four checklist items auto-verify
- [ ] False-certification rate queryable per person and per pod

### Phase 2 — Memory core + Ask Arcadia (60 days)

See §5. AI-Shane surface goes live here. This is where the Azure Bot registration becomes necessary — Teams is the interface for Ask Arcadia.

### Phase 3 — Next-Action Dispatch + Escalation Enforcement (90 days)

Dispatch: task marked done → next task offered immediately, matched on skill and priority. No assignment >4 working hours → **lead** gets pinged, not the person.

Escalation enforcement: encode **Developer → Allie (QA) → Diego (Tech Review) → Shane (Pre-Launch)**. Stages cannot be skipped. Each has an SLA; breach escalates to that reviewer's lead. Reviewer approval is itself a signed certification.

**Pass-through detection:** a stage that consistently approves in under N seconds, or approves work that later fails downstream, gets flagged as ineffective. This is the direct instrument for a QA gate that forwards instead of filters. Build it.

Deliberately last — Arcadia needs a proven memory layer before she's trusted to route people.

### Phase 4 — Site Planning

Absorbs the sunset Kamino tool. Crawl a site → diagnose (orphans, nav depth, duplicated intent, missing conversion paths, thin content) → propose nav map → spec each page section-by-section against the Brixies/ACSS/Bricks stack.

**Hard requirement: output must include reasoning, not just recommendations.** One-line rationale per decision. The team has not internalized IA concepts after dozens of iterations; an opaque generator makes that permanent and leaves Shane as the only person who can evaluate the output. Melina and Diego approve before anything reaches a client.

### Phase 5 — Cloudflare Agent Memory migration

When it exits private beta: implement `AgentMemoryDriver` against the same interface, dual-write, compare recall quality, cut over.

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
| `sfx-doctrine-canonical` | Shane's rules, positions, pricing philosophy, bid criteria, voice | **Promotion only. No direct writes, ever.** |
| `sfx-doctrine-staging` | Candidates awaiting ratification | Auto-writes |
| `sfx-project-{id}` | Per-engagement facts, client constraints, decisions | Auto-commits facts, flags conflicts |
| `sfx-person-{id}` | Per-staff patterns, certification reliability | Auto-observes, never auto-acts |
| `sfx-episodic` | Append-only decision log | Auto, immutable |

**Arcadia recalls only from `canonical`.** Staging is a queue, not a memory.

**Layer discipline matters.** A client's contract price belongs in that client's project profile. The principle behind it — rate locks yes, discounts no, deferred payment is a convenience not a savings offer — belongs in doctrine. Never promote a project-specific figure into doctrine, or Arcadia will quote one client's number at another.

### 5.3 Ingestion pipeline

```
capture
  → content-addressed ID (SHA-256 of profile+role+content, 128-bit)  [idempotent]
  → extraction pass A: full chunk, ~10K chars, 2-message overlap     [Haiku]
  → extraction pass B: detail sweep for concrete values              [Haiku]
  → verification against source transcript                           [Haiku]
  → classify: fact | event | instruction | task + normalized topic key
  → dedupe: vector similarity within profile
  → conflict check on matching topic key:
      ├─ project/person → supersede, keep version chain
      └─ doctrine       → HALT. Surface both. Human chooses.
  → write (INSERT OR IGNORE)
  → background vectorize via Queue
```

**Pass B is mandatory.** S-FX doctrine is dense with specific figures — dates, rates, term lengths, client counts. Broad extraction reliably loses exactly those. The detail sweep uses overlapping windows prompted specifically for names, prices, dates, version numbers, entity attributes.

**Embedding trick:** prepend 3–5 generated search queries to memory content before embedding. Memories are written declaratively ("no discounts, rate locks only") but searched interrogatively ("can I discount this?"). Bridging that is most of the recall quality.

### 5.4 Retrieval

Three channels in parallel, fused by Reciprocal Rank Fusion:

| Channel | Weight |
|---|---|
| Exact topic-key lookup | Highest |
| Full-text (FTS5 in the DO, Porter stemming) | Medium |
| Vector (Vectorize cosine) | Medium |

Ties break by recency. Top candidates go to Claude for synthesis.

**Held in reserve:** HyDE — generate a hypothetical answer, embed *that*, search on it. Better on abstract and multi-hop queries, costs one extra small model call. Add only if recall quality disappoints. Do not build day one.

### 5.5 Capture channels

- **A — Direct deposit.** DM to Arcadia, typed or voice (Workers AI Whisper). Must take under 15 seconds or it won't get used.
- **B — Ambient extraction.** Watch designated channels, propose doctrine candidates from decisions made in normal work.
- **C — Bulk seed.** One-time import: this file, Kamino CLAUDE.md, Koerner communication directives, website redesign export, brand positioning docs, past proposals, pricing history, Blueprint posts. Targets ~60% doctrine coverage on day one.
- **D — Gap interrogation.** *Highest value.* When Arcadia can't answer confidently, she queues the question for Shane. His answer becomes permanent doctrine. Every gap closes once, forever. This is what makes her useful during absences rather than confidently wrong.

### 5.6 Controls — implement all of these

1. **Doctrine never auto-commits.** Staging → human tap → canonical. Most important control in the system.
2. **Contradiction halts.** Conflicting input surfaces both versions. No silent overwrite.
3. **Supersession, never deletion.** Version chain with forward pointer.
4. **Provenance on every entry** — captured when, from where, ratified by whom.
5. **Decay review.** Unused >180 days surfaces for confirmation, not deletion.
6. **Full action audit.** Every output logs which doctrine entries informed it.
7. **Confidence floor.** Below threshold, escalate instead of answering. A confidently-invented Shane opinion is worse than no answer.
8. **Export on demand.** Dump DO SQLite to R2 any time.

### 5.7 Person memory

Sensitive layer. Read access: the person themselves, their lead, Shane. Nobody else. Build it assuming staff know it exists and can see their own numbers — covert scoring that surfaces later does more damage than the metric is worth.

---

## 6. Model routing

**Cloudflare Workers AI is the default provider.** Everything stays on Cloudflare: no third-party key required to run Arcadia, inference is billed in Neurons against the Workers plan, and Workers AI calls go through the AI Gateway binding option so per-call cost stays observable — which is how the monthly spend ceiling gets enforced rather than hoped for.

**Routing is per task, not per tier, and every task is admin-configurable.** Call sites name a `TaskKind` (`src/ai/types.ts`) and never a model; `ModelRouter` (`src/ai/router.ts`) resolves it from D1 (`model_config`, KV-cached) falling back to the built-in defaults. A superadmin can point any single task at a different Workers AI model or at Claude from the admin surface, and the change takes effect within a minute without a deploy.

| Tier | Default model | Tasks |
|---|---|---|
| fast | `@cf/meta/llama-3.1-8b-instruct-fast` | stall sweeps, classification, extraction, detail sweep, verification, search queries, SEO fields, spellcheck |
| balanced | `@cf/openai/gpt-oss-120b` | drafting, brand revision, summaries, digests, synthesis, copy diff |
| deep | `@cf/zai-org/glm-5.2` | doctrine conflicts, novel judgment, site IA, page specs |
| embeddings | `@cf/baai/bge-base-en-v1.5` | fixed — the Vectorize indexes are 768-dim |
| transcription | `@cf/openai/whisper-large-v3-turbo` | capture channel A voice deposits |

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
| Drafting, summaries, digests, synthesis, Hermes articles | `claude-sonnet-4-6` |
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
- S-FX is a **fractional technology department**. Never "MSP," "agency," "IT company," or "vendor." Staff are **S-FX Specialists**.

---

## 8. Governance

**Roles and capabilities.** Cloudflare Access authenticates; `src/lib/rbac.ts` authorizes. Every mutating route checks a capability server-side — the dashboard only hides what the caller cannot do anyway.

| Role | Holds |
|---|---|
| `superadmin` | Everything, including model routing and user administration. **shane@s-fx.com and alex@s-fx.com only.** |
| `founder` | Approvals, ratification, kill switch, projects — but not tenancy administration |
| `lead` | Approvals, runs, topics, projects, their team's certification numbers |
| `specialist` | The board, signing their own checklists, Ask Arcadia |

An authenticated email with no `users` row gets the specialist baseline. The last active superadmin cannot be deactivated. Person-level records follow §5.7: the person, their lead, and Shane — enforced in queries, not markup.

**Graph permissions — minimum, application-scoped, phase 1b+:**
`Files.Read.All`, `Sites.Read.All`, `Tasks.ReadWrite.All`, `ChannelMessage.Read.All`, `Chat.Read.All`, `User.Read.All`, `Presence.Read.All`, `Calendars.Read`

**Arcadia may never do autonomously:**
- Send anything to a client
- Publish to a live site (until Hermes clears 60 days)
- Modify or delete a file
- Write to `sfx-doctrine-canonical`
- Any compensation or HR action
- Overrule a human — she may flag, escalate, and log. That is all.

**Audit:** every action, doctrine entry used, and escalation, append-only in D1, queryable from the dashboard.

---

## 9. Human-only steps — do not attempt to automate

Flag these to Shane and stop. Roughly 30 minutes total, one time.

**Before Phase 1a:**
1. Generate a WordPress Application Password for user `sfxdotcom` (WP admin UI)
2. Create an Anthropic API key (console)
3. Create an AI Gateway in the Cloudflare dashboard, note the gateway ID
4. Create a Cloudflare API token for `wrangler`
5. Configure the Cloudflare Access policy for the approval dashboard route
6. **Read the SureRank meta field keys off a live tutorial post** — pull one via `?_fields=meta` and read the actual keys. Do not guess them. Guessing silently produces posts with no SEO fields, which is worse than failing loudly.

**Before Phase 2:**
7. Azure app registration + Bot registration + Global Admin consent for Graph and Teams

Everything else is `./scripts/setup.sh` then `wrangler deploy`, repeatable from a clean clone.

---

## 10. Open questions

**Resolved (August 5, 2026):**

1. ~~**Where does project work tracking actually live?**~~ **Planner is the system of record for task state; progress is discussed in Teams channel threads.** Both are first-class Radar signals. Phase 1b is a 30-day build with no migration — the good case.
2. **Escalation channel before Teams.** Day 3/5/7 escalations go out as email plus a durable public accountability board in the dashboard. Teams DMs and channel posts arrive with the Azure Bot registration in Phase 2. The board is the durable leg; email is best effort and its failure never loses an escalation.
3. **Default reasoning provider** — Workers AI, per-task configurable in admin (§6).

**Still open:**

4. **Is Foundry (dev team) work in Git?** The git signal is implemented and needs only a `GITHUB_TOKEN` plus per-project repo config. Where work is in Git, commit activity is the cleanest stall signal available.
5. **Teams change notification costs.** Microsoft removed metered charges on Teams chat/channel change notifications as of August 25, 2025, but protected-API approval and licensing requirements may still apply. Verify before architecting around it. Radar currently polls channel message velocity rather than subscribing, which sidesteps this.
6. **Monthly spend ceiling** — needs a number to configure in AI Gateway. Workers AI defaults make this far cheaper than the original Claude-first routing, but the ceiling still wants a number.
7. **Who maintains Arcadia?** She needs an owner who isn't Shane, or she becomes one more thing that stalls when he steps away.

---

## 11. Known limitations — state these honestly, don't design around them

- **Self-hosted memory is noisier than a managed service.** Four verification checks instead of Cloudflare's eight, no HyDE at launch. The ratification gate absorbs it. Expect the first month of Friday digests to contain rejects.
- **Arcadia cannot replicate judgment that was never articulated.** She applies stated rules to new situations. She cannot originate a position on something Shane has never had one about. Capture channel D narrows this; it never closes it.
- **Phase 1b will surface uncomfortable data** naming specific people. That's the design working, not a bug to soften.
- **A tool cannot install accountability into a chain that doesn't want it.** If the leads don't act on what Arcadia surfaces, the project will have automated noticing and changed nothing. Phase 1b's real test isn't whether the code works — it's whether a named public flag produces a different response than the founder's absence did.
