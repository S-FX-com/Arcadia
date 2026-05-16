# Arcadia Operations Runbook

How to deploy, migrate, and troubleshoot the v2 worker. This document is
the operations contract. For architecture see `ARCHITECTURE.md`; for the
day-to-day operator-facing surface (charter, routines, eval gate, etc.)
see `OPERATING.md`.

---

## 1. Prerequisites

- **Node 20+** and **npm**.
- **Cloudflare account** with Workers Paid, D1, KV, Workers AI, Queues,
  and Vectorize enabled. AI Gateway is optional.
- **Microsoft Entra ID app registrations** — three of them:
  - **Bot app** (Bot Framework channel + app-only Microsoft Graph)
    - `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`
    - `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`
    - Permissions: `ChannelMessage.Read.All`, `Chat.Read.All`,
      `User.Read.All`, `Group.Read.All`, `Sites.Read.All`,
      `Calendars.Read.All`, `Mail.Read.All`, `Presence.Read.All`,
      `Tasks.ReadWrite.All`. Admin-consented.
  - **Webapp app** (delegated SSO + On-Behalf-Of)
    - `WEBAPP_CLIENT_ID`, `WEBAPP_CLIENT_SECRET`
    - `WEBAPP_SESSION_SECRET` — 32 random bytes, used as HMAC key.
      `openssl rand -base64 32`.
    - Permissions (delegated): `User.Read`, `People.Read`,
      `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`,
      `Chat.ReadWrite`, `ChannelMessage.Send`.
- `wrangler login` — once per developer machine.

v2 ships strict from day one — there are no phase flags. Every behaviour
is on; tunables live as plain `[vars]` in `wrangler.toml`.

---

## 2. Provision Cloudflare bindings (once per environment)

```bash
# D1
npx wrangler d1 create arcadia-db
# KV
npx wrangler kv namespace create ARCADIA_CACHE
# Vectorize — required, 768-dim cosine to match @cf/baai/bge-base-en-v1.5
npx wrangler vectorize create arcadia-memory-vectors \
  --dimensions=768 --metric=cosine
# Queue — required for the ingest pipeline
npx wrangler queues create arcadia-ingest
```

Copy the printed `database_id`, KV `id`, and queue name into
`wrangler.toml`. For multi-environment deploys use `[env.dev]` /
`[env.prod]` overlays — see the commented-out block at the bottom of
`wrangler.toml`.

Workers AI is bound automatically via `[ai] binding = "AI"`. AI Gateway
is optional; set the `AI_GATEWAY_ID` secret to route Anthropic + Workers
AI calls through your gateway for cache + observability.

---

## 3. Secrets

All values are set via `wrangler secret put`. Run once per environment.

| Secret | Purpose | Required |
| --- | --- | --- |
| `TEAMS_APP_ID` | Bot Framework app id | yes |
| `TEAMS_APP_PASSWORD` | Bot Framework app password | yes |
| `GRAPH_TENANT_ID` | Tenant id for app-only Graph | yes |
| `GRAPH_CLIENT_ID` | Bot app's Graph client id | yes |
| `GRAPH_CLIENT_SECRET` | Bot app's Graph client secret | yes |
| `GRAPH_NOTIFICATION_SECRET` | HMAC seed for subscription `clientState` | yes |
| `ADMIN_USER_AAD_ID` | AAD object id of the operator. Used for cross-user admin paths (charter writes, memory.forget). | yes |
| `WEBAPP_CLIENT_ID` | Delegated Entra app id (NAA + OBO) | yes |
| `WEBAPP_CLIENT_SECRET` | Delegated app secret | yes |
| `WEBAPP_SESSION_SECRET` | 32-byte HMAC key sealing session cookies | yes |
| `ANTHROPIC_API_KEY` | Claude access | yes |
| `AI_GATEWAY_ID` | Optional CF AI Gateway slug | no |
| `AGENT_365_AGENT_ID` | Optional Entra Agent id once Agent 365 registration is done | no |
| `WEEKLY_REPORT_CHANNEL_ID` | Optional. If set, the Monday roll-up posts to this channel id (must already be a registered `channels` row). | no |
| `COPILOT_CONNECTION_ID` | Optional. Microsoft Search external-connection id for the Copilot Connector sync job. | no |
| `PDF_EXTRACT_URL` | Optional. HTTP endpoint that accepts a PDF byte stream and returns plain text. Without it, PDFs are ingested as metadata only. | no |

