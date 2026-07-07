# EXECUTION-PLAN.md — Arcadia v2.1: Tenant Intelligence, Shared Access, Learning, Autonomy

> **Status (2026-07-07): P0–P5 all implemented on branch
> `claude/m365-intelligence-agent-plan-s0eh3w`.** Type-check clean, 93
> unit + 173 integration tests green, worker compiles for deploy, web
> passes svelte-check. Remaining work is operator-side, not code: the
> Microsoft tenant prerequisites in `RUNBOOK.md §14` (Entra consents,
> protected-API approval, metered billing, data-governance sign-off) and
> the data-governance decision before mail ingestion ships to prod. See
> §3 phase exit criteria — each was met in code and tests; production
> "sees everything" (M2) is gated on the tenant approvals, not the build.
>
> Written 2026-07-07 after a full code-verified review of the platform.
> This plan supersedes the build-order in `ARCHITECTURE.md §10` (which is
> complete or stale). `SOUL.md` remains canonical for character and values.
>
> **The goal, in the operator's words:** pull in all M365 data from the
> tenant so the owner gets a full scope of what's happening in the entire
> organization at a given moment; let the agent learn and grow
> (self-teaching); give it the autonomy to help do things; and let other
> staff use it, restricted to only what they have access to.

---

## 1. Where the platform actually stands today

The codebase is substantial (~14,500 lines of real TypeScript, type-check
clean, 64 unit tests passing) and most modules described in
`ARCHITECTURE.md` exist with real logic: memory store + consolidation,
tiered AI router, ACL machinery, tasks + Planner sync, routines, charter,
digests/briefs/weekly, Clients, cards with Universal Actions, OpenAPI +
Copilot Connector, eval harness, and a working SvelteKit web app.

But the review found that the four things the operator wants are exactly
the four things that don't work yet:

### 1.1 "Pull in all M365 data" — ingestion is mostly dead

- **Real-time ingestion doesn't exist.** Graph change-notification
  subscriptions are never created from code (`createSubscription` has zero
  call sites) and the webhook handler stops at a `TODO: fan out`
  (`src/graph/subscriptions.ts:255-257`). Everything rides the 15-minute
  poll.
- **Only one producer actually runs.** `produceDrives` and
  `produceSharepoint` never walk anything: they discover drive/site IDs via
  `json_extract(documents.uri, '$.driveId')` but the producers store `uri`
  as a plain path string (`src/ingest/producers/drive.ts:78-90,118`,
  `sharepoint.ts:61-72,93`) — the extraction is always NULL, so zero
  files or pages are ever ingested. Chat ingestion never runs because
  nothing ever inserts into the `chats` table.
- **Systemic pagination bug.** Every producer passes the full
  `@odata.nextLink` URL back through `graphRequest`, which prefixes
  `GRAPH_BASE` again (`src/graph/client.ts:38-48`), producing
  `https://graph…/v1.0/https://graph…` — page 2+ always 404s. Only the
  first ~50 items of any resource are ever walked.
- **No producers at all** for mail, calendar, OneNote, or online
  meetings/transcripts — despite `ARCHITECTURE.md §3` claiming the
  mail/drive/sharepoint/calendar/onenote/teams pipeline is preserved.
- **Ingested documents are unreachable.** Document chunks are embedded into
  the shared Vectorize index with a `doc:` ID prefix, but
  `MemoryStore.recall` hydrates hits only from the `memories` table and
  silently drops everything else (`src/memory/store.ts:143-147`).
  `document_chunks` is never SELECTed anywhere. We index content nothing
  can retrieve.
- `users` is barely populated and `users.last_seen_at` is never written,
  which leaves meeting-intel permanently inert.

### 1.2 "Staff restricted to what they have access to" — not yet true

- **Web sessions are forgeable.** `/api/webapp/auth/exchange` decodes the
  incoming Entra token with `decodeJwt` and **never verifies the
  signature, issuer, audience, or expiry** (`src/webapp/auth.ts:59-67` —
  the comment admits it). Anyone who can reach the endpoint can mint a
  session for any user, including the admin.
- **ACL default is tenant-open, not strict.** An empty ACL row set means
  *allow* (`src/acl/resource-acl.ts:111-112`), and no code path ever
  creates `resource_acl` rows for channels or chats. Net effect: any
  authenticated tenant user can recall memories from channels they were
  never in. `ARCHITECTURE.md §2` ("strict from day one") is aspirational.
