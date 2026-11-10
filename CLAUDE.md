# Arcadia — Build Instructions

**Project:** Arcadia — the S-FX staff hub
**Owner:** Shane Skwarek, S-FX.com Small Business Solutions
**Version:** v6. Supersedes v5.
**Date:** 9 November 2026

The detailed phase spec is `docs/briefs/2026-11-09-arcadia-v6.md`. The decision record is `docs/decisions/2026-11-09-v6-staff-hub.md`. When this file and the brief disagree on a phase detail, the brief wins. Update this file when that happens.

Known error in the brief: its governing rule 7 says "see Phase 7" for credential encryption. Encryption is Phase 8 (brief §8.1, `SETTINGS_ENCRYPTION_KEY`). Rule 7 below is correct. Do not copy the brief's wording back.

Known deviation from the brief: its Phase 1 HUMAN GATE says "applies `0002`, deploys" in that order. Phase 1 deploys first and applies `0002` after (§6 D1 migrations), because the live v5 Worker reads tables `0002` drops.

---

## 1. What Arcadia is

Arcadia is the S-FX staff hub. Any staff member can open it and find what they need about the agency: who works here, how the agency is organized into departments, which clients are active, what services each client has, and who the point of contact is for each one. An assistant, Ask Arcadia, answers questions about all of that, with links back to the records it used.

Shane and his delegated front-office staff (the **Manager** role) set up and maintain the data in **Settings**.

**What Arcadia is not anymore.** It is not an accountability instrument, an M365 repository, a doctrine engine, a site planner, or a Cloudflare OS backend. Phase 1 deletes that code. Git history is the archive, and the last v5 commit is tagged `v5-final`.

### Governing rules

1. **Arcadia owns its data.** Departments, titles, client records, contacts, services, points of contact, and schedules live in D1 and are edited in Arcadia. Microsoft 365 provides two things only: sign-in (Entra ID) and the staff roster (who exists and whether their account is enabled). Later phases may read M365 *content* (Teams messages) from sources an admin explicitly connects. M365 never supplies structure or configuration.
2. **Read wide, write narrow.** Every active staff member can read everything except areas restricted below. Managers write. Superadmins administer roles and AI settings.
3. **Every mutation is audited.** It writes to `audit_log` with the actor, the action, the subject, and a before/after summary.
4. **Ask Arcadia answers from data, not memory.** Every factual claim about S-FX, a client, or a person comes from a tool result and carries a link to the record. When the data doesn't have the answer, she says so. She does not fill gaps from the model's general knowledge.
5. **Nothing reaches a client automatically.** Arcadia never emails, messages, or posts to a client.
6. **No person-level scoring.** Arcadia does not compute or store performance scores about staff.
7. **Credentials live in one place.** Only modules in `src/integrations/` read secrets or stored credentials. Credentials entered in Settings are encrypted at rest (Phase 8, brief §8.1). One documented exception: `src/lib/sso.ts` reads the sign-in secrets itself (`GRAPH_CLIENT_SECRET` for the OIDC code exchange, `SSO_SESSION_SECRET` for the session cookie). Graph API calls go through `src/integrations/graph.ts` only.
8. **Delete, don't make dormant.** If a feature isn't used, remove it. No feature flags for dead code.

---

## 2. Stack

- **Runtime:** Cloudflare only. Workers, D1 (`arcadia-ops`), R2, Durable Objects (SQLite-backed), Queues, Vectorize, Workers AI, and the `agents` SDK (pinned in `package.json`; pre-1.0).
- **Models:** Anthropic through AI Gateway. Never call `api.anthropic.com` directly. `src/integrations/anthropic.ts` builds the gateway client from `CF_ACCOUNT_ID` and `AI_GATEWAY_ID`.
  - Call sites name a `TaskKind` (`src/ai/types.ts`), never a model. `src/ai/router.ts` resolves the task to a provider and model from D1 `model_config` (KV-cached for 60 seconds) over built-in defaults.
  - The built-in defaults in the repo today are Workers AI. Phase 6 adds task kind `ask`, defaulting to a Claude Sonnet-class model. Phase 9 uses task kind `digest`. Embeddings stay on Workers AI.
  - Routing is set in `/approval/admin` today (`handleAdminRoutes` in `src/approval/admin.tsx`) and moves to Settings → AI in Phase 2, along with the monthly spend ceiling. The ceiling is enforced in AI Gateway.
