# Ask Arcadia v5 — Virtual Assistant

Overrides the Phase 2 chat language in CLAUDE.md. Radar, Ledger, ratification, and “humans decide and sign” for **writes** are unchanged.

## What she is

S-FX’s 1:1 virtual assistant. She talks to the signed-in Specialist in Shane’s voice. Doctrine is gravity, not a wall.

| Layer | Role |
|---|---|
| Voice + judgment | Doctrine, brand, deposited examples. Soft. She may analogize. |
| Facts about work | That user’s delegated M365 + person/project memory. |
| Law | Ratified `[HARD]` doctrine only. Cite it. Do not invent a new law. |
| Writes | Gatekeeper + named human. Drafts are free. Sends/patches are not. |

## Cited vs Inferred (doctrine §12.3)

Every answer states its mode.

- **Cited** — canonical recall cleared the confidence floor. Quote the entries.
- **Inferred** — it did not. Still give a usable answer. Label it. Log a gap candidate if the filter says this is a real operating question.

`INSUFFICIENT_DOCTRINE` is not a valid exit. Refusing a draft or a coaching request is a defect.

## Graph

Two modes, one Entra app:

- **App-only** (`src/integrations/graph.ts`, `src/gatekeepers/graph.ts`) — Radar / Objectives project scope.
- **Delegated** (`src/integrations/graph-user.ts`, `src/gatekeepers/user-graph.ts`) — that Specialist only. Connect at `/auth/graph`. Tokens in KV, never in the cookie.

Login stays `openid profile email` so missing Graph consent cannot lock staff out.

## Files

- `src/lib/ask.ts` — mode, prompts, citation payload
- `src/agents/arcadia.ts` — `ask()`
Send is live: the user bubble appears immediately, Arcadia writes in the background (`ctx.waitUntil`), and the page does not reload. No-JS still POSTs the form.
- `src/gatekeepers/user-graph.ts` — user session
- `src/lib/sso.ts` — `beginGraphConnect`