- **Dashboard digests are tenant-wide** regardless of viewer membership
  (`src/webapp/dashboard-api.ts:187-197`).
- **`/api/mcp` is unauthenticated** and its tools mostly bypass ACL:
  `recall_memory` only filters if the caller volunteers a
  `viewer_aad_id`; `find_owner` and `summarize_thread` never check at all
  (`src/mcp/tools.ts`).
- **Delegated Graph (OBO) is dead code.** Two complete OBO implementations
  exist (`src/graph/auth.ts:62`, `src/webapp/auth.ts:171`) and neither has
  a single call site. Production is 100% app-only.

### 1.3 "Learn and grow" — the loop is not closed

- The `feedback` table is write-only: card verbs insert rows, **no code
  ever reads them**.
- The procedural-learning knobs (`PROCEDURE_MIN_USES`,
  `PROCEDURE_PROMOTE_THRESHOLD`, `PROCEDURE_RETIRE_THRESHOLD`,
  `RESEARCH_QUESTION_MAX_*`) are parsed into config and never consumed.
- No person/customer profiles module exists (`memory/profiles.ts` is
  missing; the `query_customer` MCP tool throws).
- No heartbeat, no self-model. The consolidation cycles (light/deep/REM)
  are real and good — but they compress what Arcadia saw; they don't
  improve how she behaves.
- The eval harness measures regressions nightly but feeds nothing back.

### 1.4 "Autonomy to help me do things" — read-only today

Arcadia can post digests, cards, and nudges, and sync Planner tasks. She
has no general action surface (send/draft messages, schedule, file ops),
no permissioned action framework, and 3 of 8 MCP tools throw
`not implemented`.

### 1.5 Structural honesty issues

- The central premise of v2 — the Microsoft 365 Agents SDK — **was never
  adopted**: `@microsoft/agents-*` is a dependency with zero imports. The
  runtime is the hand-rolled Bot Framework stack `ARCHITECTURE.md §2`
  claims was torn down. Same for `@modelcontextprotocol/sdk` (MCP server
  is hand-rolled JSON-RPC). It *works*, but docs and code disagree.
- `ARCHITECTURE.md §5` lists ~40 files that don't exist. `claude.md`'s
  status markers are stale in the other direction (calls implemented
  modules stubs).
- Tests run in a plain `node` environment; nothing that touches D1,
  Vectorize, Queues, or Graph is tested. None of the bugs above would be
  caught by `npm run ci`.

**A note on "Hermes Agent":** there are no references to Hermes anywhere
in this repo. This plan interprets it as the pattern of a self-teaching
agent: persistent layered memory, a feedback→behavior loop, an evolving
self-model, and the ability to acquire new skills (here: routines and
procedures) over time. If Hermes means something more specific, Phase 4
is the section to adjust.

---

## 2. Target architecture decisions

Five decisions shape everything below. Recommendation stated for each.

### D1 — Two-plane identity model

- **Ingestion plane (app-only):** Arcadia keeps her own application
  identity with tenant-wide read permissions. This is the only way to
  "watch everything" continuously — delegated tokens can't power
  background ingestion of content no one is looking at.
- **Access plane (verified user + trimming at read time):** every human
  surface (web, Teams, MCP) resolves a *cryptographically verified* user
  identity, and every read is filtered through `resource_acl` +
  sensitivity policy derived from real Graph memberships. Additionally,
  staff-facing *live* Graph operations (search, presence, files-on-demand)
  go through **delegated OBO** so Microsoft Graph enforces native security
  trimming as a second, independent layer.
- **Admin plane:** `ADMIN_USER_AAD_ID` / `users.is_admin` retains
  cross-tenant visibility, exactly as `SOUL.md` describes Shane's role.

### D2 — Default-deny ACL, derived automatically from Graph

The current "empty ACL = open" rule exists because nothing populates
ACLs. The fix is not to hand-author grants; it is to **derive them during
ingestion**: every channel, chat, site, drive, and mailbox scope gets a
`resource_acl` row pointing at its backing M365 group / member set (the
Clients feature already models this pattern —
`ARCHITECTURE.md §6`). Once derivation is live, flip the default to
deny-with-admin-exception. Sequencing matters: flip *after* derivation,
or every surface goes dark.

