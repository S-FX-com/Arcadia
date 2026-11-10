# v5 teardown

Phase 1 removes the v5 code and its bindings. It does not delete cloud
resources. This file lists every resource the v5 code left behind and the
exact command that removes it. Shane runs these by hand.

Every command was checked against `npx wrangler <command> --help` for
wrangler 4.119.0, the version in `package-lock.json`. Run them from the repo
root, so `--binding CONTROL` and `secret` resolve against `wrangler.jsonc`.

## Order of operations

1. **Merge** the Phase 1 PR.
2. **Deploy `main`.** If Workers Builds is connected to this repo and its
   deploy command does not run `scripts/check-pending-migrations.sh`, it
   deploys `main` on merge. Otherwise (Workers Builds is disconnected, or its
   deploy command runs the check and stops because `0002_v5_cleanup.sql` is
   pending), deploy from a clean checkout of `main` with
   `npm ci && npm run deploy`. Do not use the manual CI deploy job for this
   one: 0002 is still pending, so its pending-migration check stops the
   deploy by design.
   - This deploy carries the Durable Object migration
     `{ "tag": "v4", "deleted_classes": ["Radar", "Ledger", "Dispatcher"] }`.
     It **permanently destroys** the stored state of every Radar, Ledger and
     Dispatcher instance. `scripts/export-d1.sh` backs up D1 only; nothing
     backs up Durable Object storage. `wrangler deploy --dry-run` in CI only
     builds and checks the config. Cloudflare validates the migration at the
     real deploy.
3. **Check the live Worker.** Sign in as a staff user. Directory, Schedule and
   Continuing Education load. `/chat`, `/approval/ops` and `/agency/leadership`
   return 404.
