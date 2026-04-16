# Arcadia — Fase 1: Auditoría Arquitectónica

Snapshot del análisis realizado antes de iniciar el restructure. Sirve como referencia de estado "antes" para validar resultados de Fase 2.

## Entry points actuales

| URL | Handler | Auth |
|---|---|---|
| `POST /api/messages` | `src/bot/handler.ts` → `handleActivity()` | Bot Framework JWT |
| `POST /api/graph/notifications` | `handleGraphNotification()` | Validation token |
| `GET /health` | inline | — |
| `GET /app/*` | `src/webapp/static.ts` → `serveApp()` | — (redirige a OAuth) |
| `POST /api/webapp/*` | `src/webapp/api.ts` → `handleWebappAPI()` | Azure AD (token cifrado en D1) |
| `POST /internal/cron?type=...` | cron handlers en `src/index.ts` | — (interno) |

**Cron:** daily 08 UTC · weekly Mon 08 UTC · morning 12 UTC Mon-Fri · evening 21 UTC Mon-Fri · research 4x/day.

## Duplicaciones críticas

1. **Fetch de mensajes Teams** — `bot/handler.ts::fetchMessages`, `ai/summarize.ts::summarizeChannel`, `ai/qa.ts::getContextMessages`, `webapp/context/teams.ts`. Cada uno hace fallback Graph→KV por separado.
2. **Manejo de tokens** — 3 estrategias:
   - `graph/client.ts` cachea en KV con margen de 60s ✓
   - `bot/handler.ts::getBotToken` **NO cachea** (refetch por mensaje)
   - `webapp/auth.ts` cifra en D1 sin caché
3. **Construcción de prompts** — `ai/prompts.ts`, `ai/prompts-phase6.ts`, `webapp/prompts.ts`, inline en `intelligence/context-engine.ts`
4. **Posteo de digests/reports** — `intelligence/{digest,weekly,morning,evening}.ts` repiten el mismo flow fetch→AI→post→log
5. **Parsing de activity Teams** — `extractChannelIds` en `bot/handler.ts` + versión propia en `webapp/context/teams.ts`
6. **Error/response formatting** — inline en bot y webapp sin formatter compartido

## Strings mágicos a centralizar

- URLs: `https://login.botframework.com/...`, `https://api.botframework.com`, `https://graph.microsoft.com/v1.0`, `https://login.microsoftonline.com`
- Claves KV: `token:graph`, `dm-history:`, `gc-history:`, `msgs:`, `summary:`, `draft:`, `bot:`
- Límites numéricos: `16` turns historia, `3000` chars Teams, `25` mensajes antes de customer profile update, `60s` margen token, `1800s` TTL DM history
- Enums inline: `conversationType` (`team|groupChat|personal`), `activity types` (`message|conversationUpdate|typing`)

## Smells arquitectónicos

1. `src/bot/handler.ts` = **776 líneas** — routing + intents + memoria + access control + KG + research mezclados
2. Bot token sin caché → ~2 HTTP extras por mensaje
3. Webapp = skeleton: no registra memoria, no hace profile building, sin lógica de refresh de token
4. Knowledge Graph (Phase 6) sin ingesta — queries existen, población no
5. Vectorize binding deshabilitado pero código lo importa sin feature-flag guards
6. Research cycle aislado — no retroalimenta al bot
7. Memory lifecycle fragmentado — `pruneExpiredMemories` daily, pero no hay limpieza equivalente de KV

## Teams webhook vs Webapp — divergencia

| Aspecto | Bot Webhook | Webapp |
|---|---|---|
| Auth | JWT Teams | Azure AD + sesión cifrada |
| Message fetch | `fetchMessages` propio | `webapp/context/teams.ts` |
| Context assembly | `context-engine.ts` | inline |
| Historial | KV DM/group history | D1 webapp_messages |
| Posteo | Bot Framework | response directo |
| Memory recording | ✓ | ✗ |
| Profile building | ✓ | ✗ |

**Comparten:** `ai/router.ts`, `types.ts`, `memory/kv.ts`, `memory/d1.ts`.
**Objetivo Fase 2:** una pipeline única `auth → context → AI → response → memory` con adapters por entry point.

## Módulos por concern

- **Auth:** `bot/auth.ts`, `webapp/auth.ts`, `graph/client.ts` (tokens) — **falta unificación**
- **AI:** `ai/{router,summarize,qa,prompts,prompts-phase6}.ts`
- **Graph:** `graph/{client,messages,subscriptions,users}.ts`
- **Bot:** `bot/{auth,handler,commands,messages}.ts`
- **Storage D1:** `memory/d1.ts`, `tasks/store.ts`, `intelligence/profiles.ts`, `memory/{long-term,knowledge-graph}.ts`
- **Storage KV:** `memory/kv.ts`, `graph/client.ts` (tokens)
- **Vectorize:** `memory/vectors.ts` (disabled)
- **Intelligence:** `intelligence/{context-engine,context,digest,stale,nudge,weekly,morning,evening,heartbeat,profiles,consolidation}.ts`
- **Tasks:** `tasks/{store,detect,assign}.ts`
- **Research:** `research/{autoresearch,scanner,bridge,questions,directives}.ts`
- **Webapp:** `webapp/{auth,api,chat,crypto,middleware,static,prompts,conversations}.ts` + `webapp/context/*` + `webapp/frontend/*`
- **Types:** `types.ts` (~891 líneas, bien centralizado ✓)
- **Entry:** `index.ts` (~426 líneas)

## Prioridades de impacto

| # | Duplicación | Impacto | Prioridad |
|---|---|---|---|
| 1 | Message fetching (3 copias) | 1 helper ahorra ~100 líneas | CRÍTICO |
| 2 | Bot token sin caché | ~500 HTTP calls/día/usuario | CRÍTICO |
| 3 | Token management (3 estrategias) | Base para escalar webapp | CRÍTICO |
| 4 | handler.ts monolítico (776 líneas) | Bloquea testing y claridad | CRÍTICO |
| 5 | Prompt building disperso | Bloquea paridad bot↔webapp | IMPORTANTE |
| 6 | Digest/report posting repetido | ~200 líneas duplicadas | IMPORTANTE |
| 7 | Error formatting | Consistencia UX | IMPORTANTE |