```bash
for k in TEAMS_APP_ID TEAMS_APP_PASSWORD \
         GRAPH_TENANT_ID GRAPH_CLIENT_ID GRAPH_CLIENT_SECRET \
         GRAPH_NOTIFICATION_SECRET ADMIN_USER_AAD_ID \
         WEBAPP_CLIENT_ID WEBAPP_CLIENT_SECRET WEBAPP_SESSION_SECRET \
         ANTHROPIC_API_KEY; do
  npx wrangler secret put "$k"
done
```

---

## 4. Schema migrations

```bash
npm run db:migrate            # local
npm run db:migrate:remote     # production
```

`scripts/migrate.ts` walks `schema/NNNN_*.sql` in numeric order and
records every applied filename in `_schema_migrations`. Re-running is
safe — every CREATE uses `IF NOT EXISTS`. Already-applied files are
skipped by filename match.

Never edit a file that's been applied. Add a new numbered migration
instead. `0001_init.sql` is the v2 baseline; future drift goes in
`0002_*.sql` and onwards.

---

## 5. Seed (optional but recommended)

```bash
# Load evals/cases/*.json into the eval_cases table so the nightly
# regression gate has something to grade against.
npm run db:seed:evals             # local
npm run db:seed:evals:remote      # production

# Publish the initial operator charter — direct SQL, since the
# webapp's POST /api/webapp/charter is gated to ADMIN_USER_AAD_ID and
# we want the first version before anyone logs in.
npx wrangler d1 execute arcadia-db --remote --command \
  "INSERT INTO charter (id, version, body, active, replaces_id, created_at)
   VALUES (lower(hex(randomblob(16))), 1,
   'Replace this with your operator charter. See OPERATING.md §4.',
   1, NULL, datetime('now'))"
```

---

## 6. Local development

```bash
npm install
npm run db:migrate
npm run dev
```

Routes:
- `http://127.0.0.1:8787/api/healthz`
- `http://127.0.0.1:8787/api/messages` — Bot Framework webhook
- `http://127.0.0.1:8787/api/webapp/*` — webapp HTTP API
- `http://127.0.0.1:8787/api/mcp` — MCP JSON-RPC
- `http://127.0.0.1:8787/api/openapi.json` — spec
- `http://127.0.0.1:8787/api/agent365/manifest` — governance manifest

To test cron locally:
```bash
npm run test:scheduled                # wrangler dev --test-scheduled
# In another shell:
curl "http://127.0.0.1:8787/__scheduled?cron=0+8+*+*+*"
```

The SvelteKit frontend lives in `web/`:
```bash
cd web && npm install && npm run dev
```
`vite.config.ts` proxies `/api/*` to `http://127.0.0.1:8787` so the
frontend can hit the local worker without CORS.

---

## 7. Deploy

```bash
npm run ci                                       # type-check + tests
npx wrangler deploy --dry-run --outdir=.wrangler-out
npx wrangler deploy
```

CI does the same on every PR and deploys on push to `main` — see
`.github/workflows/ci.yml`.

---

## 8. Cron schedule (in `wrangler.toml`)

| Cron | Step (in order) |
| --- | --- |
| `0 8 * * *` | Stale detection → decisions extraction → digest cycle → nudge cycle → subscription renewal → connector sync → matching user routines |
| `0 8 * * 1` | Weekly Monday roll-up (writes to `briefs`, posts to `WEEKLY_REPORT_CHANNEL_ID` if set) → matching routines |
| `0 12 * * 1-5` | Morning briefs (per user; DM-delivered if a 1:1 conversation can be created) → matching routines |
| `0 21 * * 1-5` | Evening wrap-ups → matching routines |
| `0 */6 * * *` | Group-membership cache refresh (every group_id referenced in `resource_acl`) |
| `0 4 * * *` | Memory consolidation (deep) → REM on Sundays only → eval suite + gate → matching routines |
| `*/15 * * * *` | Ingest producers (channels + chats + drive + sharepoint) → pre-meeting briefs → post-meeting wrap-ups → memory consolidation (light) → matching routines |

Every step is wrapped in a `safe()` try/catch; one failing step never
aborts the rest of the tick.

---

## 9. Bot Framework wiring

1. Set the bot's messaging endpoint to `https://<your-worker>/api/messages`.
2. Install the Teams app (`manifest/`) in the tenant.
3. Add the bot to a channel — the `conversationUpdate` activity will
   register the channel in the `channels` table automatically (you can
   verify with
   `wrangler d1 execute arcadia-db --remote --command "SELECT * FROM channels"`).

---

## 10. Graph subscriptions