4. **Apply D1 migrations.** Code first, then the drop
   (see [migrations/README.md](../migrations/README.md), "Drops and the deploy
   order"):
   In GitHub: **Actions → Apply D1 migrations → Run workflow**, type `apply`.
   It exports the database first and applies 0002 only if the export
   succeeded. Terminal fallback:
   ```sh
   # Optional, read-only: see which tables exist before the drop.
   npx wrangler d1 execute arcadia-ops --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   npm run db:export          # scripts/export-d1.sh: backups/ locally and in R2
   npm run db:migrate:remote  # applies 0002_v5_cleanup.sql
   ```
   0002 drops the 28 tables in brief §1.4 and the Hermes-era `topics` and
   `published_log` tables. It deletes the `instrument.*` and `hermes_*`
   config rows, `user_capabilities` grants of the removed capabilities, and
   `model_config` overrides of the removed task kinds (and the v5 founder
   `digest` override). The file header lists them all.
5. **Wait until it is stable.** Let at least one daily cycle run (the 06:00
   UTC wake-up cron, the 06:15 directory sync and the 06:30 shift-pattern
   post). Check that Directory, Schedule and sign-in still work.
6. **Run the teardown** in the next section, inventory first.

## Delete now

### 0. Read-only inventory

Run these first. Each one only lists, and the output tells you which of the
deletes below apply.

```sh
npx wrangler workflows list
npx wrangler vectorize list
npx wrangler queues list
npx wrangler kv key list --binding CONTROL --remote
npx wrangler secret list
npx wrangler r2 bucket lifecycle list arcadia-artifacts
```

### 1. Workflows

The v5 Worker no longer binds them after the deploy. Deleting a workflow also
deletes its instances, including any doctrine ratification still waiting for
approval. `hermes-publish` has been orphaned since the Hermes removal
(August 2026). Delete only the ones `workflows list` shows.

```sh
npx wrangler workflows delete doctrine-ratify
npx wrangler workflows delete site-plan
npx wrangler workflows delete doctrine-seed
npx wrangler workflows delete hermes-publish
```

### 2. Vectorize

`arcadia-published-log` lost its binding (`VEC_PUBLISHED_LOG`) in the Hermes
removal and nothing has read it since.

```sh
npx wrangler vectorize delete arcadia-published-log --force
```

The other three indexes stay. See "Phase 9 decides" below.

### 3. KV keys in `CONTROL`

Keep the namespace (`1240e8d7f8b04e86844b5a0e68320651`). v6 still uses
`config:model_routing` (`src/ai/router.ts`), `graph:app_token` and
`graph:username:*` (`src/integrations/graph.ts`). Delete everything else.

`graph:user:<aadId>` keys hold per-user delegated Graph tokens, refresh
tokens included, written by the deleted `src/integrations/graph-user.ts` with
no expiry. Delete them for security:

```sh
npx wrangler kv key list --binding CONTROL --remote --prefix graph:user: > graph-user-keys.json
# Check the file holds only a JSON array of { "name": "graph:user:..." } entries.
npx wrangler kv bulk delete graph-user-keys.json --binding CONTROL --remote
rm graph-user-keys.json
```

`control:kill_switch` is the Hermes-era publishing kill switch:

```sh
npx wrangler kv key delete control:kill_switch --binding CONTROL --remote
```

If the full `kv key list` shows any other key outside the three kept
patterns, delete it the same way with `kv key delete <key>`.

### 4. R2 prefixes in `arcadia-artifacts`

Keep the bucket. v6 uses it for `backups/` (`scripts/export-d1.sh`) and the
kept memory engine writes `memory-exports/`. These prefixes were written only
by deleted v5 code:

| Prefix | Written by (v5) |
|---|---|
| `doctrine-seed/runs/` | `src/memory/seed.ts` |
| `doctrine-seed/uploads/` | `src/memory/seed.ts` |
| `doctrine-seed/inbox/` | uploaded by hand for doctrine seeding |
| `site-plans/` | `src/workflows/siteplan.ts` |
| `certifications/mobile/` | `src/certification/verify.ts` |
| `hermes/drafts/` | the Hermes publish workflow (removed August 2026) |

Wrangler 4.119 cannot list objects or delete by prefix (`r2 object delete`
takes one `{bucket}/{key}`). Use one lifecycle rule per prefix. Objects
expire within about a day:

```sh
npx wrangler r2 bucket lifecycle add arcadia-artifacts v5-doctrine-seed doctrine-seed/ --expire-days 1 --force
npx wrangler r2 bucket lifecycle add arcadia-artifacts v5-site-plans site-plans/ --expire-days 1 --force
npx wrangler r2 bucket lifecycle add arcadia-artifacts v5-certifications certifications/mobile/ --expire-days 1 --force
npx wrangler r2 bucket lifecycle add arcadia-artifacts v5-hermes-drafts hermes/drafts/ --expire-days 1 --force
```

Never add a rule on `backups/` or `memory-exports/`, and never add one with
an empty prefix: it would expire the whole bucket. After the objects are gone,
remove the rules so they cannot catch anything later:

```sh
npx wrangler r2 bucket lifecycle remove arcadia-artifacts --name v5-doctrine-seed
npx wrangler r2 bucket lifecycle remove arcadia-artifacts --name v5-site-plans
npx wrangler r2 bucket lifecycle remove arcadia-artifacts --name v5-certifications
npx wrangler r2 bucket lifecycle remove arcadia-artifacts --name v5-hermes-drafts
```

The dashboard (R2 → arcadia-artifacts) can also delete a prefix's objects
directly.

### 5. Worker secrets

Delete each one `secret list` shows:

```sh
npx wrangler secret delete GITHUB_TOKEN      # Stall Radar git signal
npx wrangler secret delete EMAIL_API_KEY     # accountability notifications
npx wrangler secret delete EMAIL_API_URL     # same, if it was set as a secret
npx wrangler secret delete WP_APP_PASSWORD   # Hermes (WordPress)
npx wrangler secret delete SERPAPI_KEY       # Hermes (SEO research)
```

Keep `GRAPH_CLIENT_SECRET`, `SSO_SESSION_SECRET`, `ANTHROPIC_API_KEY` and
`AI_GATEWAY_TOKEN`. The removed vars (`FOUNDER_EMAIL`, `EMAIL_FROM`) need no
command: a deploy replaces all vars.

### 6. Outside wrangler

- **Cloudflare OS service binding.** v5 exported the `ArcadiaOsGatekeeper`
  entrypoint for a Cloudflare OS deployment to bind as a service. Phase 1
  removes it. If any other Worker has a service binding to `arcadia` with
  that entrypoint (dashboard: Workers & Pages → the Worker → Settings →
  Bindings), remove that binding there.
- **Browser Rendering.** The `browser` binding is gone from
  `wrangler.jsonc`. There is no resource to delete.
- **Entra app permissions.** Not part of this teardown. Phase 2 lists the
  final Graph permission set (CLAUDE.md §7) and removes the rest then. For
  reference: sign-in now requests only `openid profile email`, so the
  delegated scopes v5's Graph connect asked for (`Mail.Read`, `Chat.Read`,
  delegated `ChannelMessage.Read.All`, `Tasks.Read`, `Calendars.Read`,
  `offline_access`, `User.Read`) have no caller. The application
  permissions kept code still calls with are `User.Read.All` (roster,
  display names), `Schedule.ReadWrite.All` (shifts, time off, scheduling
  groups), `Group.Read.All` (Schedule team picker; the page falls back
  without it) and a channel read for the `/clients` bind-time check. That
  list comes from code comments and has not been checked on Microsoft
  Learn.