- **Sign-in:** Entra ID OIDC in the Worker (`src/lib/sso.ts`). Authorization-code flow with `state`, `nonce`, PKCE S256, and the `tid` claim pinned to the S-FX tenant. Identity leaves as an HMAC-signed, HttpOnly session cookie valid for eight hours. `DEV_MODE=true` bypasses sign-in on a loopback host only.
- **UI:** keep the existing Preact server-rendered UI and `src/approval/theme.ts`. A frontend rewrite is out of scope. Small progressive-enhancement scripts are allowed where a form or picker needs them (search-as-you-type, multi-select, the chat stream). Keep each one small, local, and served by the Worker.

---

## 3. Roles and capabilities

The repo still has the v5 roles (`superadmin`, `founder`, `lead`, `specialist`). Phase 2 replaces them with three:

| Role | Who | Gets |
|---|---|---|
| `superadmin` | Shane, Alex (seeded) | Everything |
| `manager` | Front-office delegates, assigned in Settings | Everything except `admin_roles_superadmin` and `admin_ai` |
| `staff` | Every other active roster member | Read access only |

**"Manager" is an Arcadia permission tier, not a reporting relationship.** Department leadership is the separate `head` role on a department membership (Phase 3). Use these terms consistently in the UI and the code.

From Phase 2, `src/lib/rbac.ts` holds these capabilities. Today it holds the v5 roles and the four v5 capabilities still checked: `view_board` (Schedule), `manage_clients` (`/clients`), `admin_models`, and `admin_users`.

| Capability | What it covers |
|---|---|
| `manage_settings` | Open Settings at all |
| `manage_staff` | Edit profile fields; assign Manager/Staff |
| `admin_roles_superadmin` | Grant or revoke Superadmin |
| `manage_departments` | Department structure and membership |
| `manage_crm` | Clients, contacts, notes, services, POCs, option lists |
| `manage_schedule` | Shifts configuration and publishing |
| `manage_integrations` | Connect/disconnect Enque; link client orgs |
| `use_workspaces` | Enter client workspace mode in Ask Arcadia; read the client memory corpus |
| `admin_ai` | Model routing and spend ceiling |

