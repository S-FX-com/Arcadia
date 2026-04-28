# Phase 11 — Hermes-Inspired Self-Learning Loop

## What We're Borrowing (and What We're Not)

Hermes Agent's core value is **not** its code — it's its architecture decisions.
The repo is Python, runs on a VPS, stores skills as Markdown files on disk.
None of that ports directly. What does port is the **conceptual loop**:

```
Interaction → Extract insight → Promote to skill → Skill improves future interactions
                ↑                                                    ↓
                └────────────── Feedback scores ─────────────────────┘
```

We implement this loop natively in TypeScript/D1/KV on Cloudflare Workers.
No Python, no disk files, no Docker. Pure Arcadia architecture.

---

## The Four Hermes Concepts That Map Directly to Arcadia

### 1. Skills (Hermes) → Procedures (Arcadia Phase 11)

Hermes creates Markdown skill files from experience. We store structured
`procedure` records in D1 with versioning and usage scores.

A **procedure** is a proven approach to a recurring task type, extracted
from successful interactions and stored as reusable system prompt injection.

Examples for Arcadia's domain:
- "When asked for an executive summary on a CMTA thread, lead with ticket
  status, then blockers, then action items. Never pad with generic summaries."
- "When Shane asks about IES ticketing issues, check for name-mismatch
  validation errors first — this is the most common failure pattern."
- "Weekly report for Jersey Shore Pavers: focus on project phase, weather
  delays are a standing concern, Diego owns on-site coordination."

### 2. Memory Loop (Hermes) → Closed Learning Cycle (Arcadia Phase 11)

Hermes: `session → FTS5 search → relevant context → response → skill creation`

Arcadia Phase 11:
```
interaction → score response quality → extract procedures → 
promote high-score procedures → inject into future system prompts →
re-score → prune low performers
```

### 3. USER.md (Hermes) → User Intelligence Profile (Arcadia Phase 11)

Hermes stores a USER.md per user — a living document of preferences,
communication style, and working patterns. We already have `user_profiles`
and `ProfileInsights`. Phase 11 makes this **actively updated by the agent**,
not just by the profile refresh cron.

### 4. Self-Evolution (Hermes) → Procedure Scoring + Promotion (Arcadia Phase 11)

The companion project `hermes-agent-self-evolution` uses DSPy + GEPA to
optimize skills against benchmarks. We implement a lightweight version:
procedures earn scores from implicit feedback (was the response accepted?
did the user follow up asking for clarification? did they say "thanks"
vs "that's not what I asked?") and high-scoring procedures get promoted;
low scorers get retired.

---

## Schema — `schema/d1-phase11.sql`

```sql
-- Procedures: learned approaches to recurring task types
-- Equivalent to Hermes' skills/, but stored in D1 with scoring
CREATE TABLE IF NOT EXISTS procedures (
  id              TEXT PRIMARY KEY,         -- crypto.randomUUID()
  name            TEXT NOT NULL,            -- short identifier e.g. "cmta-exec-summary"
  description     TEXT NOT NULL,            -- when to apply this procedure
  trigger_pattern TEXT NOT NULL,            -- keyword/intent pattern that activates this
  content         TEXT NOT NULL,            -- the actual instruction injected into system prompt
  scope           TEXT NOT NULL DEFAULT 'global', -- global|client:{id}|user:{id}
  source_type     TEXT NOT NULL,            -- 'extracted'|'manual'|'evolved'
  source_session  TEXT,                     -- conversation_id that generated this
  version         INTEGER NOT NULL DEFAULT 1,
  uses            INTEGER NOT NULL DEFAULT 0,
  positive_signals INTEGER NOT NULL DEFAULT 0,  -- thumbs up, "thanks", task completion
  negative_signals INTEGER NOT NULL DEFAULT 0,  -- follow-up correction, "that's wrong"
  score           REAL NOT NULL DEFAULT 0.5,    -- 0.0-1.0 computed score
  status          TEXT NOT NULL DEFAULT 'candidate', -- candidate|active|retired
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

-- Procedure versions: full history of content changes
CREATE TABLE IF NOT EXISTS procedure_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_id    TEXT NOT NULL,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  score_at_time   REAL,
  evolved_by      TEXT,                     -- 'cron'|'manual'|'feedback'
  created_at      INTEGER NOT NULL
);

-- Interaction scores: raw signal from each conversation turn
CREATE TABLE IF NOT EXISTS interaction_scores (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,            -- assistant message that was scored
  user_id         TEXT NOT NULL,
  client_id       TEXT,
  procedures_used TEXT NOT NULL DEFAULT '[]', -- JSON array of procedure IDs injected
  signal_type     TEXT NOT NULL,            -- 'positive'|'negative'|'neutral'|'correction'
  signal_source   TEXT NOT NULL,            -- 'explicit'|'implicit'|'correction_detected'
  context         TEXT,                     -- brief note on what triggered scoring
  created_at      INTEGER NOT NULL
);

-- Evolution log: when procedures were promoted/retired/evolved
CREATE TABLE IF NOT EXISTS procedure_evolution_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_id    TEXT NOT NULL,
  action          TEXT NOT NULL,            -- 'promoted'|'retired'|'evolved'|'created'|'merged'
  from_status     TEXT,
  to_status       TEXT,
  from_score      REAL,
  to_score        REAL,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);

-- User intelligence: actively maintained profile (replaces passive ProfileInsights)
CREATE TABLE IF NOT EXISTS user_intelligence (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  -- Communication
  preferred_response_length TEXT DEFAULT 'medium', -- brief|medium|detailed
  preferred_format  TEXT DEFAULT 'markdown',        -- markdown|plain|structured
  communication_style TEXT,                         -- e.g. "direct, prefers bullets"
  -- Working patterns
  peak_hours      TEXT,                             -- e.g. "9am-12pm ET"
  timezone        TEXT DEFAULT 'America/New_York',
  -- Domain knowledge
  expertise_areas TEXT NOT NULL DEFAULT '[]',       -- JSON array
  recurring_clients TEXT NOT NULL DEFAULT '[]',     -- JSON array of client IDs
  -- Preferences learned from corrections
  correction_patterns TEXT NOT NULL DEFAULT '[]',   -- JSON: things the user has corrected
  -- Interaction stats
  total_interactions INTEGER NOT NULL DEFAULT 0,
  positive_rate   REAL NOT NULL DEFAULT 0.5,
  last_updated    INTEGER NOT NULL,
  intelligence_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_procedures_scope ON procedures(scope, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_procedures_trigger ON procedures(trigger_pattern, status);
CREATE INDEX IF NOT EXISTS idx_interaction_scores_conv ON interaction_scores(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_scores_procedure ON interaction_scores(procedures_used, signal_type);
CREATE INDEX IF NOT EXISTS idx_evolution_log_procedure ON procedure_evolution_log(procedure_id, created_at DESC);
```

