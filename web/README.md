# `web/` — Arcadia frontend (SvelteKit on Cloudflare Pages)

This directory is the home for the **production web UI** that replaces the
embedded vanilla SPA at `src/webapp/frontend/`. It's a separate Cloudflare
Pages project that talks to the Worker via a Service Binding.

The skeleton is intentionally minimal — building it out is its own
multi-week project and is **not** done by the same workflow that
generated the backend. Use this README as the entry point.

## Why a separate project

- **Independent deploys**: UI changes shouldn't redeploy the Worker.
- **Real bundler**: Vite + SvelteKit gives proper tree-shaking,
  asset hashing, and code splitting that the Worker's inline-string
  approach can't match.
- **Streaming SSE**: SvelteKit's `+server.ts` endpoints are a clean
  place to consume the Worker's streaming chat responses.
- **a11y in CI**: axe-core integrates cleanly with Playwright in a
  Pages project; harder to wire to the Worker.

## Surfaces

1. **`/chat`** — ✅ shipped. Streaming SSE consumer with progressive
   text rendering and citation chips. Hits POST
   `/api/webapp/chat/stream` (gated by `AGENT_LOOP_ENABLED=true`).
2. **`/routines`** — ✅ list + "run now" shipped against the Phase 4
   API. Visual drag-and-drop builder is the next major piece (use
   `@xyflow/svelte`); the JSON shape it should produce is in the
   Worker's `RoutineDefinition` zod schema.
3. **`/sources`** — TODO: let users see what's been indexed for them
   and "forget" individual items. Backed by Phase 3 `documents`.
4. **`/memory`** — TODO: admin-only inspector for the memory palace.
5. **`/settings`** — TODO: toggle Arcadia features per user.

## Stack (recommended)

- **SvelteKit 2** + **Svelte 5 runes** for the UI.
- **Tailwind 4** for styling.
- **MSAL.js v3** for Entra ID auth on the client (the Worker's
  `/api/webapp/auth/token` exchange stays unchanged).
- **`@xyflow/svelte`** for the routine canvas.
- **Vitest + Playwright** for tests; **axe-core** in Playwright for a11y.
- **Cloudflare Pages** for hosting; **Service Binding** to the Worker
  for API calls.

## First-time setup commands

The skeleton (package.json, svelte.config.js, vite.config.ts, /chat,
/routines) ships with this branch. To run it:

```bash
cd web
npm install
npm run dev                          # http://localhost:5173

# Worker must be running too so the proxy can reach /api/*
# In a second terminal at the repo root:
npm run dev                          # wrangler dev → http://127.0.0.1:8787
```

The Vite dev server proxies `/api/*` to `127.0.0.1:8787`, so the
streaming chat surface at `/chat` works against `wrangler dev` out of
the box.

In Cloudflare dashboard:
1. Create a Pages project pointing at this directory.
2. Add a Service Binding named `ARCADIA` pointing at the
   `arcadia` Worker.
3. Add an environment variable `PUBLIC_AAD_CLIENT_ID` with the
   webapp's MSAL client id.

## API contract (Worker → Web)

All endpoints are documented under `src/webapp/api*.ts`. The most
important ones for the new UI are:

- `POST /api/webapp/chat` — chat (returns full text today; SSE
  streaming will be added in a separate Worker change).
- `GET/POST/PUT/DELETE /api/webapp/routines[/{id}[/run|/runs]]` —
  Phase 4 routine CRUD + trigger.
- `GET /api/webapp/conversations` — conversation history.
- `GET /api/webapp/context/*` — M365 picker resources (teams,
  channels, sites, etc.).
