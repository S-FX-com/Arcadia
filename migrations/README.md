# D1 migrations

Every change to the `arcadia-ops` D1 schema is a numbered SQL file in this
folder. `wrangler.jsonc` points wrangler here (`migrations_dir`).

## The rule

**Destructive migrations (DROP, table rebuilds) are applied by Shane after running `scripts/export-d1.sh`.**

An agent or contributor writes the migration, explains what it removes, and
stops. Shane takes the export, then applies it.

Mark a destructive migration in two places:

1. The file header. Right under wrangler's `-- Migration number:` line, add a
   comment like:
   ```sql
   -- DESTRUCTIVE: drops table project_signals. Apply only after scripts/export-d1.sh.
   ```
2. The PR description. List every destructive migration in the PR and say
   what data it removes.

## Naming

`NNNN_slug.sql`: four digits, sequential, then a short lowercase slug with
underscores. Example: `0099_example_slug.sql`. Never reuse or skip a number.
The brief names each phase's migration file (`0002_v5_cleanup.sql` in Phase 1,
`0003_staff.sql` in Phase 2, and so on). Use the name the brief gives.

Create a new file with:

```sh
npx wrangler d1 migrations create arcadia-ops <slug>
```

Wrangler picks the next number, pads it to four digits, and writes an empty
file with a `-- Migration number:` header. Spaces in the slug become
underscores.

## Applying

| Where | Command |
|---|---|
| Local DB (`wrangler dev`) | `npm run db:migrate:local` |
| Remote DB (production) | GitHub **Actions → Apply D1 migrations → Run workflow** (type `apply`), or from a terminal `npm run db:export && npm run db:migrate:remote` |

- The **Apply D1 migrations** workflow (`.github/workflows/d1-migrate.yml`) runs
  `scripts/export-d1.sh`, attaches the backup to the run, and applies pending
  migrations only if the export succeeded. It runs only when Shane starts it.
- `db:export` runs `scripts/export-d1.sh`. It exports the remote database to
  `backups/arcadia-ops-<UTC timestamp>.sql` (gitignored) and uploads the same
  file to the `arcadia-artifacts` R2 bucket under `backups/`.
- Wrangler records each applied file in the `d1_migrations` table in the
  database. It applies only files that are not in that table, in number order.
- See what is pending without applying anything:
  `npx wrangler d1 migrations list arcadia-ops --local` (or `--remote`).
- Wrangler asks for confirmation before it applies. In a non-interactive shell
  or CI it skips the prompt and answers yes.
- If a migration fails, wrangler rolls that file back and stops. Earlier files
  stay applied.

The CI deploy job does not apply migrations. It runs
`scripts/check-pending-migrations.sh`, which runs
`wrangler d1 migrations list arcadia-ops --remote` and refuses to deploy while
any migration is pending. That is the right order for additive schema: new
tables and columns must exist before the code that queries them, so apply
first, then deploy.

## Drops and the deploy order

A DROP runs the other way. Code that no longer reads a table can ship before
the table is gone, but a dropped table breaks every live route that still
reads it. So a drop goes **code first, then the migration**:

1. Merge the PR whose code no longer reads the table. Its migration file is
   in `migrations/` but not yet applied remotely.
2. Let the deploy of `main` finish and check the live Worker.
3. Run GitHub **Actions → Apply D1 migrations** (or, from a terminal,
   `npm run db:export && npm run db:migrate:remote`).

The manual CI deploy job cannot do step 2. Its pending-migration check sees
the unapplied drop and stops the deploy, by design. The code-first path for a
drop-only migration is the Workers Builds deploy of `main` on merge, or
`npm run deploy` from a clean checkout of `main` if Workers Builds runs the
same check in its deploy command. Use the CI deploy job when no drop is
pending.

Keep drops and additive changes in separate migrations. A file that both adds
a table the new code needs and drops one the old code reads has no safe
order. Put the additive part in its own migration, applied first, and the
drop in a later one.

If the new code still reads a table, it cannot be dropped in the same PR.
Ship the code that stops reading it first, and put the DROP in a later
migration and PR (expand, then contract). Dropping `users` is one: sign-in
reads it on every request until Phase 2 replaces it. Splitting a migration
the brief names is Shane's call.

Say in the PR description which order the PR uses.

**Phase 1 (`0002_v5_cleanup.sql`) is code first.** The Phase 1 code reads
none of the tables 0002 drops. The live v5 Worker reads several of them on
pages staff use (Directory sync, Schedule, `/clients`), so applying 0002
before the deploy would break those pages until the deploy lands. Apply it
after the deploy, then run the teardown in `docs/teardown-v5.md`.

## Never edit an applied migration

Once a file has been applied anywhere (your local DB, a teammate's, or
remote), do not change it. Wrangler tracks files by name, so an edited file
is never re-run and the databases drift apart. Fix mistakes with a new
migration.

## 0001_baseline.sql

`0001_baseline.sql` is the v5 `src/schema/d1.sql`, byte for byte. Every
statement in it is `CREATE ... IF NOT EXISTS` or `INSERT OR IGNORE`, so
applying it to the existing remote database changes nothing except adding its
row to `d1_migrations`.

Its header comment still says `Apply with: wrangler d1 execute ...`. That line
is out of date. The file is kept verbatim on purpose; ignore that line.
