# Arcadia — the S-FX staff hub

Arcadia is where S-FX staff look up the agency: who works here, how the agency is organized into departments, which clients are active, what services each client has, and who the point of contact is for each one. Shane and the Manager role maintain that data in Settings.

Ask Arcadia, an assistant that answers questions from those records with links back to them, lands in Phase 6.

The spec is [CLAUDE.md](./CLAUDE.md). The plan is the [v6 build brief](./docs/briefs/2026-11-09-arcadia-v6.md). The reasons are in [docs/decisions/](./docs/decisions/).

## Current state

v6 is at **Phase 1**: the v5 code is deleted. What runs today:

- **Directory** (`/agency/directory`), **Schedule** (`/agency/schedule`), and **Continuing Education** (`/agency/education`), open to every signed-in staff member. `/` redirects to the Directory.
- **Admin** (`/approval/admin`): model routing and roles, until Settings replaces it in Phase 2.
- **`/clients`**: client workspace bindings, for `manage_clients` holders only, until the CRM replaces it in Phase 4.

Every other v5 route returns 404. The orphaned v5 cloud resources and the commands that remove them are in [docs/teardown-v5.md](./docs/teardown-v5.md). The [Build state table in CLAUDE.md](./CLAUDE.md) records which phase is done.

The last v5 commit is tagged `v5-final`. Git history is the archive.

## Stack

- **Runtime:** Cloudflare only. Workers, D1, R2, Durable Objects (SQLite-backed), Queues, Vectorize, Workers AI, and the `agents` SDK (pinned).
- **Models:** routed per task in `src/ai/`, through AI Gateway. Anthropic is called only through AI Gateway, never directly.
- **Sign-in:** Microsoft Entra ID OIDC, run in the Worker (`src/lib/sso.ts`). Cloudflare Access is not used.
- **UI:** server-rendered Preact with `src/approval/theme.ts`. Small scripts served by the Worker only where a form needs them.

## Setup

Requires Node 22 or later (Wrangler 4.118+ refuses to start on older Node). Run Wrangler as `npx wrangler` so you get the version in `package-lock.json`.

```sh
npm ci
npm run setup              # creates the Cloudflare resources (scripts/setup.sh)
```

`npm run setup` prints the resource ids to paste into `wrangler.jsonc`. It does not do the human-only steps: the AI Gateway, the Entra app registration, Graph consent, and secrets. Those are listed in the human steps section of [CLAUDE.md](./CLAUDE.md). Do not automate them.

The Worker needs these secrets, set with `npx wrangler secret put <NAME>`:

| Secret | Required | Purpose |
|---|---|---|
| `GRAPH_CLIENT_SECRET` | Yes | Entra app secret. Sign-in and Graph share one registration |
| `SSO_SESSION_SECRET` | Yes | Signs the session cookie. `openssl rand -base64 32`. Rotating it signs everyone out |
| `ANTHROPIC_API_KEY` | No | Only when a task is routed to Claude |
| `AI_GATEWAY_TOKEN` | No | Only for an authenticated AI Gateway |

`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `CF_ACCOUNT_ID`, and `AI_GATEWAY_ID` are public identifiers. They live in `vars` in `wrangler.jsonc`.

## Local development

```sh
npm run db:migrate:local   # builds the local D1 database from migrations/
npm run dev                # wrangler dev on http://localhost:8787
```

Local secrets go in `.dev.vars` (gitignored). Two ways to sign in locally:

- **Real sign-in.** Put `GRAPH_CLIENT_SECRET` and `SSO_SESSION_SECRET` in `.dev.vars`. The Entra registration must list `http://localhost:8787/auth/callback` as a redirect URI.
- **Bypass.** Put `DEV_MODE=true` in `.dev.vars`. You are signed in as `dev@localhost` with the default role for an email that has no user record. The bypass works only when the request host is `localhost`, `127.0.0.1`, or `[::1]`. If `DEV_MODE` reaches deployed vars by mistake, it still cannot open the real Worker.

## Tests

```sh
npm test                   # unit tests (vitest)
npm run ci                 # type-check, unit tests, integration tests
```

