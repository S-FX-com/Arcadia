# D1 migrations

Every change to the `arcadia-ops` D1 schema is a numbered SQL file in this
folder. `wrangler.jsonc` points wrangler here (`migrations_dir`).

## The rule

**Destructive migrations (DROP, table rebuilds) are applied by Shane after running `scripts/export-d1.sh`.**

An agent or contributor writes the migration, explains what it removes, and
stops. Shane takes the export, then applies it.

Mark a destructive migration in two places:

1. The file header. Start the file with a comment like:
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
any migration is pending. Additive schema must be ahead of the code that
queries it, so apply first, then deploy.

## Drops and the deploy order

The gate above forces apply-then-deploy. That is right for additive changes
(new tables, new columns). It is wrong for a DROP of a table the live Worker
still reads. Between the apply and the end of the deploy, every route that
reads the dropped table fails. The CI deploy job also waits for the full test
run first, which makes the gap longer.

Two ways to handle it:

1. **Accept a short gap.** Apply, then dispatch the deploy straight away. Use
   this when the affected routes are rarely used. Brief Phase 1
   (`0002_v5_cleanup.sql`) drops tables only v5 pages read, so the gap is
   small.
2. **Expand, then contract.** Ship the code that stops using the table first,
   with only additive migrations. Put the DROP in a later migration, in a
   later PR, applied once that code is live. Use this when the gap would
   break sign-in or a page staff use all day. Dropping `users` is one: v5
   sign-in reads it on every request. Splitting a migration the brief names
   is Shane's call.

Say in the PR description which of the two the PR uses.

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
