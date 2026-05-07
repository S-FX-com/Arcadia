# Arcadia — Operating Guide (Phases 0 – 6)

This is the single page that tells you, **in order**, every command you
need to run to take a fresh checkout from "git clone" to a fully
deployed, ACL-enforcing, agent-tool-using, routine-executing tenant
intelligence system.

For the architectural rationale of each step, read
`/root/.claude/plans/run-through-this-codebase-structured-thacker.md`.
For day-to-day ops, read `RUNBOOK.md`.

---

## 0. One-time prerequisites

```bash
# Local toolchain
node -v          # ≥ 20
npm install
npx wrangler login

# Cloudflare account: enable Workers Paid, D1, KV, Workers AI,
#   AI Gateway, Vectorize, Queues, Workers Logpush, Pages.

# Microsoft Entra ID: create TWO app registrations and record the
# IDs/secrets:
#   * Bot/app-only: Channel.ReadBasic.All, ChannelMember.Read.All,
#     Chat.Read.All, ChatMember.Read.All, Group.Read.All,
#     User.Read.All, Sites.Read.All, Files.Read.All, Mail.Read.All,
#     Calendars.Read.All, Tasks.Read.All, Notes.Read.All
#   * Webapp/delegated: User.Read, Chat.Read, ChannelMessage.Read.All,
#     Sites.Read.All, Tasks.Read, Group.Read.All, Team.ReadBasic.All,
#     Schedule.Read.All, TeamsActivity.Read, Presence.Read,
#     Calendars.Read, TeamMember.Read.All, Files.Read, People.Read
```

---

## 1. Provision Cloudflare bindings

```bash
# Run once per environment (dev, prod). Record the printed IDs.
npx wrangler d1 create arcadia-db
npx wrangler kv namespace create ARCADIA_CACHE
npx wrangler vectorize create arcadia-memory-vectors --dimensions=768 --metric=cosine
npx wrangler queues create arcadia-ingest

# AI Gateway: create in dashboard → record the slug as AI_GATEWAY_ID.
```

Then in `wrangler.toml`:

```bash
# 1) Update [[d1_databases]] database_id and [[kv_namespaces]] id with
#    the values printed above (or move them under [env.dev]/[env.prod]
#    overlay blocks per the inline comments).
# 2) Uncomment the [[vectorize]] block.
# 3) Uncomment the [[queues.producers]] + [[queues.consumers]] blocks
#    (Phase 3).
```

---

## 2. Set Worker secrets

```bash
# Bot / app-only Graph
npx wrangler secret put TEAMS_APP_ID
npx wrangler secret put TEAMS_APP_PASSWORD
npx wrangler secret put GRAPH_TENANT_ID
npx wrangler secret put GRAPH_CLIENT_ID
npx wrangler secret put GRAPH_CLIENT_SECRET
npx wrangler secret put GRAPH_NOTIFICATION_SECRET

# Bootstrap admin (AAD object id of the Arcadia owner)
npx wrangler secret put ADMIN_USER_AAD_ID

# Webapp / delegated SSO
npx wrangler secret put WEBAPP_CLIENT_ID
npx wrangler secret put WEBAPP_CLIENT_SECRET
# 32 random bytes, base64-encoded:
openssl rand -base64 32 | npx wrangler secret put WEBAPP_SESSION_SECRET

# Optional but recommended (Phase 0)
npx wrangler secret put AI_GATEWAY_ID
```

---

## 3. Apply database migrations

**First-time fresh DB**:

```bash
npm run db:migrate                       # local
npm run db:migrate:remote                # production
```

**Existing deployment that previously used `db:migrate:phaseN`
scripts**:

```bash
npm run db:migrate -- --bootstrap        # local: mark old phases applied
npm run db:migrate:remote -- --bootstrap # remote: same
# Then real migrations:
npm run db:migrate
npm run db:migrate:remote
```

The runner is idempotent — re-running is safe.

---

## 4. Build, test, deploy

```bash
npm run ci             # type-check + vitest (runs in CI on every PR)
npx wrangler deploy --dry-run --outdir=.wrangler-out   # validate bundle
npx wrangler deploy    # ship it
```

CI (`.github/workflows/ci.yml`) does steps 1–3 on every PR and
auto-deploys on merge to `main` when `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repo secrets are set.

---

## 5. Phase rollouts (flip flags after each step is verified)

All flags live in `wrangler.toml [vars]`. After each change, redeploy.

```toml
# Phase 1 — per-user ACL
ACL_ENFORCEMENT = "off"          # default; preserves legacy behaviour
# After new ingest is populating source_resource_id columns, flip to:
ACL_ENFORCEMENT = "permissive"   # filters tagged rows, untagged stay visible
# After backfill (see step 6), flip to:
ACL_ENFORCEMENT = "strict"       # every recall MUST have an ACL match

# Phase 2 — agent tool loop on Workers AI
AGENT_LOOP_ENABLED = "false"     # default; legacy single-prompt pipeline
# After verifying the loop in dev:
AGENT_LOOP_ENABLED = "true"      # webapp chat routes through src/agent/loop.ts
```

---

## 6. Backfill ACL on legacy memories (before going `strict`)

```bash
# Dry-run first (no writes)
npm run db:backfill-acl -- --dry-run
npm run db:backfill-acl:remote -- --dry-run

