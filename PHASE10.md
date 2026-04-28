# Phase 10 — S-FX AI Assistant: Client Intelligence, Image Generation & Model Routing

## Overview

This phase transforms Arcadia from a Teams-bot-first tool into a full **S-FX AI Assistant**
for internal staff — a ChatGPT/Claude-like interface powered by the team's own M365 data.
The webapp (`src/webapp/`) is the primary surface for this work.

Key additions:
1. **Client Intelligence** — Project-style client folders with M365 source linking and auto-indexing
2. **Image Generation** — Tab in webapp UI using FLUX models on Workers AI
3. **Sync M365** — Explicit sync trigger with status display
4. **Model Routing** — Tiered model selection using the Advisor Strategy pattern

---

## 1. Client Intelligence System

### Concept
A "Client" is a named workspace that maps to a curated set of M365 sources (Teams, Channels,
Chats, SharePoint sites, Planner boards). Chat within a client is fully grounded in that
client's data. Clients persist across sessions and are shared within the organization.

### Schema — `schema/d1-phase10.sql`

```sql
-- Clients (shared org-wide, not per-user)
CREATE TABLE IF NOT EXISTS clients (
  id            TEXT PRIMARY KEY,         -- crypto.randomUUID()
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT DEFAULT '#00b4d8',   -- UI accent color
  created_by    TEXT NOT NULL,            -- AAD user ID
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  index_status  TEXT DEFAULT 'pending',   -- pending|indexing|ready|error
  index_started_at  INTEGER,
  index_completed_at INTEGER,
  memory_summary    TEXT,                 -- AI-generated living summary of the client
  memory_version    INTEGER DEFAULT 0,
  UNIQUE(name)
);

-- M365 sources linked to a client
CREATE TABLE IF NOT EXISTS client_sources (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  source_type   TEXT NOT NULL,            -- team|channel|chat|sharepoint-site|planner-plan
  source_id     TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  team_id       TEXT,                     -- parent team_id if source_type=channel
  metadata      TEXT,                     -- JSON: additional context
  added_by      TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  UNIQUE(client_id, source_type, source_id)
);

-- Per-client memory store (separate from global memories table)
CREATE TABLE IF NOT EXISTS client_memories (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  category        TEXT NOT NULL,          -- episodic|semantic|procedural|observation
  content         TEXT NOT NULL,
  keywords        TEXT DEFAULT '',
  importance      REAL DEFAULT 0.5,
  source_ref      TEXT,                   -- source_id that generated this memory
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER                 -- NULL = permanent
);

-- Index run log
CREATE TABLE IF NOT EXISTS client_index_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT DEFAULT 'running', -- running|completed|failed
  messages_read   INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,
  summary         TEXT
);

-- Notifications for users (index complete, blockers detected)
CREATE TABLE IF NOT EXISTS client_notifications (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  user_id     TEXT,                       -- NULL = broadcast to all
  type        TEXT NOT NULL,              -- index_complete|blocker_detected|memory_updated
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_created_by ON clients(created_by);
CREATE INDEX IF NOT EXISTS idx_client_sources_client ON client_sources(client_id);
CREATE INDEX IF NOT EXISTS idx_client_memories_client ON client_memories(client_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_client_notifications_user ON client_notifications(user_id, read, created_at DESC);
```

### New Module: `src/intelligence/client-indexer.ts`

This is the core background intelligence engine for a client.

```typescript
// Exports:
export async function startClientIndex(clientId: string, env: Env, ctx: ExecutionContext): Promise<void>
export async function runClientIndexCycle(clientId: string, env: Env): Promise<ClientIndexResult>
export async function updateClientMemorySummary(clientId: string, env: Env): Promise<void>
export async function detectClientBlockers(clientId: string, env: Env): Promise<string[]>
```

**`runClientIndexCycle` algorithm:**
1. Load all `client_sources` for the client
2. For each source, retrieve the user's delegated token (use the client's `created_by` user's
   most recent session from `webapp_sessions`)