## Removed automatically

No command needed:

- **Durable Object classes Radar, Ledger, Dispatcher** and all their storage,
  by the `v4` `deleted_classes` migration at the deploy (step 2).
- **D1 tables and config rows**, by `0002_v5_cleanup.sql` (step 4).
- **Stale Arcadia DO schedules.** The Arcadia DO stays as the scheduler
  (daily directory sync and shift-pattern post). On start it cancels stored
  agents-SDK schedules whose callback no longer exists, such as the old
  plan-index and run-sheet jobs.

## Phase 9 decides — do not delete yet

Phase 9 adopts the hybrid retrieval engine (`src/memory/driver.ts`,
`self-hosted.ts`, `ingest.ts`) for client memory, or deletes it. These
resources serve that engine and stay bound until then:

| Resource | Notes |
|---|---|
| Durable Object class `MemoryProfile` | Its `sfx-doctrine-canonical` and `sfx-doctrine-staging` instances still hold the v5 doctrine corpus in DO storage. Wrangler cannot delete single instances. |
| Vectorize `arcadia-doctrine-canonical` | Doctrine vectors. Bound as `VEC_DOCTRINE_CANONICAL`. |
| Vectorize `arcadia-doctrine-staging` | Doctrine vectors. Bound as `VEC_DOCTRINE_STAGING`. |
| Vectorize `arcadia-episodic` | Bound as `VEC_EPISODIC`. |
| Queue `arcadia-vectorize` | Producer and consumer of the Vectorize upsert batches. |
| Queue `arcadia-vectorize-dlq` | Its dead-letter queue. |
| R2 `memory-exports/` | `MemoryProfile.exportToR2` writes here, including `memory-exports/sfx-doctrine-*`. |

If Phase 9 deletes the engine, that phase's PR removes the bindings, removes
the `MemoryProfile` export, and adds a `deleted_classes: ["MemoryProfile"]`
migration (which destroys the doctrine instances). After that deploy:

```sh
npx wrangler queues delete arcadia-vectorize
npx wrangler queues delete arcadia-vectorize-dlq
npx wrangler vectorize delete arcadia-doctrine-canonical --force
npx wrangler vectorize delete arcadia-doctrine-staging --force
npx wrangler vectorize delete arcadia-episodic --force
```

Delete the main queue first, after the deploy has removed its consumer, then
the dead-letter queue. Expire `memory-exports/` with a lifecycle rule as in
step 4.

If Phase 9 adopts the engine, it purges the two `sfx-doctrine-*` instances
and the two doctrine indexes, since doctrine is not coming back
(CLAUDE.md §8).

Phase 1 left some of the engine unreachable. `MemoryProfile.promoteMemory`,
`replaceWithCurated`, `countMemories` and `purge` had callers only in the
deleted doctrine page and ratify workflow, and the canonical-profile
promotion-only write rule exists only for doctrine. If Phase 9 adopts the
engine, it removes those methods and that rule along with the doctrine
instances.