The 8am cron renews any subscription that expires within 24 hours.
Microsoft Graph caps subscription lifetimes per resource — see
`MAX_EXPIRATION_DAYS` in `src/graph/subscriptions.ts`. Webhook
deliveries land at `/api/graph/notify`; validation handshakes return the
`validationToken` as text/plain. ClientState is an HMAC of the resource
path keyed by `GRAPH_NOTIFICATION_SECRET`.

To register a new subscription manually (e.g. from a one-shot script):

```typescript
import { createSubscription } from "./src/graph/subscriptions";
await createSubscription(env, {
  resource: "/teams/<teamId>/channels/<channelId>/messages",
  changeType: "created,updated",
  notificationUrl: "https://<worker>/api/graph/notify",
  lifecycleNotificationUrl: "https://<worker>/api/graph/notify",
});
```

---

## 11. Observability

- **Live tail:** `npx wrangler tail --format=pretty`
- **Structured logs:** every line is a JSON object with at minimum
  `ts`, `level`, `event`, and (when available) `requestId`. Pipe
  through `jq` or aggregate via Logpush → R2 / S3.
- **AI Gateway:** if `AI_GATEWAY_ID` is set, model latency, cache hit
  rate, and per-request bodies show up in the Gateway dashboard.

Useful events to grep for:
- `digest_cycle`, `nudge_cycle`, `stale_detection`, `weekly_cycle`,
  `briefs_cycle`, `decisions_extracted` — intelligence rollups
- `memory_consolidation` — light/deep/REM results
- `ingest_batch`, `ingest_produced_messages`,
  `ingest_produced_drives`, `ingest_produced_sharepoint` — pipeline
  throughput
- `subscription_renew`, `connector_sync` — outbound integrations
- `eval_finish`, `eval_gate` — nightly regression
- `cron_step_failed` — any cron step that threw (logged but did not
  abort the run)

---

## 12. Common troubleshooting

| Symptom | Likely cause | Where to look |
| --- | --- | --- |
| `unauthorized` on `/api/messages` | Inbound JWT failed verification | `runtime/auth.ts:verifyBotJwt`; check `TEAMS_APP_ID` matches the `aud` claim |
| `bot_token_<status>` in logs | Outbound Bot Framework token endpoint rejected the credentials | `runtime/bot-outbound.ts:acquireBotToken`; double-check `TEAMS_APP_PASSWORD` |
| Replies + cards never arrive | KV cached an expired bot token | `wrangler kv key delete --binding=ARCADIA_CACHE bot_outbound_token` |
| `graph_<status>` errors | Permission / consent missing | Verify admin consent on the app registration; permissions list above |
| Graph webhook receives nothing | `clientState` HMAC mismatch | `graph_clientstate_mismatch` log line; check `GRAPH_NOTIFICATION_SECRET` parity |
| Memory recall returns empty for a user | Strict ACL filter | `resource_acl` rows for the scope must include the viewer (direct user grant, tenant grant, or a group the viewer is in). Empty ACL = open in tenant. |
| Briefs don't deliver via DM | `getOrCreateUserDm` cannot find a serviceUrl in the user's tenant | Channel must be registered first via a `conversationUpdate` activity in that tenant |
| Weekly roll-up not posted | `WEEKLY_REPORT_CHANNEL_ID` unset or channel not registered | `weekly_delivery_skipped_no_channel` log line |
| Connector sync no-ops | `COPILOT_CONNECTION_ID` unset | `connector_sync_disabled` log line; create the external connection in Microsoft Search admin first |
| Eval gate fails on PR | A tag's pass rate dropped >10pp or overall >5pp vs the rolling baseline | `eval_gate.reason` in CI logs; or query `eval_runs` directly for the failing run's `summary_json` |
| PDFs ingested but not indexed | `PDF_EXTRACT_URL` unset | `documents` row exists, `document_chunks` empty; configure a PDF→text endpoint or skip PDFs |

---

## 13. Rollback

D1 is forward-only — there is no automatic rollback. If a deploy
breaks production:

```bash
npx wrangler rollback                           # rolls back the worker code
# Schema needs a corrective forward migration.
echo "...corrective SQL..." > schema/0002_fix.sql
npm run db:migrate:remote
```

Memory and routines are append-only / soft-deleting in spirit:
`forget()` sets `expires_at` rather than deleting rows. To hard-delete
a botched routine:

```bash
npx wrangler d1 execute arcadia-db --remote --command \
  "DELETE FROM routines WHERE id = '<uuid>'"
```