---

## New Module: `src/intelligence/learning-loop.ts`

This is the heart of Phase 11. It runs at three points:
1. **Post-interaction** (after every assistant message, fire-and-forget)
2. **Cron** (every 6 hours — procedure scoring and evolution)
3. **On demand** (admin trigger via webapp)

```typescript
// Post-interaction: extract procedures from a completed exchange
export async function extractProceduresFromInteraction(
  conversationId: string,
  userId: string,
  userMessage: string,
  assistantResponse: string,
  clientId: string | null,
  env: Env,
  ctx: ExecutionContext
): Promise<void>

// Score an interaction based on implicit and explicit signals
export async function scoreInteraction(
  conversationId: string,
  messageId: string,
  userId: string,
  signalType: 'positive' | 'negative' | 'neutral' | 'correction',
  signalSource: 'explicit' | 'implicit' | 'correction_detected',
  proceduresUsed: string[],
  env: Env
): Promise<void>

// Evolve procedures: recalculate scores, promote candidates, retire losers
export async function runProcedureEvolution(env: Env): Promise<EvolutionResult>

// Update user intelligence from recent interactions
export async function updateUserIntelligence(userId: string, env: Env): Promise<void>

// Retrieve active procedures relevant to a given context
export async function recallProcedures(
  query: string,
  userId: string | null,
  clientId: string | null,
  env: Env,
  limit?: number
): Promise<Procedure[]>
```

### `extractProceduresFromInteraction` Algorithm

```
1. Check if this interaction type has been seen before (keyword match against 
   existing procedures)
2. If no existing procedure matches AND the response was substantive (>200 chars):
   - Call AI with extraction prompt (see Prompts section)
   - If AI identifies a reusable pattern → create procedure with status='candidate'
   - Link procedure to this conversation as source_session
3. If existing procedure WAS used:
   - Record it in interaction_scores for later scoring
   - Note: scoring happens in the evolution cron, not here
4. Always: check for correction signals in userMessage
   - Patterns: "that's not", "actually", "no, I meant", "wrong", "incorrect"
   - If detected → score previous message as 'negative' + 'correction_detected'
```

### `runProcedureEvolution` Algorithm (cron, every 6 hours)

```
For each procedure with status IN ('candidate', 'active'):

1. Aggregate interaction_scores for last 30 days
   - positive_signals = count(signal_type = 'positive')
   - negative_signals = count(signal_type = 'negative' OR 'correction')
   - total_uses = count(*)

2. Compute score:
   - If total_uses < 3: score = 0.5 (not enough data)
   - Else: score = (positive_signals * 1.0) / (positive_signals + negative_signals * 2)
   - Recency weight: interactions in last 7 days count 2x

3. State transitions:
   - candidate → active: score >= 0.65 AND total_uses >= 5
   - active → retired: score < 0.35 OR (total_uses >= 10 AND score < 0.45)
   - active → evolved: score 0.45-0.65 AND total_uses >= 8
     → Call AI to rewrite the procedure content based on negative signals

4. Log all transitions to procedure_evolution_log

5. Return EvolutionResult { promoted, retired, evolved, unchanged }
```

