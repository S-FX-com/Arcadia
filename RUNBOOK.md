# Arcadia Operations Runbook

Operational guide for deploying, migrating, and troubleshooting the Arcadia
worker.

## Prerequisites

- Node 20+ and npm
- Cloudflare account with: Workers Paid, D1, KV, Workers AI, AI Gateway
- Microsoft Entra ID app registrations:
  - **Bot app** (Bot Framework + app-only Graph): `TEAMS_APP_ID`,
    `TEAMS_APP_PASSWORD`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
    `GRAPH_CLIENT_SECRET`.
  - **Webapp app** (delegated SSO): `WEBAPP_CLIENT_ID`,
    `WEBAPP_CLIENT_SECRET`, `WEBAPP_SESSION_SECRET` (32 random bytes,
    base64).
- `wrangler login` once per dev environment.

## Bindings provisioning

```bash
# Create per-environment D1 + KV (one-time)
npx wrangler d1 create arcadia-db
npx wrangler kv namespace create ARCADIA_CACHE
# Optional, gated by VECTORIZE_ENABLED:
npx wrangler vectorize create arcadia-memory-vectors --dimensions=768 --metric=cosine
# Optional, AI Gateway for caching/observability:
# Create the gateway in the dashboard, then set AI_GATEWAY_ID secret.
```

Update `wrangler.toml` with the printed `database_id` / KV `id`. For
multi-environment deploys, use `[env.dev]` / `[env.prod]` overlay blocks
that override `[[d1_databases]]` and `[[kv_namespaces]]`.

## Secrets

```bash
# Run once per environment (omit --env=prod for default)
for k in TEAMS_APP_ID TEAMS_APP_PASSWORD GRAPH_TENANT_ID GRAPH_CLIENT_ID \
         GRAPH_CLIENT_SECRET GRAPH_NOTIFICATION_SECRET ADMIN_USER_AAD_ID \
         WEBAPP_CLIENT_ID WEBAPP_CLIENT_SECRET WEBAPP_SESSION_SECRET; do
  npx wrangler secret put "$k"  # paste value when prompted
done
```

Optional secrets: `AI_GATEWAY_ID` (route Workers AI calls through a CF AI
Gateway for caching, rate limits, and request logs).

## Phase 1 — Per-user ACL index (Phase 13 schema)

After running `npm run db:migrate`, the `resource_acl` and
`group_membership` tables exist and `memories` / `client_memories` carry
nullable `source_resource_type` + `source_resource_id` columns.

To start enforcing per-user ACLs on recall:

1. Set `ACL_ENFORCEMENT` in `wrangler.toml` (or via `wrangler secret put
   ACL_ENFORCEMENT`):
   - `off` (default) — preserves legacy behavior. Use during initial deploy.
   - `permissive` — rows without a `source_resource_id` remain visible to
     everyone; rows tagged with a source resource require an ACL match.
     Use this once new writes start populating ACLs.
   - `strict` — every recalled memory must have an ACL entry naming a
     principal in the caller's effective set. Use only after backfilling
     ACL rows for every existing memory.
2. (Optional) Create the Vectorize index and uncomment the `[[vectorize]]`
   block in `wrangler.toml`:
   ```bash
   npx wrangler vectorize create arcadia-memory-vectors \
     --dimensions=768 --metric=cosine
   ```
3. Schedule the group-membership refresh. The 6-hour cron is already in
   `[triggers].crons` (`0 */6 * * *`); the worker dispatches based on its
   payload, so no extra wrangler step is required once the new code is
   deployed.

## Database migrations

The legacy `db:migrate:phaseN` scripts still exist for compatibility, but the
canonical command is now:

```bash
npm run db:migrate           # local D1 (default during wrangler dev)
npm run db:migrate:remote    # remote D1 (production)
```

`scripts/migrate.ts` is idempotent: it tracks applied filenames + sha256 in
a `_migrations` table. Re-running is safe; modifying a previously-applied
file is rejected (add a new `d1-phaseN-corrective.sql` instead).

**Bootstrap (existing deployments):** if you previously applied phase
migrations manually via the legacy `db:migrate:phaseN` scripts, run the
bootstrap pass first so the runner records them as applied without
re-executing any ALTERs:

```bash
npm run db:migrate -- --bootstrap         # local
npm run db:migrate:remote -- --bootstrap  # remote
```

Subsequent `npm run db:migrate` invocations will only apply NEW files.

## Local development

```bash
npm install
npm run db:migrate
npm run dev
```

The bot webhook is at `http://127.0.0.1:8787/api/messages`; webapp at
`http://127.0.0.1:8787/app`.

## Deploy

```bash
npm run ci                   # type-check + tests
npx wrangler deploy --dry-run --outdir=dist   # validate bundle
npx wrangler deploy
```

CI does the same in `.github/workflows/ci.yml` and only deploys on `main`.

## Observability

- Live tail: `npx wrangler tail --format=pretty`
- Structured logs: every line is JSON; pipe through `jq` or aggregate via
  Logpush → R2.
- AI Gateway: dashboard shows model latency, cache hit rate, error rate per
  request when `AI_GATEWAY_ID` is set.

## Common troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `CF Workers AI returned empty response` | Model overloaded / bad prompt | Inspect AI Gateway log for the request; retry; consider fallback model in `model-registry.ts` |
| Graph subscription expired | 55-min lifetime not renewed | Check the `0 */6 * * *` cron logs; verify `GRAPH_NOTIFICATION_SECRET` matches |
| Webapp returns 401 after login | `WEBAPP_SESSION_SECRET` rotated mid-flight | Re-login; sessions are 24h |
| Memory recall returns nothing | `MEMORY_ENABLED=false` or D1 schema not migrated | Run `npm run db:migrate:remote` |