3. Fetch messages from each source via `src/webapp/context/teams.ts` delegated methods
4. Call AI to extract memories: use `buildMemoryExtractionPrompt` from `src/ai/prompts.ts`
5. Store extracted memories in `client_memories` table (not global `memories` table)
6. After all sources processed, call `updateClientMemorySummary` to regenerate the living summary
7. Detect blockers: scan for messages containing deadlines + no resolution, questions with no answer
8. Create notifications for blockers and index completion
9. Update `clients.index_status`, `index_completed_at`, `memory_version`

**`updateClientMemorySummary` algorithm:**
- Fetch top 50 client memories by importance
- Call AI with prompt: "You are building a living executive briefing for client [name].
  Synthesize these memories into a structured summary: active workstreams, key decisions,
  open items, risks, and recommendations. Be specific and direct. Max 800 tokens."
- Store result in `clients.memory_summary`
- Increment `memory_version`

**Index scheduling:**
- Trigger immediately on client creation via `ctx.waitUntil(startClientIndex(...))`
- Re-index every 6 hours via new cron: `"0 */6 * * *"` → `handleClientIndexCron(env)`
- Manual re-index via API endpoint

### New Module: `src/webapp/api/clients.ts`

REST endpoints — all require auth:

```
GET    /api/webapp/clients                    list all clients
POST   /api/webapp/clients                    create client (triggers onboarding flow)
GET    /api/webapp/clients/:id                get client + memory summary
PUT    /api/webapp/clients/:id                update name/description
DELETE /api/webapp/clients/:id                delete client and all its data

GET    /api/webapp/clients/:id/sources        list sources
POST   /api/webapp/clients/:id/sources        add source
DELETE /api/webapp/clients/:id/sources/:sid   remove source

POST   /api/webapp/clients/:id/index          trigger re-index now
GET    /api/webapp/clients/:id/index/status   get current index status + log

GET    /api/webapp/clients/:id/notifications  get unread notifications
POST   /api/webapp/clients/:id/notifications/read  mark all read

GET    /api/webapp/clients/:id/memories       list memories (paginated)
GET    /api/webapp/clients/:id/executive-summary  generate fresh exec summary
```

### Client Chat Integration

When a user starts or continues a chat that is associated with a client, the pipeline
must inject the client's memory context:

In `src/webapp/chat.ts` → `handleChat`:
- Accept optional `clientId` in `WebappChatRequest`
- If provided, load client memory summary + top 20 client memories
- Prepend to system prompt as: `--- Client Context: [Client Name] ---\n[memory summary]\n\nKey facts:\n- [memory 1]\n- [memory 2]...`
- Pass `clientId` through to conversation record for grouping

In `src/webapp/conversations.ts`:
- Add `client_id TEXT` column to `webapp_conversations` (via schema migration)
- `listConversations` should support filtering by `client_id`

### Onboarding Flow (webapp UI)

When creating a new client, the webapp presents a multi-step wizard:

**Step 1:** Name + Description  
**Step 2:** Source picker — calls existing M365 context endpoints to populate:
- Teams (with expand-to-channels)
- Chats
- SharePoint sites
- Planner plans  
User selects any combination. Each selection is stored as a `client_source`.

**Step 3:** Confirmation — shows selected sources, triggers index immediately

After creation, the sidebar shows the client under "CLIENTS" with an indexing spinner that
resolves to a checkmark when `index_status = 'ready'`. A toast notification appears when
complete.

---

## 2. Image Generation

### New Module: `src/webapp/api/images.ts`

```
POST /api/webapp/images/generate    generate image from prompt
GET  /api/webapp/images/:id         retrieve generated image (from KV)
```

**Model selection for image generation** (see Model Routing section below):
- Default: `@cf/black-forest-labs/flux-2-dev` — highest quality, realistic
- Fast: `@cf/black-forest-labs/flux-2-klein` — faster, still high quality
- Creative: `@cf/leonardo/phoenix-1.0` — best prompt adherence, text rendering

The existing `src/ai/image.ts` module already handles generation + KV storage.
Extend it:
```typescript
export type ImageModel = 'flux-dev' | 'flux-klein' | 'phoenix' | 'lucid-origin';

export async function generateImage(
  prompt: string,
  model: ImageModel = 'flux-dev',
  env: Env,
  workerUrl: string
): Promise<{ url: string; model: string } | null>
```

### UI