### `recallProcedures` Algorithm

Works like `recallMemories` in `src/memory/long-term.ts` but for procedures:

```
1. Extract keywords from query
2. Match against procedure.trigger_pattern (simple keyword overlap)
3. Filter by scope: always include global + user-scoped + client-scoped
4. Filter by status = 'active'
5. Sort by score DESC, last_used_at DESC
6. Return top N (default 3 — too many procedures pollute the prompt)
```

---

## Integration with the Pipeline

In `src/pipeline/arcadia-pipeline.ts` → `runArcadiaPipeline`:

**Before the AI call** (after context assembly):
```typescript
// Recall relevant procedures
const procedures = await recallProcedures(
  input.text, 
  user.id, 
  conversation.clientId ?? null, 
  env
);

// Inject into system prompt
if (procedures.length > 0) {
  const procedureBlock = procedures
    .map(p => `[Procedure: ${p.name}]\n${p.content}`)
    .join('\n\n');
  systemPrompt = `${systemPrompt}\n\n--- Learned Procedures ---\n${procedureBlock}`;
}

// Track which procedures were used
const usedProcedureIds = procedures.map(p => p.id);
```

**After the AI call** (fire-and-forget via ctx.waitUntil):
```typescript
ctx.waitUntil(
  extractProceduresFromInteraction(
    conversationId, user.id, input.text, 
    result.rawText, conversation.clientId ?? null,
    env, ctx
  )
);
```

---

## Prompts — `src/ai/prompts-phase11.ts`

### Procedure Extraction Prompt

```typescript
export function buildProcedureExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
  existingProcedures: string[]  // names of existing procedures for dedup check
): { system: string; user: string }
```

System:
```
You are a pattern recognition system for an AI assistant called Arcadia.
Your job: determine if this interaction contains a reusable procedure — a 
specific, repeatable approach to a recurring task type that would make 
Arcadia better at future similar requests.

A procedure is worth extracting ONLY when:
- The task type is likely to recur (not a one-off)
- The response contains specific domain logic, not generic advice
- The approach is non-obvious and would improve future responses

A procedure is NOT worth extracting when:
- It's a simple factual lookup
- It's a generic response with no domain specificity
- A similar procedure already exists (check existing list)

Output ONLY a JSON object. No prose.
```

User:
```
Existing procedures (check for duplicates): [list]

User asked: [userMessage]
Arcadia responded: [first 400 chars of response]

If a reusable procedure exists, output:
{
  "found": true,
  "name": "kebab-case-identifier",
  "description": "one sentence: when to apply this",
  "trigger_pattern": "comma,separated,keywords",
  "content": "the specific instruction to inject (2-4 sentences, imperative)"
}

If no procedure worth extracting:
{ "found": false }
```

### Procedure Evolution Prompt

```typescript
export function buildProcedureEvolutionPrompt(
  procedure: Procedure,
  negativeExamples: string[]  // sample user corrections/follow-ups
): { system: string; user: string }
```

System:
```
You are improving an AI assistant's learned procedures based on user feedback.
A procedure is a specific instruction injected into the assistant's system prompt.
The current version has received negative signals — improve it.
Output ONLY the improved procedure content. No prose, no explanation.
```

User:
```
Current procedure: [name]
Current content: [content]

User corrections/follow-ups that indicate it's not working:
[negativeExamples.join('\n')]

Write an improved version of the procedure content that addresses these issues.
Keep it 2-4 sentences, imperative voice, specific to the domain.
```

### User Intelligence Update Prompt

```typescript
export function buildUserIntelligencePrompt(
  userId: string,
  recentInteractions: Array<{ user: string; assistant: string }>,
  currentIntelligence: UserIntelligence | null
): { system: string; user: string }
```

---

## Explicit Feedback Mechanism (Webapp UI)

The webapp needs a lightweight feedback signal. Add to each assistant message:

```
👍  👎  [No buttons visible until hover]
```

On click → `POST /api/webapp/feedback`:
```typescript
interface FeedbackRequest {
  conversationId: string;
  messageId: string;
  signal: 'positive' | 'negative';
}
```

This calls `scoreInteraction` with `signalSource: 'explicit'`.

Also expose a "Correct Arcadia" flow: if user sends a message starting with
"Actually," / "No," / "That's wrong" / "Correction:" — auto-detect as
`signalSource: 'correction_detected'` and score the previous message negative.