### D3 — One retrieval API over memories + documents

Unify recall so a single ACL-enforced query federates memory vectors and
document-chunk vectors (they already share an index; the hydration layer
is what discriminates). Everything — chat, MCP, digests, briefs — goes
through this one gate. One choke point to secure, one to test.

### D4 — Keep the hand-rolled runtime; make the docs tell the truth

Adopting the M365 Agents SDK now would be a second rewrite with no user
payoff — the hand-rolled runtime works, and the SDK's value (channel
abstraction for Copilot/Outlook/Webchat) is deferred scope anyway
(`ARCHITECTURE.md §9`). Keep the current runtime, drop the two unused
dependencies, rewrite `ARCHITECTURE.md §5` to the real file inventory,
and revisit the SDK only if/when Copilot or Outlook channels become a
priority.

### D5 — Autonomy as a capability ladder, never a blank check

`SOUL.md` commits Arcadia to never executing irreversible actions without
confirmation. Autonomy is therefore built as an explicit ladder per
action verb: **observe → draft → act-with-confirmation →
act-autonomously (allowlisted per verb, per scope, by the admin)** — with
an append-only action audit table and a kill switch. Routines are the
substrate; "self-teaching" (Phase 4) lets Arcadia *propose* new routines
and procedures, and the admin promotes them up the ladder.

---

## 3. Execution phases

Phases are sequenced by dependency and by risk: safety first, then data,
then sharing, then intelligence, then learning, then autonomy. Each phase
has an exit criterion — do not stack the next phase on an unmet one.

### Phase 0 — Close the security holes *(small; do immediately, before anything else)*

The platform must not be shared with staff — or even left deployed — with
forgeable sessions and an open MCP endpoint.

1. **Verify Entra tokens for real** in `exchangeAndSeal`
   (`src/webapp/auth.ts`): JWKS fetch from
   `login.microsoftonline.com/{tid}/discovery/v2.0/keys`, verify
   signature + `iss` + `aud` (= `WEBAPP_CLIENT_ID`) + `exp` + `tid`
   allowlist, using `jose` (already a dependency). Reject v1 tokens.
2. **Authenticate `/api/mcp`.** Require the sealed session cookie or a
   bearer token bound to a real user; derive `viewer` from the verified
   identity **server-side** — delete the caller-supplied
   `viewer_aad_id` parameter. Make `find_owner`, `summarize_thread`,
   `list_stale_threads` viewer-scoped; admin-gate cross-user rationale.
3. **Validate Graph webhook `validationTokens`** (signed JWTs from
   Microsoft) in `/api/graph/notify`, not just `clientState`.
4. **Scope dashboard digests to the viewer** (`fetchRecentDigests`):
   filter by channel membership once ACL derivation exists; interim, by
   channels the viewer has interacted with.
5. Add the first **integration test harness** using
   `@cloudflare/vitest-pool-workers` (already a devDependency, unused) so
   items 1–4 get real regression tests against D1/KV bindings.

**Exit criterion:** a forged JWT and an anonymous MCP call both return
401 in an integration test; CI runs those tests.

### Phase 1 — Make ingestion real: the tenant-wide view *(large; the heart of the "full scope" goal)*

Work items, roughly in dependency order:

1. **Fix `graphRequest` pagination** (`src/graph/client.ts`): accept
   absolute `@odata.nextLink`/`@odata.deltaLink` URLs without
   re-prefixing. One fix unblocks every producer. Also fix the chat-
   message walk that applies a `$deltatoken` to a non-delta endpoint
   (`src/graph/messages.ts:174-177`).
2. **Fix drive/site discovery**: enumerate from Graph
   (`/sites?search=*`, `/drives`, `/users/{id}/drive`) into first-class
   `sites`/`drives` registry tables (new migration) instead of
   json-extracting from `documents.uri`. Store structured
   `{driveId, siteId, itemId}` metadata on `documents`.
3. **Populate the org registry continuously**: delta-walk `/users`
   (fills `users`, enables meeting-intel), `/groups`, `/chats`
   (fills the never-populated `chats` table), teams + channels beyond
   bot-install events. Write `users.last_seen_at` from message activity.
4. **New producers**: mail (per-mailbox delta, honoring an Exchange
   application access policy), calendar (`/users/{id}/calendarView`
   delta), OneNote (parser already exists, orphaned), online meetings +
   transcripts (post-meeting fetch keyed off calendar events).