- Keep `user_capabilities` so a capability can be granted to an individual beyond their role. For example, a Staff member could get `use_workspaces`.
- Every route re-checks capabilities on the server. Hiding a link is not authorization.
- `isRepositoryAudience` is deleted (Phase 1). Directory and Continuing Education are readable by every active session. Until Phase 2, the writes it used to gate (directory sync and overlays, education records, shift patterns, schedule config) check `admin_users`. Phase 2 moves them to `manage_staff` / `manage_schedule`.
- From Phase 2: session identity is keyed on `aadId` (the ID token's `oid`). A disabled account cannot sign in. A login with no `staff` row gets a read-only staff session and triggers a roster sync (Phase 2).

---

## 4. Navigation and Settings

```
[Ask Arcadia]                      ← primary CTA (hidden until Phase 6 ships)
AGENCY
  Directory                        /agency/directory
  Departments                      /agency/departments
  Schedule                         /agency/schedule        (only if Phase 7 passes its gate)
  Continuing Education             /agency/education
CLIENTS
  Overview                         /clients
  CRM                              /clients/crm
(user menu) → Settings             /settings               (Manager+ only)
```

A nav item whose page doesn't exist yet is omitted, never shown as a placeholder. Client workspaces are configured in Settings → Workspaces and are not in the main nav. Staff enter a workspace from Ask Arcadia (Phase 10), and only with `use_workspaces`.

**After Phase 1** the nav is one AGENCY group: Directory, Schedule, Continuing Education. The brand links to `/agency/directory`; `/` answers 302 there. GETs to `/agency/continuing-education` (the v5 Education URL) answer 301 to `/agency/education`; `src/routes.ts` holds this contract. The user menu links Admin (`/approval/admin`, model routing) for `admin_models` or `admin_users` holders until Settings replaces it in Phase 2. `/clients` is the v5 workspace-binding page, open only to `manage_clients` holders (404 for everyone else) with no nav item, until Phase 4 replaces it. Every other v5 route is 404.

| Settings section | Who | Contents |
|---|---|---|
| Staff & Roles | Manager (Manager/Staff); Superadmin (Superadmin) | Roster, roles, Arcadia-owned profile fields, hidden accounts |
| Departments | Manager | Create, nest, reorder, archive; assign people; set heads |
| CRM Options | Manager | Industries, contact types |
| Integrations | Manager (Enque); Superadmin (M365 consent status) | Microsoft 365 status, Enque connection |
| Schedule | Manager | Shifts host Team, recurring shifts, publish horizon (Phase 7) |
| Workspaces | Manager | Per-client sources, ingestion status, rebuild/purge (Phase 9) |
| AI | Superadmin | Model routing, monthly spend ceiling, Ask Arcadia system settings |
| Audit Log | Manager | Read-only, filterable `audit_log` view |

---

## 5. Repository layout after Phase 1

The tree below is abridged: directories and load-bearing files only.

```
arcadia/
├── CLAUDE.md
├── README.md
├── wrangler.jsonc               # migrations_dir → migrations/; DO migration v4 deletes Radar/Ledger/Dispatcher
├── package.json
├── migrations/                  # numbered D1 migrations; README.md states the destructive rule and deploy order
│   ├── 0001_baseline.sql        # the old src/schema/d1.sql, verbatim
│   └── 0002_v5_cleanup.sql      # Phase 1: drops the v5 tables (destructive, applied after the deploy)
├── scripts/
│   ├── setup.sh                 # provisions only what v6 uses
│   ├── export-d1.sh             # remote D1 export → backups/ and R2 backups/
│   └── check-pending-migrations.sh  # CI deploy gate: fails if a remote migration is pending
├── docs/
│   ├── briefs/                  # 2026-11-09-arcadia-v6.md — the phase spec
│   ├── decisions/               # decision records; 2026-11-09-v6-staff-hub.md is current
│   └── teardown-v5.md           # orphaned cloud resources + wrangler delete commands
├── reference/                   # gitignored clone of github.com/cloudflare/agents
├── backups/                     # gitignored D1 exports
├── test/                        # vitest; routes.test.ts covers redirects, 404s, staff access
└── src/
    ├── index.ts                 # Worker entry: auth routes, DO exports, scheduled(), queue()
    ├── routes.ts                # post-auth dispatch, redirects, 404s (no `agents` import, so vitest loads it)
    ├── agents/arcadia.ts        # Arcadia DO: the scheduler (see below)
    ├── ai/                      # router.ts, types.ts, workers-ai.ts — per-task model routing
    ├── approval/                # Preact UI: shell, nav, theme, icons, directory (no map), education,
    │                            #   schedule + patterns, clients, admin (model routing → Settings in Phase 2),
    │                            #   m365-sync-panel, repository-sync
    ├── clients/bindings.ts      # client_bindings, no Teams-membership checks; kept for Phase 9
    ├── directory/               # cards.ts, sync.ts: roster sync, no manager proof
    ├── integrations/
    │   ├── anthropic.ts         # AI Gateway client
    │   └── graph.ts             # app-only token, retries, paging; one function per call
    ├── lib/                     # sso.ts, rbac.ts, audit.ts, session.ts, entra-verify.ts, plus the helpers the
    │                            #   kept pages import (education, schedule, shift-pattern, directory-ignore,
    │                            #   directory-merge, m365-sync, m365-sync-start)
    ├── memory/                  # PHASE 9 DECIDES: driver.ts, self-hosted.ts (MemoryProfile DO), ingest.ts
    ├── schedule/post-patterns.ts  # kept until Phase 7 decides
    └── schema/types.ts
```

- `src/gatekeepers/` and the delegated Graph connect are gone. `src/integrations/graph.ts` has one function per Graph call Arcadia makes: `listMemberUsers` (roster), the Shifts calls (shifts, times off, time-off requests and reasons, scheduling groups, `createShift`, `deleteShift`, `createTimeOffRequest`), and `listTeams` / `getChannel`. Phase 9 adds chats and messages. Every write to an external system writes an `audit_log` row before and after the call.
- `src/memory/driver.ts`, `self-hosted.ts`, and `ingest.ts` carry a one-line header saying Phase 9 adopts or deletes them. The `MemoryProfile` DO, the three Vectorize indexes, and the `arcadia-vectorize` queue and DLQ stay bound until then (`docs/teardown-v5.md`).
- The schedule code in `src/approval/schedule.tsx` stays working until Phase 7 rebuilds or removes it.
- **The `Arcadia` agent DO stays (Phase 1 decision)** as a scheduler only: the daily roster sync (06:15 UTC), the shift-pattern post (06:30 UTC), and `kickRepositorySync` for a never-synced Directory. On start it cancels stored schedules whose callback no longer exists. It has no Ask or doctrine logic and no `/agents/*` route. Phase 6 adds its own class for Ask Arcadia.

---

## 6. Build state

Each phase gets its own branch, `sfx/v6-phase-N-<slug>`, and one PR. Phase 0 ran on the session-assigned branch `sfx/compassionate-hopper-x32fex`; Phase 1 on `sfx/v6-phase-1-cleanup`.

| Phase | Name | State |
|---|---|---|
| 0 | Reset the spec and the migration system | Merged — awaiting HUMAN GATE (run **Apply D1 migrations** once: baseline + `v5-final` tag) |
| 1 | Real cleanup and the new nav | In review — awaiting HUMAN GATE (deploy, then Apply D1 migrations for 0002, then teardown) |
| 2 | Staff, roles, and Settings | Not started |
| 3 | Departments | Not started |
| 4 | Client CRM (organization-first) | Not started |
| 5 | Services (client ↔ department) and Clients Overview | Not started |
| 6 | Ask Arcadia, rebuilt (global, structured) | Not started |
| 7 | Schedule: Arcadia-authored shifts pushed to Teams (go/no-go) | Not started |
| 8 | Integrations framework and Enque | Not started |
| 9 | Client memory (Workspaces pipeline) | Not started |
| 10 | Workspace mode in Ask Arcadia | Not started |

Order: `0 → 1 → 2 → 3 → 4 → 5 → 6 → 8 → 9 → 10`. Phase 7 can run any time after Phase 2.

### How phases work

1. Read the brief before writing code. One phase per branch and PR. Do not start a phase until the previous PR is merged.
2. A phase is done when every **Done when** line in the brief is true and `npm test` passes in CI.
3. A **HUMAN GATE** line is something only Shane can do. Stop, say exactly what is needed, and wait.
4. Never apply a destructive D1 migration to the remote database. Write it, explain it, and let Shane run it after he has taken an export.
5. Do not recall Cloudflare `agents` SDK, Vectorize, D1, or Workflows APIs from memory. Verify against the Cloudflare MCP server or the `/reference` clone of `github.com/cloudflare/agents`.
6. Do not recall Microsoft Graph behavior from memory. Check current Microsoft Learn docs for every endpoint, and test against the tenant in the phase's spike step before building on it.
7. At the end of each phase, update the Build state table above.

### D1 migrations

- Every schema change is a numbered file in `migrations/`. There is no `src/schema/d1.sql` anymore.
- `npm run db:migrate:local` applies migrations to the local DB. `npm run db:migrate:remote` applies them to the remote DB. `npm run db:export` runs `scripts/export-d1.sh`.
- **Destructive migrations (DROP, table rebuilds) are applied by Shane after running `scripts/export-d1.sh`.**
- Migrations are applied with the **Apply D1 migrations** GitHub Actions workflow (`.github/workflows/d1-migrate.yml`): manual only, export first, then apply. Only Shane runs it. Terminal fallback: `npm run db:export && npm run db:migrate:remote`.
- **Additive goes schema first.** The CI deploy job (manual `workflow_dispatch`) does not apply migrations. It runs `scripts/check-pending-migrations.sh` and fails the deploy if any remote migration is pending, so Shane runs Apply D1 migrations before deploying.
- **A DROP goes code first.** Merge the code that no longer reads the table, let the deploy of `main` finish (Workers Builds on merge, or `npm run deploy`; the CI deploy job stops while the drop is pending), then run Apply D1 migrations. Keep drops and additive changes in separate migrations. If the new code still reads the table (dropping `users` breaks sign-in), the DROP waits for a later migration and PR. `migrations/README.md` has the details.

---

## 7. Human-only steps

Flag these to Shane and stop.

**First deploy (already done for the live Worker; needed for a fresh environment):**
- Cloudflare API token for `wrangler`. CI reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub secrets.
- AI Gateway in the Cloudflare dashboard. Its id goes in the `AI_GATEWAY_ID` var in `wrangler.jsonc`. If the gateway is authenticated: `wrangler secret put AI_GATEWAY_TOKEN`.
- Entra ID app registration, one for both sign-in and Graph. Platform **Web**. Redirect URIs `https://arcadia.s-fx.com/auth/callback` and `http://localhost:8787/auth/callback`. Delegated `openid`, `profile`, `email`. Restrict assignment to S-FX staff. Then:
  - `GRAPH_TENANT_ID` and `GRAPH_CLIENT_ID` → vars in `wrangler.jsonc` (public identifiers, not secrets)
  - `wrangler secret put GRAPH_CLIENT_SECRET`
  - `wrangler secret put SSO_SESSION_SECRET` (`openssl rand -base64 32`; rotating it logs everyone out)
- `wrangler secret put ANTHROPIC_API_KEY`. Optional until a task routes to Anthropic; Phase 6's `ask` task needs it.

**v6 phases:**

| Phase | Step |
|---|---|
| 0, 1, and every migration | In GitHub: **Actions → Apply D1 migrations → Run workflow**, type `apply`. It exports the DB to R2 (and attaches the backup to the run), then applies pending migrations. The first run also pushes the `v5-final` tag. A drop is applied after its code is deployed (§6). Terminal fallback: `npm run db:export && npm run db:migrate:remote` |
| 1 | Follow `docs/teardown-v5.md` "Order of operations": deploy `main` (the v4 DO migration destroys Radar/Ledger/Dispatcher storage), then run Apply D1 migrations for 0002, then, once stable, run the teardown commands |
| 2 | Graph application consent: `User.Read.All` (roster). Remove unused permissions from the app registration (unused delegated scopes are listed in `docs/teardown-v5.md`). The Schedule permissions are still in use until Phase 7 decides. Phase 2 lists the final set here |
| 7 | Consent `Schedule.ReadWrite.All`; pick the Shifts host Team; make the go/no-go call |
| 8 | `wrangler secret put SETTINGS_ENCRYPTION_KEY`; provide Enque API docs and a test key in `docs/vendor/enque/` |
| 9 | Consent `ChannelMessage.Read.All`, `Chat.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`; go/no-go per Teams source |
| 6+ | Set the AI Gateway monthly spend ceiling |

---

## 8. Do not rebuild

These were removed on purpose. Do not bring any of them back as a side effect of other work:

- Doctrine
- Accountability instruments
- Site planning
- Cloudflare OS bridge
- Loop crawl
- Planner objectives index
- Region map