CI (`.github/workflows/ci.yml`) runs type-check, tests, and `wrangler deploy --dry-run` on every pull request and push to `main`. A phase is not done until CI passes.

## D1 migrations

The schema lives in numbered files in [migrations/](./migrations/). `0001_baseline.sql` is the v5 schema verbatim. It uses only `CREATE ... IF NOT EXISTS` and `INSERT OR IGNORE`, so applying it to the existing remote database changes nothing.

Every schema change is a new numbered migration. Never edit an applied one.

**Destructive migrations (DROP, table rebuilds) are applied by Shane, after he runs `scripts/export-d1.sh`.** See [migrations/README.md](./migrations/README.md) for the full rule.

## Deploy

Additive schema (new tables and columns) goes out before the code that queries it:

1. **Apply migrations.** In GitHub, open **Actions → Apply D1 migrations → Run workflow** and type `apply`. The workflow exports the remote database (to R2 under `backups/`, and as a download attached to the run), then applies the pending migrations. If the export fails, nothing is applied. The token in the `CLOUDFLARE_API_TOKEN` secret needs D1 edit and R2 write access.
2. **Deploy.** Dispatch the CI workflow's deploy job, or let Workers Builds deploy (see below).

The same steps from a terminal, if you prefer:

```sh
npm run db:export          # wrangler d1 export to backups/, uploaded to R2 under backups/
npm run db:migrate:remote  # apply pending migrations to the remote D1
npm run deploy             # wrangler deploy
```

The CI deploy job runs only on manual `workflow_dispatch`. It does not apply migrations. It runs `scripts/check-pending-migrations.sh`, which fails the deploy if the remote database has any pending migration. Run **Apply D1 migrations** first, then dispatch the deploy.

A DROP goes the other way: **code first, then the migration.** Merge the code that no longer reads the table, let the deploy of `main` finish, then run **Apply D1 migrations**. The CI deploy job cannot ship that code, because the pending drop stops it; use the Workers Builds deploy on merge, or `npm run deploy`. Phase 1's `0002_v5_cleanup.sql` works this way. [migrations/README.md](./migrations/README.md) has the full rule, and [docs/teardown-v5.md](./docs/teardown-v5.md) has the Phase 1 order of operations.

`backups/` is gitignored. Exports never go into the repo.

**Workers Builds:** if Workers Builds is connected to this repo, it deploys on push to `main` with no pending-migration check. That makes it the code-first path for a drop, but it also ships code ahead of an unapplied additive migration. To guard that, set its deploy command to `bash scripts/check-pending-migrations.sh && npx wrangler deploy` (the build token then needs D1 access), and deploy a drop's code with `npm run deploy` instead. Do not use `npx wrangler versions upload`. Durable Object migrations cannot ship through the versions path. Cloudflare rejects the upload with error 10211. Phase 1 adds a `deleted_classes` migration, so this matters. Workers Builds' non-production (branch or preview) builds run `npx wrangler versions upload` by default, so if they are enabled, a failed Workers Builds check on the Phase 1 PR is this rejection, not a code defect; ignore it or disable those builds for that PR. That migration permanently deletes the Radar, Ledger, and Dispatcher Durable Object storage; `scripts/export-d1.sh` backs up D1 only.

## How the work is organized

Each phase is one branch, named `sfx/v6-phase-N-<slug>`, and one PR. A phase starts only after the previous PR is merged. Every phase has a **Done when** list in the brief. At the end of each phase, update the Build state table in `CLAUDE.md`.

Phase order:

```
0 → 1 → 2 → 3 → 4 → 5 → 6 → 8 → 9 → 10
                 └──── 7 (Schedule) any time after 2
```

## Docs map

| Path | What it is |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | The v6 spec: rules, stack, roles, layout, build state, human steps |
| [docs/briefs/](./docs/briefs/) | Build briefs. The current one is `2026-11-09-arcadia-v6.md` |
| [docs/decisions/](./docs/decisions/) | Decision records. The current one is `2026-11-09-v6-staff-hub.md` |
| [migrations/README.md](./migrations/README.md) | The D1 migration rules and deploy order |
| [docs/teardown-v5.md](./docs/teardown-v5.md) | Orphaned v5 cloud resources and the commands that remove them |