---

## Webapp UI — Procedure Management

Add to Settings page:

**"Learned Procedures" panel:**
- List all active/candidate procedures with name, scope, score, uses
- Score displayed as a bar: ████░░ 68%
- Status badge: candidate (grey) / active (green) / retired (red)
- Expand each to see: trigger keywords, content, source conversation link
- Actions: Promote manually, Retire manually, Edit content, View evolution history

**"User Intelligence" panel:**
- Shows the living intelligence profile for the current user
- Displays: communication style, detected preferences, correction history
- Edit button: override AI-detected preferences manually

---

## Cron Additions

Add to `wrangler.toml` crons: `"0 */6 * * *"` (already used for client index — reuse)

In `src/index.ts` → `handleScheduled` → `"0 */6 * * *"` case:
```typescript
// Run both client index and procedure evolution in parallel
await Promise.allSettled([
  handleClientIndexCron(env),
  features.learningLoop(env) ? runProcedureEvolution(env) : Promise.resolve()
]);
```

Also add a weekly cron `"0 4 * * 1"` for user intelligence update
(runs Monday 4am UTC, before the REM synthesis):
```typescript
// Update intelligence profiles for all active users
const activeUsers = await getActiveUsers(env, 7);  // active in last 7 days
for (const user of activeUsers) {
  await updateUserIntelligence(user.userId, env).catch(e => 
    console.error(`[Phase11] Intelligence update failed for ${user.userId}:`, e)
  );
}
```

---

## Env Additions

`src/types.ts`:
```typescript
LEARNING_LOOP_ENABLED: string;    // "true" | "false"
PROCEDURE_MIN_USES: string;       // default "5" — min uses before promotion
PROCEDURE_PROMOTE_THRESHOLD: string; // default "0.65"
PROCEDURE_RETIRE_THRESHOLD: string;  // default "0.35"
```

`src/features.ts`:
```typescript
learningLoop: (env: Env) => flag(env.LEARNING_LOOP_ENABLED),
```

`wrangler.toml`:
```toml
LEARNING_LOOP_ENABLED = "true"
PROCEDURE_MIN_USES = "5"
PROCEDURE_PROMOTE_THRESHOLD = "0.65"
PROCEDURE_RETIRE_THRESHOLD = "0.35"
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `schema/d1-phase11.sql` | procedures, procedure_versions, interaction_scores, evolution_log, user_intelligence |
| `src/intelligence/learning-loop.ts` | Core extraction, scoring, evolution engine |
| `src/ai/prompts-phase11.ts` | Procedure extraction/evolution/intelligence prompts |
| `src/webapp/api/procedures.ts` | CRUD + feedback endpoints |

## Files to Modify

| File | Change |
|------|--------|
| `src/pipeline/arcadia-pipeline.ts` | Inject recalled procedures pre-call; fire extraction post-call |
| `src/webapp/api.ts` | Register `/api/webapp/procedures` and `/api/webapp/feedback` |
| `src/index.ts` | Add procedure evolution to 6-hour cron; add intelligence update to weekly cron |
| `src/features.ts` | Add `learningLoop` flag |
| `src/types.ts` | Add Procedure, UserIntelligence, InteractionScore row types; add Env vars |
| `wrangler.toml` | Add new vars |
| `src/webapp/frontend/client.js.ts` | Add 👍/👎 feedback UI; add Procedures panel to Settings |

---

## Implementation Order

1. Schema first — apply `d1-phase11.sql`
2. Types — add all new interfaces to `src/types.ts`
3. Prompts — `prompts-phase11.ts` (no deps, easy to test in isolation)
4. Learning loop module — `learning-loop.ts`
5. Pipeline integration — inject procedures + fire extraction (feature-flagged)
6. Feedback API endpoint
7. Evolution cron — wire into existing 6-hour cron
8. Webapp UI — feedback buttons + Settings panels last

---

## Important Constraints

- **Procedure content is injected verbatim into system prompts.** Keep content
  concise (2-4 sentences max). Long procedures waste context budget.
- **Max 3 procedures per call.** Beyond that, the signal is diluted and
  prompt bloat outweighs the benefit. `recallProcedures` hard-caps at 3.
- **Candidate procedures are invisible to users until promoted.** They
  accumulate signals in the background. Don't inject candidates into prompts.
- **Scope isolation is strict.** A `client:{id}` procedure never leaks into
  another client's context. A `user:{id}` procedure never leaks to other users.
- **No procedure modifies its own extraction logic.** The learning loop
  can only modify `procedure.content` — never the scoring algorithm itself.
  This prevents the optimization-loop gaming problem flagged in Hermes security research.
- **Correction detection is one-way.** Detecting "Actually, no" only scores
  the previous assistant message. It does not retroactively modify procedures.
  The cron handles that via aggregate signals.
```