Add **"Generate Image"** tab to the webapp input area (already stubbed in `client.js.ts`).
When active:
- Input field becomes "Describe your image..."
- Model selector dropdown: Quality / Fast / Creative
- Generated image appears inline in the chat message area
- Download button on hover

---

## 3. Sync M365

### Concept
The "Sync M365" button in the sidebar triggers a fresh pull of the user's M365 data
(Teams, Chats, SharePoint) and updates the cross-context cache. Provides visible feedback.

### Implementation

**New endpoint:** `POST /api/webapp/sync`
- Calls `fetchUserFullContext` from `src/webapp/context/teams.ts`
- Updates KV cache keys for the user's cross-context
- Returns `{ status: 'ok', sourcesRefreshed: number, lastSync: ISO }`

**KV key for last sync time:**
```typescript
`sync:${userId}:last` → ISO timestamp string, TTL 24h
```

**UI behavior:**
- "Sync M365" button in sidebar footer shows spinner while running
- On complete: button text changes to "✓ Synced [time]" for 3 seconds
- Error state: "Sync Failed — Retry"
- On load: show last sync time if available ("Synced 2h ago")

---

## 4. Model Routing — Advisor Strategy

### Model Assignments

Based on Workers AI catalog (current as of April 2026):

| Use Case | Primary Model | Advisor/Fallback | Rationale |
|----------|--------------|------------------|-----------|
| **Quick Chat** | `@cf/google/gemma-4-27b-it` | None | Fast, strong at conversation, free tier |
| **Deep Research** | `@cf/google/gemma-4-27b-it` with research prompt | `@cf/meta/llama-4-scout-17b-16e-instruct` as fallback | Gemma 4 = best reasoning; Llama 4 Scout has 10M ctx for long docs |
| **Coding** | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | `@cf/google/gemma-4-27b-it` fallback | DeepSeek R1 distill excels at code/reasoning |
| **Image Gen (quality)** | `@cf/black-forest-labs/flux-2-dev` | `@cf/leonardo/phoenix-1.0` | FLUX.2 dev = highest quality |
| **Image Gen (speed)** | `@cf/black-forest-labs/flux-2-klein` | `@cf/bytedance/stable-diffusion-xl-lightning` | Klein = fast + quality |
| **Embeddings** | `@cf/baai/bge-base-en-v1.5` | Already in use | Unchanged |

### New File: `src/ai/model-registry.ts`

```typescript
export type ModelPurpose =
  | 'quick-chat'
  | 'deep-research'
  | 'coding'
  | 'client-indexing'
  | 'memory-extraction'
  | 'summarization'
  | 'image-quality'
  | 'image-fast'
  | 'image-creative'
  | 'embeddings';

export interface ModelConfig {
  modelId: string;
  fallback?: string;
  maxTokens: number;
  useAdvisor: boolean;
  advisorTriggers?: string[];  // conditions that trigger advisor escalation
}

export const MODEL_REGISTRY: Record<ModelPurpose, ModelConfig> = {
  'quick-chat': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 2048,
    useAdvisor: false,
  },
  'deep-research': {
    modelId: '@cf/google/gemma-4-27b-it',
    fallback: '@cf/meta/llama-4-scout-17b-16e-instruct',
    maxTokens: 8192,
    useAdvisor: true,
    advisorTriggers: [
      'conflicting information',
      'complex multi-source analysis',
      'strategic recommendation',
      'cross-client pattern detection',
    ],
  },
  'coding': {
    modelId: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    fallback: '@cf/google/gemma-4-27b-it',
    maxTokens: 4096,
    useAdvisor: true,
    advisorTriggers: [
      'architectural decision',
      'security consideration',
      'performance trade-off',
    ],
  },
  'client-indexing': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 4096,
    useAdvisor: false,  // background task, no advisor overhead
  },
  'memory-extraction': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 1024,
    useAdvisor: false,
  },
  'summarization': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 2048,
    useAdvisor: false,
  },
  'image-quality': {
    modelId: '@cf/black-forest-labs/flux-2-dev',
    fallback: '@cf/leonardo/phoenix-1.0',
    maxTokens: 0,  // image model
    useAdvisor: false,
  },
  'image-fast': {
    modelId: '@cf/black-forest-labs/flux-2-klein',
    fallback: '@cf/bytedance/stable-diffusion-xl-lightning',
    maxTokens: 0,
    useAdvisor: false,
  },
  'image-creative': {
    modelId: '@cf/leonardo/phoenix-1.0',
    fallback: '@cf/leonardo/lucid-origin',
    maxTokens: 0,
    useAdvisor: false,
  },
  'embeddings': {
    modelId: '@cf/baai/bge-base-en-v1.5',
    maxTokens: 0,
    useAdvisor: false,
  },
};

export function getModel(purpose: ModelPurpose, env: Env): ModelConfig {
  // Allow override via env vars for easy tuning without deploys
  // e.g. env.MODEL_QUICK_CHAT = '@cf/...'
  return MODEL_REGISTRY[purpose];
}
```

