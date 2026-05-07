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

## Surfaces (build in this order)

1. **`/chat`** — replicate today's webapp chat with streaming SSE,
   citation chips that link to Graph deep-links, and source filter
   toggles.
2. **`/routines`** — visual builder for Phase 4 routines. A drag-and-drop
   canvas (use `@xyflow/svelte` or similar) of triggers + actions; right
   panel inspects the selected node; serialises to the
   `RoutineDefinition` JSON the Worker's `/api/webapp/routines` endpoint
   accepts.
3. **`/sources`** — let users see what's been indexed for them and
   "forget" individual items. Backed by the new Phase 3 `documents`
   table.
4. **`/memory`** — admin-only inspector for the memory palace.
5. **`/settings`** — toggle Arcadia features per user (consent,
   notification preferences).

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

```bash
# Inside web/
npm create svelte@latest .          # choose: SvelteKit, TypeScript, ESLint, Prettier, Vitest, Playwright
npm install -D @sveltejs/adapter-cloudflare tailwindcss @xyflow/svelte @azure/msal-browser
npm run dev                          # local dev at http://localhost:5173
```

Add to `svelte.config.js`:
```js
import adapter from '@sveltejs/adapter-cloudflare';
export default { kit: { adapter: adapter() } };
```

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