# Then commit
npm run db:backfill-acl
npm run db:backfill-acl:remote
```

This tags rows whose `source_channel_id` is set with
`source_resource_type = 'teams_channel'`. Memories without channel
context remain untagged — under `strict`, those rows become invisible
and will need a manual rewrite (or a permanent shift to `permissive`).

`resource_acl` rows for those channels must also exist before `strict`
is safe. The Phase 1 client-indexer now writes them automatically; the
`refreshAllGroupMemberships` cron (already wired in the 6h slot)
keeps `group_membership` fresh for group-grant resolution.

---

## 7. Phase 3 ingest pipeline (one-time wiring per env)

Once the queue exists (step 1) and `wrangler.toml` blocks are
uncommented:

```bash
# Wire the queue consumer in src/index.ts (one-time edit):
#   export default {
#     fetch: handleRequest,
#     scheduled: ...,
#     queue: (batch, env) => import("./ingest/queue-consumer.js").then(m => m.handleIngestBatch(batch, env)),
#   } satisfies ExportedHandler<Env>;
#
# Add producers (cron walks delta_state per user, enqueues changes).
# Producers ship in a follow-up commit; until then the consumer is
# dormant — bind+migration land cleanly without runtime impact.

npx wrangler deploy
```

---

## 8. Routines (Phase 4)

Routines work as soon as Phase 15 schema is migrated and the
`/api/webapp/routines` route is wired into `src/webapp/api.ts`.

To create one from the CLI:

```bash
curl -sX POST https://arcadia.<acct>.workers.dev/api/webapp/routines \
  -H "Cookie: arcadia_session=..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Weekday GNC summary",
    "trigger": { "kind": "cron", "expr": "0 13 * * 1-5" },
    "steps": [
      { "tool": "search_teams_messages", "args": { "query": "GNC" } },
      { "tool": "search_documents",       "args": { "query": "GNC project status" } }
    ]
  }'
```

Trigger immediately:

```bash
curl -sX POST https://arcadia.<acct>.workers.dev/api/webapp/routines/<id>/run \
  -H "Cookie: arcadia_session=..."
```

The visual builder UI lives in `web/` (Phase 5) — see
`web/README.md` for the SvelteKit setup commands.

---

## 9. Frontend (`web/`, Phase 5)

```bash
cd web
npm create svelte@latest .          # SvelteKit + TS + ESLint + Vitest + Playwright
npm install -D @sveltejs/adapter-cloudflare tailwindcss @xyflow/svelte @azure/msal-browser
npm run dev                          # http://localhost:5173
# Cloudflare dashboard → Pages: connect this directory.
# Add Service Binding ARCADIA → arcadia worker.
# Add env var PUBLIC_AAD_CLIENT_ID = <webapp client id>.
```

Surfaces to build (in order): `/chat` → `/routines` (visual builder) →
`/sources` → `/memory` → `/settings`.

---

## 10. Eval harness (Phase 6)

Drop new cases under `evals/cases/*.json`. The judge prompt is
`evals/judge-prompt.md`. `src/eval/runner.ts` is invoked by a cron
slot — add this to `wrangler.toml [triggers].crons` (and dispatch
in `src/index.ts:handleScheduled`):

```toml
crons = [..., "0 4 * * *"]
```

Manually trigger a pass:

```bash
curl -sX POST https://arcadia.<acct>.workers.dev/internal/cron?type=evals \
  -H "X-Arcadia-Admin: $ADMIN_SECRET"
```

`EVAL_PASS_THRESHOLD` (default `0.7`) controls the per-case pass bar.
Add a CI step that diffs the latest two `eval_runs` rows and blocks
merge on >5% pass-rate regression.

---

## 11. Day-to-day commands cheat sheet

```bash
# Local dev
npm run dev                           # wrangler dev

# Tests / type-check
npm run type-check
npm run test
npm run ci                            # both, in order

# Migrations
npm run db:migrate                    # local
npm run db:migrate:remote             # remote
npm run db:migrate -- --bootstrap     # mark all current files applied
npm run db:backfill-acl[:remote]      # tag legacy memories

# Tail logs
npx wrangler tail --format=pretty

# Manual cron trigger (for testing)
curl -X POST https://arcadia.<acct>.workers.dev/internal/cron?type=daily \
  -H "X-Arcadia-Admin: $ADMIN_SECRET"
```

---

## Outstanding work (not implemented in this branch)

| Item | Where it would live |
|---|---|
| Producers for the ingest queue (delta-cursor cron) | `src/ingest/producers/{mail,drive,sharepoint,calendar,planner,onenote}.ts` |
| Wire `queue:` handler in `src/index.ts` worker export | `src/index.ts` |
| Wire `handleRoutinesApi` into `src/webapp/api.ts` route table | `src/webapp/api.ts` |
| Add `0 4 * * *` cron + `evals` case in `handleScheduled` | `wrangler.toml`, `src/index.ts` |
| Side-effecting "action" tools (`sendMail`, `postToChannel`, …) for routines | `src/agent/tools/actions/*` |
| Streaming SSE for webapp chat (replace JSON response) | `src/webapp/chat.ts`, `src/agent/loop.ts` |
| Full SvelteKit frontend | `web/` (see `web/README.md`) |
| Per-resource MIP sensitivity-label honoring at recall time | `src/memory/long-term.ts`, `src/agent/tools/*` |
| PDF/Office parsers (Browser Rendering or Graph PDF conversion) | `src/ingest/parsers/{pdf,office}.ts` |
| Pre-merge eval-regression CI gate | `.github/workflows/ci.yml` |

These are deliberate cut-offs — the foundations they sit on are
deployed, tested, and feature-flag-gated so they can be added
incrementally without re-architecting.
