# Arcadia Operating Guide

For the operator: how to *run* Arcadia day-to-day once she's deployed.
For deployment + infrastructure see `RUNBOOK.md`; for architectural
shape see `ARCHITECTURE.md`; for character + voice see `SOUL.md`.

This document is short on purpose. Arcadia's whole design is "boring
infrastructure, opinionated behaviour" — there are very few knobs.

---

## 1. The dashboard is the home

`https://<your-worker>/` (or the Teams Dashboard Tab) lands on the
dashboard. It's a single GET to `/api/webapp/dashboard` and shows:

- Open / in-progress / blocked task counts for you
- Tasks due today
- Tasks overdue
- The five most recent digests in your tenant's channels
- The latest brief targeted at you (morning or evening)
- Your active routines

Strict ACL applies — everything is filtered to your AAD identity.

If the dashboard is empty after install, you're probably looking at a
new tenant. Two things populate the data:
- Add the bot to a channel → the `conversationUpdate` registers it and
  the 8am digest cycle will start producing digests.
- Send the bot a message → Arcadia writes episodic memory and (if the
  text carries a task cue) detects + persists a task.

---

## 2. The four surfaces

| Surface | What it's for |
| --- | --- |
| **Teams bot** (`@Arcadia` in channels + 1:1) | Conversational entry. Cards (digest, task, nudge) land in-channel. |
| **Web dashboard** (`web/`, or as a Dashboard Tab) | The operator-facing UI: chat, dashboard, memory, routines, settings. |
| **MCP** (`/api/mcp`) | Anything that speaks Model Context Protocol — Claude Desktop, Copilot Studio, Foundry. |
| **Microsoft Search** (Copilot Connector) | Arcadia's tasks + digests + briefs are searchable in Microsoft Copilot itself when `COPILOT_CONNECTION_ID` is set. |

---

## 3. Cards are how things change

Every interactive card uses `Action.Execute` and routes through
`src/runtime/invoke-dispatch.ts`. The verbs:

| Verb | What it does |
| --- | --- |
| `digest_refresh` | Re-render the digest for the viewing user (filtered to their ACL). |
| `digest_dismiss` | Record a negative feedback row; swap the card for an acknowledgement. |
| `task_accept` | Owner ← you; status ← `in_progress`. Writes `ownership_history`. |
| `task_reassign` | Open a sequential picker; recent tenant users as candidates. |
| `task_reassign_submit` | Owner ← selection; status unchanged. Writes `ownership_history` with the operator-supplied reason. |
| `task_complete` | Status ← `done`. Positive feedback row. |
| `task_snooze` | `last_nudge_at` ← now; defers nudges for `NUDGE_COOLDOWN_HOURS`. |
| `nudge_acknowledge` | Positive feedback. If `data.taskId`, advances the task to `in_progress` and resets `last_nudge_at`. |
| `nudge_snooze` | Negative feedback + cooldown. |
| `memory_correct` | Correction feedback + `MemoryStore.forget()` on the offending memory. |
| `feedback` | Generic feedback row — surface, target, signal, optional note. |

Card responses come back as either a swapped Adaptive Card or a brief
toast. There is no `Action.Submit` anywhere — if you find one, file it
as a bug.

---

## 4. The operator charter

The charter is your way to override Arcadia's inferences with canonical
ground truth. It rides ahead of every assistant system prompt — chat,
digest, briefs, weekly, decisions, meeting-intel.

Write it as plain prose. A useful charter says:
- Who the people are (named owners of areas)
- What the products / projects are
- Vocabulary that gets used internally
- Operating norms (what counts as a "decision", when to escalate)
- Customer specifics that don't change often

To publish a new version:

```http
POST /api/webapp/charter
Content-Type: application/json
Cookie: arcadia_session=<your session>

{ "body": "We ship Tuesdays. Anna owns onboarding. ACME is our largest customer. …" }
```

Or via the webapp Settings page (todo: surface a charter editor) /
directly via D1 for the first version (see `RUNBOOK.md §5`).

Mechanics:
- The table is **append-only** — every publish bumps the version, marks
  the previous active row as inactive, and links back via `replaces_id`.
- Reads are cached in KV for 60 seconds, so charter edits take up to a
  minute to ride into new prompts.
- Only `ADMIN_USER_AAD_ID` can publish or revert; anyone with a session
  can read.
- `POST /api/webapp/charter/:id/revert` re-publishes a prior version's
  body as a new forward-moving version.

---

## 5. Routines

Routines are small declarative workflows: a trigger plus an ordered
list of steps. Triggers are `cron`, `event` (Graph change
notification), or `manual` (run from the UI). Steps are:

- `recall_memory` — ACL-filtered vector recall
- `ai_complete` — single prompt through the tiered Router
- `tool_call` — invoke an MCP tool by name
- `post_text` — proactive Bot Framework text send
- `create_task` — `TaskStore.create()`

Each step can `as` a result into a shared context; later steps
interpolate via `{{name}}` or `{{name.path}}`.

### Example: morning standup roll-up

```json
{
  "name": "Morning standup digest",
  "trigger": { "kind": "cron", "cron": "0 9 * * 1-5" },
  "steps": [
    { "kind": "tool_call", "tool": "list_stale_threads", "input": { "limit": 10 }, "as": "stale" },
    { "kind": "ai_complete", "system": "Summarise these stale threads in 3 bullets, owners first.", "prompt": "{{stale}}", "tier": "balanced", "as": "summary" },
    { "kind": "post_text", "serviceUrl": "https://smba.trafficmanager.net/amer/", "conversationId": "<conversation-id>", "text": "Morning:\n{{summary.text}}" }
  ]
}
```

Publish via `POST /api/webapp/routines` or the UI. Manual runs from
the UI fire `POST /api/webapp/routines/:id/run` and return the per-step
context on success.

Validation: definitions are checked against a Zod schema on the way
in; bad shapes return 400 with the exact path of the failure.

---

## 6. Memory: how it behaves

Strict ACL is the default. Memory recall filters by:
1. **subject_aad_id == viewer** → always allowed (your own memory).
2. **`resource_acl` rows for the memory's scope** — empty ACL = open
   inside the tenant; otherwise a direct user grant, a `tenant` grant
   matching the viewer's tenant, or a `group` grant the viewer is a
   member of.
3. **Sensitivity label policy** — see `src/acl/sensitivity.ts`. The
   `redact` class scrubs content to "[redacted]" for any non-subject
   viewer; `confidential` requires an explicit ACL row (empty ACL is
   *deny* for confidential, not default-open).

To forget a memory you can see:
```http
POST /api/webapp/memory/<id>/forget
Cookie: arcadia_session=<your session>
```

Only the memory's subject or `ADMIN_USER_AAD_ID` can forget.

Consolidation cycles run automatically:
- Light (every 15 min) — prune expired + dedupe near-identicals
- Deep (nightly) — distill stronger semantic facts with ≥2 supporting
  episodics
- REM (Sundays) — find new refines/contradicts/supersedes/supports
  edges between weakly-linked memories

---

## 7. The eval gate

`evals/cases/*.json` defines test cases. Seed them into D1:

```bash
npm run db:seed:evals:remote
```

The nightly 4am cron runs every case through the same path the live
surface uses (memory recall → router), asks the deep tier to grade
each reply against the case's expected-points checklist, and writes a
row to `eval_runs`.

The gate compares the run against a rolling baseline of the previous
10 successful runs. It fails if:
- Overall `pass_rate` dropped > 5pp, or
- Any tag's `pass_rate` dropped > 10pp with ≥ 5 prior samples on that
  tag.

Gate decision is logged at `eval_gate`. CI also runs the gate on PRs
against the production `eval_runs` history — see `.github/workflows/ci.yml`
and `scripts/eval-gate.ts`.

---

## 8. When things look wrong

- **A reply was wrong** → click `memory_correct` on the offending card
  if it surfaces from memory, or just publish a charter version that
  states the corrected fact. Charter wins over inferred memory.
- **A task was created spuriously** → click `task_complete` or
  `task_reassign`. The `feedback` table accumulates negative signals
  that the detector can be tuned against later.
- **A nudge was tone-deaf** → click `nudge_snooze` (rate-limits) or
  publish a charter clause naming the cadence you actually want.
- **A routine ran when it shouldn't** → disable from the UI
  (`PATCH /api/webapp/routines/:id` with `{"enabled": false}`).
- **Eval gate trips** → look at `summary_json` in the failing
  `eval_runs` row. Per-case rationale tells you which checklist points
  Arcadia missed.

When in doubt, follow the audit trail:

```sql
-- All ownership transitions on a task
SELECT * FROM ownership_history WHERE task_id = '<uuid>' ORDER BY occurred_at;

-- Latest feedback on a surface
SELECT * FROM feedback WHERE surface = 'task_card' ORDER BY created_at DESC LIMIT 50;

-- Decisions captured by Arcadia in the last week
SELECT decided_at, text FROM decisions WHERE decided_at >= datetime('now', '-7 days') ORDER BY decided_at DESC;
```