5. **Turn on change notifications**: create subscriptions from code on a
   lifecycle cron (create/renew/reauthorize), implement the webhook
   fan-out at `subscriptions.ts:255` to enqueue `IngestMessage`s, and
   fall back to delta polls for resources without notification support.
   Poll cadence drops from "everything every 15 min" to "delta sweep as
   backstop".
6. **Unified recall (D3)**: extend `MemoryStore.recall` (or a new
   `recall/` module wrapping it) to hydrate `doc:` hits from
   `document_chunks` + `documents`, with the same ACL filter applied to
   both result types. This makes months of ingested content actually
   retrievable.
7. **Ingest observability**: per-source freshness + counts + error table
   surfaced on the web app's `/sources` page, so "is Arcadia seeing
   everything?" is answerable at a glance. Add per-producer integration
   tests with mocked Graph fixtures.

**External dependencies (start these on day one — lead time is weeks,
not hours):**

- **Entra application permissions + admin consent** for the app-only
  registration: `User.Read.All`, `Group.Read.All`,
  `GroupMember.Read.All`, `ChannelMessage.Read.All`, `Chat.Read.All`,
  `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`,
  `OnlineMeetings.Read.All`, `OnlineMeetingTranscript.Read.All`,
  `Presence.Read.All`, `Tasks.ReadWrite.All`.
- **Microsoft protected-API approval** — app-only Teams message reading
  (`ChannelMessage.Read.All`, `Chat.Read.All`) and meeting transcripts
  require Microsoft's protected-API request form and approval.
- **Metered API billing** — Teams message/export APIs and their change
  notifications are metered; link an Azure subscription to the app
  registration and pick a licensing model.
- **Exchange application access policy** — decide whether mail ingestion
  covers all mailboxes or a scoped set, and configure the policy.
- **Data-governance sign-off** — this phase copies tenant content into
  Cloudflare D1/Vectorize, outside Purview's reach. Decide retention
  windows (the `expires_at` column exists), what is excluded
  (e.g. HR/legal channels), and document it.

**Exit criterion:** the `/sources` page shows fresh (≤15 min) coverage
across Teams messages, chats, mail, calendar, SharePoint, OneDrive, and
meetings; a question in web chat retrieves document content ingested
that morning.

### Phase 2 — Permission-trimmed staff access *(medium; unlocks rollout beyond Shane)*

1. **ACL derivation pipeline**: during registry sync (Phase 1.3), write
   `resource_acl` rows — channel → backing M365 group, chat → member
   list, site/drive → site group membership, mailbox/calendar → owner
   user. Refresh with the existing 6-hour `group_membership` cron.
2. **Flip the default to deny** in `resource-acl.ts` (empty ACL = deny,
   admin exempt) — only after derivation has backfilled, behind a
   one-time migration check.
3. **Sensitivity labels**: capture labels during ingestion into
   memory/document metadata so the existing `confidential`/`redact`
   policies (`src/acl/sensitivity.ts`) actually receive real labels.
4. **Subject privacy**: enforce the `SOUL.md` promise that non-admins
   can't query another person's behavior — recall filters memories whose
   `subject_aad_id` is a third party unless the scope is shared *and*
   the content class allows it; cross-user analytical questions route
   to an admin-only path.
5. **Delegated OBO lane**: wire the existing dead `getOboToken` into
   staff-facing live-Graph features (Microsoft Search API queries,
   presence, file fetch-on-demand) so Graph's native trimming backs our
   ACL for anything fetched live.
6. **Red-team test suite**: integration tests where user B attempts to
   read user A's channels, chats, mail-derived memories, documents,
   digests, and MCP tools — all must come back empty/denied. Make this
   suite a CI gate like the eval gate.
7. **Staff onboarding UX**: Teams app distribution to the org, web login
   flow polish, and a first-run explanation of what Arcadia can see
   (transparency is a `SOUL.md` value and also good change management).

**Exit criterion:** the red-team suite passes in CI; a real second staff
account sees only its own scopes end-to-end.

### Phase 3 — Owner intelligence: beyond Copilot *(medium; this is the differentiating value)*

Copilot answers questions about content the caller can see. Arcadia's
edge is the **persistent, cross-source, longitudinal model** of the org —
the thing Copilot doesn't build. With full ingestion (P1) in place:

1. **Org pulse**: generalize `src/intelligence/client-status.ts` into a
   tenant-wide "what is happening right now" synthesis for the admin —
   active workstreams, decisions in flight, stalled threads, at-risk
   tasks, unusual silences — as a dashboard view and an on-demand chat
   answer. This is the "full scope at a given moment" deliverable.
2. **Profiles module** (`src/memory/profiles.ts`, currently missing):
   person profiles (communication style, focus areas, working patterns)
   and customer profiles (contacts, topics, sentiment, recent context),
   updated on the every-N-messages cadence `SOUL.md` describes, stored
   as structured semantic/observation memories. Backs `query_customer`
   (currently a stub) and the admin's cross-user questions.
3. **Microsoft Search integration** (`src/graph/search.ts`, missing):
   use the Search API (OBO for staff, app-only for admin) as a recall
   surface alongside vector recall — Graph-trimmed by construction.
4. **Presence-aware behavior** (`src/graph/presence.ts`, missing): the
   nudge engine checks presence before pinging, as v2 always promised.
5. **Meeting intelligence completion**: transcript ingestion (P1.4) →
   decision + task extraction → pre-meeting briefs and post-meeting
   wrap-ups, now unblocked by real `users` data.
6. **Decision graph**: strengthen `decisions` extraction across mail +
   meetings + chat, linked to tasks and owners — the admin's "what got
   decided this week, by whom, and is it moving?"

**Exit criterion:** Shane can ask "what's happening in the org right
now?" and get an accurate, sourced synthesis spanning Teams, mail,
meetings, and files — something Copilot demonstrably cannot answer.

### Phase 4 — Close the learning loop (the Hermes property) *(medium)*

Everything here rides on scaffolding that already exists but is inert.
The design rule, per `SOUL.md` and D5: **Arcadia proposes; the operator
ratifies.** Self-teaching never silently changes behavior.

1. **Feedback consumption**: a consolidation-cycle stage reads the
   (currently write-only) `feedback` table — negative digest feedback
   tunes digest emphasis per channel; spurious-task feedback tunes
   detection thresholds; `memory_correct` events lower confidence in
   sibling memories from the same source.
2. **Procedural promotion/retirement**: implement the loop the config
   knobs were built for — track procedure usage + outcome signals;
   promote procedures past `PROCEDURE_PROMOTE_THRESHOLD` into the
   always-injected prompt context; retire below
   `PROCEDURE_RETIRE_THRESHOLD`. This is the concrete mechanism by which
   "every conversation teaches her something" becomes true.
