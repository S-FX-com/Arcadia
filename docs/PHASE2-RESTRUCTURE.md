# Arcadia — Fase 2: Restructure DRY y pipeline unificada

> Prerequisito: leer primero [PHASE1-AUDIT.md](./PHASE1-AUDIT.md) para entender el estado "antes".

## Objetivo

Ejecutar la refactorización estructural **sin cambiar funcionalidad**, en PRs atómicos verificables. El bot de Teams (`/api/messages`) y la webapp (`/api/webapp/*`) deben terminar usando la **misma pipeline interna**.

## Tareas en orden (no saltar ninguna)

### TIER 1 — Base compartida

1. **`src/constants.ts`** — centralizar:
   - `BOT_FRAMEWORK` (OPENID_URL, ISSUER, SCOPE, ALGORITHM)
   - `GRAPH` (BASE_URL, TOKEN_URL(tenantId), SCOPE, TOKEN_CACHE_KEY, TOKEN_SAFETY_MARGIN_SECONDS=60)
   - `KV_KEYS` (funciones que construyen keys: DM_HISTORY, GROUP_CHAT_HISTORY, CACHED_MESSAGES, SUMMARY, BOT_MESSAGE_ID, DRAFT, TOKEN_BOT)
   - `TEAMS` (MESSAGE_MAX_LENGTH=3000, ACTIVITY_TYPES, CONVERSATION_TYPES)
   - `AI` (HISTORY_MAX_TURNS=16, DEFAULT_MAX_TOKENS)
   - `LIMITS` (MEMORY_RECALL_MAX, NUDGE_MAX_PER_RUN, NUDGE_COOLDOWN_HOURS, CUSTOMER_PROFILE_UPDATE_INTERVAL=25)
   - `ARCADIA_VERSION`

   Buscar **todos** los literales en `src/` y reemplazar por imports. No dejar duplicados.

2. **`src/auth/token-manager.ts`** — unificar tokens:
   - Interface `TokenProvider { getToken(): Promise<string> }`
   - `GraphTokenProvider` (mover lógica de `src/graph/client.ts`, mantener cache KV)
   - `BotFrameworkTokenProvider` (**nuevo** — cachear en KV con TTL, usar `TOKEN_SAFETY_MARGIN_SECONDS`)
   - Reemplazar `getBotToken()` inline en `src/bot/handler.ts`
   - Medir reducción de HTTP calls

3. **`src/graph/fetch.ts`** — fetcher único:
   - `fetchConversationMessages(env, { teamId?, channelId?, chatId?, conversationType, limit, useCacheFallback })`
   - Reemplazar `fetchMessages()` en `bot/handler.ts`, `getContextMessages()` en `ai/qa.ts`, versión inline en `ai/summarize.ts`, y `webapp/context/teams.ts`

### TIER 2 — Modularización del bot handler

4. **`src/bot/conversation-modes.ts`**:
   - Interface `ConversationMode { fetchHistory, saveHistory, shouldRespond, getContextLimit }`
   - `DMMode`, `GroupChatMode`, `ChannelMode` (mover lógica de KV-caching desde `handler.ts`)

5. **`src/bot/intents/`** — un archivo por intent:
   - `summarize.ts`, `decisions.ts`, `next-steps.ts`, `who-owns.ts`, `assign.ts`, `draft.ts`, `research.ts`, `knowledge.ts`, `exec-summary.ts`
   - Cada uno exporta `async function handle(ctx: IntentContext): Promise<IntentResult>`
   - Registry en `src/bot/intents/index.ts` (map intent → handler)

6. **`src/bot/access-control.ts`** — centralizar checks de admin/owner que están inline.

7. **Reducir `src/bot/handler.ts` a ~300 líneas** — solo dispatch + orquestación.

### TIER 3 — Pipeline unificada Teams + Webapp

8. **`src/pipeline/arcadia-pipeline.ts`** — pipeline compartida:
   ```
   input: { user, text, conversationRef, mode: "teams-bot" | "webapp" }
   → authenticate (upstream)
   → assembleContext (memorias + perfil + canal + tasks)   [context-engine]
   → callAI (via ai/router.ts)
   → formatResponse (según mode)
   → recordMemory (fire-and-forget, respeta MEMORY_ENABLED)
   → return ArcadiaResponse
   ```
   - Bot handler llama esta pipeline después de resolver intent
   - Webapp API llama esta pipeline directamente en `/api/webapp/chat`
   - El registro de memoria debe funcionar igual desde ambos entry points

9. **`src/ai/prompt-registry.ts`** — registrar prompts por intent/tipo; reducir duplicación entre `prompts.ts`, `prompts-phase6.ts`, `webapp/prompts.ts`.

10. **Verificar paridad bot↔webapp** — mismo input produce mismo system prompt, misma memoria, mismo modelo.

### TIER 4 — Limpieza

11. `src/features.ts` — feature flags consolidados; reemplazar `if (env.X_ENABLED === "true")` dispersos.
12. `src/responses/formatter.ts` — error/response formatters compartidos.
13. Guards de Vectorize en `src/memory/vectors.ts` para no fallar si el binding no existe.

## Reglas estrictas

- **No saltar ninguna regla** (instrucción explícita):
  - Ninguna función se renombra sin actualizar todos los callers
  - Ningún archivo se borra sin verificar que nadie lo importa
  - Correr `tsc --noEmit` después de cada tier
- Commit atómico por cada numeral (1..13). Mensajes en inglés, conventional commits.
- **NO cambiar comportamiento observable.** `/api/messages`, `/api/webapp/*`, `/internal/cron` deben responder igual.
- NO tocar schemas D1 en esta fase. Solo código.
- Preguntar antes de:
  - Renombrar KV keys existentes (requiere migrar datos)
  - Cambiar bindings en `wrangler.toml`
  - Tocar `manifest/`
- Al final de cada tier: resumir en 3 líneas qué se movió + `tsc --noEmit` + `wrangler deploy --dry-run`.

## Orden sugerido de ejecución

Empezar por **Tier 1 → numeral 1**. Confirmar plan de cambios antes de escribir código.