### Advisor Strategy Implementation

The advisor pattern in this codebase adapts to Workers AI (not Anthropic SDK).
Since Workers AI doesn't have a native advisor tool, implement it as a **two-call pattern**:

```typescript
// src/ai/advisor.ts
export async function callWithAdvisor(
  purpose: ModelPurpose,
  systemPrompt: string,
  userMessage: string,
  env: Env,
  options: { forceAdvisor?: boolean } = {}
): Promise<{ text: string; usedAdvisor: boolean }>
```

**Algorithm:**
1. Call primary model (executor)
2. If response contains uncertainty markers OR `forceAdvisor=true`:
   - Call `@cf/google/gemma-4-27b-it` with a meta-prompt: "Review this response and provide
     a corrected/improved version with higher confidence: [executor response]"
   - Return the refined response
3. Otherwise return executor response directly

**Uncertainty markers to detect:**
```typescript
const UNCERTAINTY_PATTERNS = [
  /i('m| am) not sure/i,
  /i don't (know|have)/i,
  /unclear/i,
  /cannot (determine|confirm)/i,
  /may (or may not)/i,
];
```

This gives the advisor benefit without requiring Anthropic SDK's native advisor tool
(which isn't available in Workers AI).

### Update `src/ai/router.ts`

Replace the hardcoded `CF_AI_DEFAULT_MODEL` reference with model registry lookups:

```typescript
import { getModel, type ModelPurpose } from './model-registry.js';

export async function callAIForPurpose(
  purpose: ModelPurpose,
  system: string,
  user: string,
  env: Env,
  options: AIStreamOptions = {}
): Promise<AIResponse>
```

The existing `callAI` function remains for backward compatibility but internally routes
through `callAIForPurpose('quick-chat', ...)`.

---

## 5. Webapp UI — Full Specification

### Sidebar Structure (matches screenshot)
```
[S-FX AI Assistant]
[+ New Conversation]

CONVERSATIONS
  [Recent conv 1]    [date]
  [Recent conv 2]    [date]
  ...

CLIENTS
  [Client Name]  →   [12 conversations]
  [Client Name]  →   [8 conversations]
  [+ Add Client]

IMAGE GENERATION
  [Recent image 1]   [date]
  [Recent image 2]   [date]

---footer---
[Sync M365]    [Settings]
```

### Client Sidebar Item Behavior
- Click client name → expands to show conversations scoped to that client
- Right-click / kebab menu → Rename, Re-index, Delete
- Index status indicator: spinner (indexing) → green dot (ready) → red dot (error)
- Notification badge when unread notifications exist

### Chat Input Area
```
[Chat] [Generate Image]          [Attach M365 File]
[textarea: Ask anything...]                    [→]
```
- "Generate Image" tab switches input mode
- "Attach M365 File" opens a file picker over SharePoint / OneDrive
- In client context: header shows client name badge above messages

### Settings Page
Accessible from sidebar footer "Settings":
- **Model Settings:** dropdown per purpose (quick-chat, deep-research, etc.)
- **Notification Settings:** which notification types to receive
- **Client Management:** view all clients, index status, memory stats
- **M365 Connection:** shows connected account, scopes granted, last sync time

---

## 6. Env Additions

Add to `src/types.ts` Env interface:
```typescript
CLIENT_INDEX_ENABLED: string;   // "true" | "false"
MODEL_QUICK_CHAT?: string;      // override for quick-chat model
MODEL_DEEP_RESEARCH?: string;   // override for deep-research model
MODEL_CODING?: string;          // override for coding model
```

Add to `src/features.ts`:
```typescript
clientIndex: (env: Env) => flag(env.CLIENT_INDEX_ENABLED),
```

Add to `wrangler.toml` `[vars]`:
```toml
CLIENT_INDEX_ENABLED = "true"
```

Add to cron triggers in `wrangler.toml`:
```toml
# "0 */6 * * *" → Client index refresh (every 6 hours)
```
Update `crons` array and add `"0 */6 * * *"` to the list.

---

## 7. Notification Delivery

Notifications are stored in `client_notifications` and surfaced in two ways:

**In-app:** Webapp polls `GET /api/webapp/clients/:id/notifications` every 60 seconds
when a client is active. Unread count shown as badge on client sidebar item.

**Teams DM (optional, gated by feature flag):** If the user has a linked Teams account
(`linked_users` table), and `TEAMS_NOTIFICATIONS_ENABLED = "true"`, post a brief DM
via the existing proactive posting pattern in `src/intelligence/digest.ts`.

Notification types and their messages:
- `index_complete`: "✓ [Client Name] index complete — [N] memories created across [M] sources."
- `blocker_detected`: "⚠ Blocker detected in [Client Name]: [description]"
- `memory_updated`: "📊 [Client Name] memory updated — [summary of changes]"

---

## 8. Files to Create

| File | Purpose |
|------|---------|
| `schema/d1-phase10.sql` | New tables |
| `src/ai/model-registry.ts` | Model routing config |
| `src/ai/advisor.ts` | Two-call advisor pattern |
| `src/intelligence/client-indexer.ts` | Background indexing engine |
| `src/webapp/api/clients.ts` | Client CRUD + index endpoints |
| `src/webapp/api/images.ts` | Image generation endpoint |
| `src/webapp/api/sync.ts` | M365 sync endpoint |

## 9. Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add client row types, Env vars, notification types |
| `src/features.ts` | Add `clientIndex` flag |
| `src/webapp/api.ts` | Register new route prefixes |
| `src/webapp/chat.ts` | Accept `clientId`, inject client memory context |
| `src/webapp/conversations.ts` | Add `client_id` column support |
| `src/ai/router.ts` | Route through model registry |
| `src/ai/image.ts` | Add multi-model support via `ImageModel` type |
| `src/index.ts` | Add client index cron, register new API handlers |
| `wrangler.toml` | Add cron, new vars |
| `src/webapp/frontend/client.js.ts` | Full UI rebuild per spec above |
| `src/webapp/frontend/styles.css.ts` | Add client panel, notification badge styles |

---

## 10. Implementation Order

Build in this sequence to avoid broken intermediate states:

1. **Schema** — `d1-phase10.sql` first, apply locally and remotely
2. **Model Registry** — `model-registry.ts` + `advisor.ts` (no deps, easy to test)
3. **Router update** — Update `callAI` to use registry (backward compatible)
4. **Client API** — CRUD endpoints (no indexing yet, just data)
5. **Client Indexer** — Background engine (depends on client API)
6. **Image API** — Extend `image.ts`, add `/api/webapp/images` route
7. **Sync API** — Simple endpoint
8. **UI rebuild** — Last, once all APIs exist
9. **Notifications** — Wire up after UI so there's something to display them

---

## 11. Key Constraints

- **Never block the HTTP response for indexing.** Always use `ctx.waitUntil(...)`.
- **Token budget for indexing:** Each source gets max 50 messages per index cycle.
  Total context per AI call: cap at 30K tokens. Use chunked processing for large sources.
- **Delegated token for indexing:** Use `created_by` user's most recent valid session.
  If token is expired and can't refresh, mark index as `error` and notify.
- **Client memories are isolated** from global `memories` table. Never mix them.
- **Re-index is idempotent** — check `updated_at` on existing memories before inserting
  duplicates. Use the same dedup logic as `src/memory/long-term.ts`.
- **Advisor pattern in Workers AI context:** Since Workers AI has no native advisor tool,
  the two-call pattern in `src/ai/advisor.ts` is the correct implementation.
  Do NOT attempt to use Anthropic SDK advisor tool syntax with CF Workers AI.