3. **Self-model + heartbeat**: implement the weekly REM output `SOUL.md`
   describes — a versioned procedural memory ("what I've learned about
   this team and my role") injected into system prompts; plus the daily
   heartbeat health check (memory balance, stale understanding,
   surfaced-opportunity queue).
4. **Eval-driven improvement**: nightly eval failures generate
   *proposed* charter amendments or memory corrections into a review
   queue on the web app; admin approves → published via the existing
   append-only charter mechanism. The gate stops regressions; this makes
   it also drive progress. Grow `evals/cases/` alongside every phase.
5. **Curiosity budget**: implement the unused `RESEARCH_QUESTION_MAX_*`
   knobs — during deep consolidation Arcadia identifies gaps in her
   model ("who owns X?", "is project Y still alive?") and asks a bounded
   number of clarifying questions in the right channel or the admin's
   DM.

**Exit criterion:** a correction given on Monday measurably changes
behavior by Friday (demonstrated via an eval case), with the change
visible and reversible in the review queue.

### Phase 5 — Autonomy: from watching to doing *(medium-large; gated on P0+P2 trust)*

1. **Action framework** (`src/actions/`): typed action verbs (draft
   mail/message, send message, schedule meeting, create/assign/complete
   task, create Planner item, post to channel, run routine), each
   executed via Graph write scopes, each carrying: capability-ladder
   level (D5), per-scope allowlist, append-only `action_log` row, and a
   confirmation card (Universal Actions, existing pattern) when below
   "act-autonomously".
2. **Write permissions**: add the corresponding Graph write scopes
   (`Mail.Send`, `Calendars.ReadWrite`, `ChannelMessage.Send`,
   `Chat.ReadWrite.All`, `Tasks.ReadWrite.All`) — delegated where the
   action is on behalf of a staff user (OBO lane), app-only where
   Arcadia acts as herself.
3. **Complete the MCP tool surface**: implement the three stubs
   (`query_customer` on profiles, `assign_task`, `query_routines`) and
   expose the action verbs as MCP tools with the same ladder + audit —
   Claude Desktop / Copilot Studio become steerable cockpits for free.
4. **Arcadia-authored routines**: let her draft routine definitions
   (the Zod schema + executor already exist) into a pending state;
   admin approves → active. Combined with Phase 4, this is skill
   acquisition: she notices a recurring manual pattern, proposes the
   routine that automates it.
5. **Safety rails**: global kill switch (KV flag checked by executor +
   action framework), per-day action budgets, and an admin action-audit
   view in the web app.

**Exit criterion:** "Arcadia, chase the overdue invoices thread and set
up a 30-minute call with the owner" results in a drafted message +
proposed meeting card, one tap to execute, full audit trail — and the
same request from a non-admin only touches resources they can access.

### Phase 6 — Platform truth + hardening *(continuous, start alongside P1)*

1. Rewrite `ARCHITECTURE.md §5` to the real file inventory; fix
   `claude.md` status markers; align `SOUL.md` consolidation cadences
   with the actual crons (or the crons with SOUL — pick one).
2. Remove unused `@microsoft/agents-*` and `@modelcontextprotocol/sdk`
   dependencies (per D4), or consciously adopt them — don't leave the
   contradiction.
3. Delete the throwing `storage-adapter.ts` stub or implement it.
4. Grow integration coverage (pool-workers) to the queue consumer,
   consolidation, router, and invoke-dispatch paths; keep the eval gate
   and the red-team gate green in CI.
5. Ops: per-environment wrangler overlays (`env.dev`/`env.prod` are
   sketched but commented out), error budgets/alerting on cron + queue
   failures, and AI Gateway caching in front of Anthropic.

---

## 4. Sequencing summary

```
P0 Security          ████                       (immediate, ~days)
P1 Ingestion              ████████████          (largest single phase)
P2 Staff access                 ████████        (overlaps P1 tail)
P3 Owner intel                       ████████   (needs P1)
P4 Learning loop                          ██████ (needs P3 profiles)
P5 Autonomy                                  ████████ (needs P0+P2 trust)
P6 Truth/hardening        ─────────continuous─────────
External (consents, protected-API approval, billing): file in week 1 —
longest lead-time item in the whole plan.
```

Milestones, in operator terms:

| Milestone | Meaning |
| --- | --- |
| **M1 Safe** | No forgeable sessions, no open endpoints. Deployable without risk. |
| **M2 Sees everything** | Full-tenant ingestion fresh to ≤15 min; owner has the full-scope view. |
| **M3 Safely shared** | Staff onboarded; red-team gate proves trimming. |
| **M4 Understands** | Org pulse, profiles, meeting + decision intelligence. |
| **M5 Learns** | Feedback→behavior loop closed; self-model live; corrections stick. |
| **M6 Acts** | Permissioned autonomy with audit + kill switch. |

## 5. Top risks

1. **Protected-API approval slips.** App-only Teams message + transcript
   access needs Microsoft's sign-off. Mitigation: file immediately; the
   bot's existing conversation stream and delta endpoints cover interim
   ingestion of channels the bot is installed in.
2. **ACL flip breaks surfaces.** Default-deny before derivation backfills
   would blank every dashboard. Mitigation: derive first, flip behind a
   verification script that reports coverage.
3. **Data-governance exposure.** Tenant data replicated into Cloudflare
   is the plan's biggest non-technical decision — retention, exclusions,
   and eDiscovery posture need explicit sign-off before P1 ships mail.
4. **D1/Vectorize scale.** Full-tenant mail + files is orders of
   magnitude beyond today's data volume; watch D1 10 GB limits, consider
   R2 for raw bodies + aggressive `expires_at` policies (episodic decay
   is already a design principle).
5. **Cost.** Embeddings + Claude calls scale with ingestion volume; the
   tiered router and AI Gateway caching are the levers — instrument
   per-source token spend in P1.7 observability.

---

*Each phase should land as a sequence of PRs following `claude.md`
conventions (forward-only migrations, strict TS, evals grow with
features, `Action.Execute`-only cards). This document is the working
contract for v2.1; update it as phases complete.*
