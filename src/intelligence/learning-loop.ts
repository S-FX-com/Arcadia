// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 11: Self-Learning Loop
//
// Implements the Hermes-inspired closed learning cycle:
//   interaction → extract procedures → score → promote/retire/evolve
//
// Entry points:
//   extractProceduresFromInteraction — post-interaction, fire-and-forget
//   scoreInteraction                 — explicit/implicit feedback signal
//   runProcedureEvolution            — 6-hour cron: scoring + state transitions
//   updateUserIntelligence           — weekly cron: refresh user profile
//   recallProcedures                 — pre-call: inject active procedures
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Env,
  Procedure,
  ProcedureRow,
  ProcedureSignalType,
  ProcedureSignalSource,
  ProcedureStatus,
  EvolutionResult,
  UserIntelligence,
  UserIntelligenceRow,
  InteractionScoreRow,
} from "../types.js";
import { callAIForPurpose } from "../ai/router.js";
import {
  buildProcedureExtractionPrompt,
  parseProcedureExtractionResponse,
  buildProcedureEvolutionPrompt,
  buildUserIntelligencePrompt,
  parseUserIntelligenceResponse,
} from "../ai/prompts-phase11.js";

// ─── Row → Domain ─────────────────────────────────────────────────────────────

function rowToProcedure(row: ProcedureRow): Procedure {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerPattern: row.trigger_pattern,
    content: row.content,
    scope: row.scope,
    sourceType: row.source_type as Procedure["sourceType"],
    sourceSession: row.source_session,
    version: row.version,
    uses: row.uses,
    positiveSignals: row.positive_signals,
    negativeSignals: row.negative_signals,
    score: row.score,
    status: row.status as ProcedureStatus,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : null,
  };
}

function rowToUserIntelligence(row: UserIntelligenceRow): UserIntelligence {
  const parse = <T>(s: string, fallback: T): T => {
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };
  return {
    userId: row.user_id,
    displayName: row.display_name,
    preferredResponseLength: (row.preferred_response_length as UserIntelligence["preferredResponseLength"]) ?? "medium",
    preferredFormat: (row.preferred_format as UserIntelligence["preferredFormat"]) ?? "markdown",
    communicationStyle: row.communication_style,
    peakHours: row.peak_hours,
    timezone: row.timezone ?? "America/New_York",
    expertiseAreas: parse<string[]>(row.expertise_areas, []),
    recurringClients: parse<string[]>(row.recurring_clients, []),
    correctionPatterns: parse<string[]>(row.correction_patterns, []),
    totalInteractions: row.total_interactions,
    positiveRate: row.positive_rate,
    lastUpdated: new Date(row.last_updated * 1000).toISOString(),
    intelligenceVersion: row.intelligence_version,
  };
}

// ─── Correction-pattern detection ─────────────────────────────────────────────

const CORRECTION_PATTERNS = [
  /\bthat'?s not\b/i,
  /\bactually,?\b/i,
  /\bno,?\s+i meant\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bthat'?s wrong\b/i,
  /\bcorrection:?\b/i,
];

function detectCorrectionSignal(text: string): boolean {
  return CORRECTION_PATTERNS.some((re) => re.test(text));
}

// ─── recallProcedures ─────────────────────────────────────────────────────────

/**
 * Retrieve active procedures relevant to the current query.
 * Keyword-overlap match against trigger_pattern; scope-filtered;
 * capped at 3 to avoid context bloat.
 */
export async function recallProcedures(
  query: string,
  userId: string | null,
  clientId: string | null,
  env: Env,
  limit = 3,
): Promise<Procedure[]> {
  // Extract keywords from query
  const queryWords = new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

  if (queryWords.size === 0) return [];

  // Load all active procedures (candidates excluded deliberately)
  const scopes = ["global"];
  if (userId) scopes.push(`user:${userId}`);
  if (clientId) scopes.push(`client:${clientId}`);

  const placeholders = scopes.map(() => "?").join(", ");
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT * FROM procedures WHERE status = 'active' AND scope IN (${placeholders})
     ORDER BY score DESC, last_used_at DESC LIMIT 50`,
  )
    .bind(...scopes)
    .all<ProcedureRow>();

  const scored = (rows.results ?? []).map((row) => {
    const patternWords = new Set(
      row.trigger_pattern
        .toLowerCase()
        .replace(/[^a-z0-9,\s]/g, " ")
        .split(/[\s,]+/)
        .filter((w) => w.length >= 3),
    );
    let overlap = 0;
    for (const w of queryWords) {
      if (patternWords.has(w)) overlap++;
    }
    return { row, overlap };
  });

  // Sort by overlap first, then score
  scored.sort((a, b) => b.overlap - a.overlap || b.row.score - a.row.score);

  // Only return procedures with at least one keyword match
  return scored
    .filter((s) => s.overlap > 0)
    .slice(0, limit)
    .map((s) => rowToProcedure(s.row));
}

// ─── extractProceduresFromInteraction ─────────────────────────────────────────

/**
 * Post-interaction hook. Runs fire-and-forget via ctx.waitUntil.
 *
 * Algorithm:
 * 1. Check for correction signal in userMessage → score previous message negative
 * 2. If response is substantive (>200 chars) and no obvious procedure match exists:
 *    - Call AI extraction prompt
 *    - If pattern found → create candidate procedure
 */
export async function extractProceduresFromInteraction(
  conversationId: string,
  userId: string,
  userMessage: string,
  assistantResponse: string,
  clientId: string | null,
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Detect correction signal in current user message
  if (detectCorrectionSignal(userMessage)) {
    // Find the most recent assistant message ID in this conversation
    const lastMsg = await env.ARCADIA_DB.prepare(
      `SELECT id FROM webapp_messages
       WHERE conversation_id = ? AND role = 'assistant'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(conversationId)
      .first<{ id: string }>();

    if (lastMsg) {
      await scoreInteraction(
        conversationId,
        lastMsg.id,
        userId,
        "correction",
        "correction_detected",
        [],
        env,
      );
    }
  }

  // 2. Skip extraction if response isn't substantive
  if (assistantResponse.length < 200) return;

  // 3. Load existing procedure names for dedup check
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT name, trigger_pattern FROM procedures
     WHERE status IN ('candidate', 'active') AND (scope = 'global' OR scope = ?)
     LIMIT 40`,
  )
    .bind(userId ? `user:${userId}` : "global")
    .all<{ name: string; trigger_pattern: string }>();

  const existingNames = (existing.results ?? []).map((r) => r.name);

  // Quick keyword overlap check — skip AI call if we likely already have it
  const queryWords = new Set(
    userMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

  for (const row of existing.results ?? []) {
    const patternWords = new Set(
      row.trigger_pattern
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => w.length >= 3),
    );
    let overlap = 0;
    for (const w of queryWords) {
      if (patternWords.has(w)) overlap++;
    }
    // If we have strong overlap (≥3 words) with an existing procedure, skip
    if (overlap >= 3) return;
  }

  // 4. Call AI extraction
  const { system, user } = buildProcedureExtractionPrompt(
    userMessage,
    assistantResponse,
    existingNames,
  );

  let aiText: string;
  try {
    const response = await callAIForPurpose("memory-extraction", system, user, env, {
      max_tokens: 512,
    });
    aiText = response.text;
  } catch (err) {
    console.error("[Phase11] Procedure extraction AI call failed:", err);
    return;
  }

  const result = parseProcedureExtractionResponse(aiText);
  if (!result || !result.found) return;

  // 5. Create candidate procedure
  const id = crypto.randomUUID();
  const scope = clientId ? `client:${clientId}` : "global";

  try {
    await env.ARCADIA_DB.prepare(
      `INSERT INTO procedures
         (id, name, description, trigger_pattern, content, scope, source_type,
          source_session, version, uses, positive_signals, negative_signals,
          score, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'extracted', ?, 1, 0, 0, 0, 0.5, 'candidate', ?, ?)`,
    )
      .bind(
        id,
        result.name,
        result.description,
        result.trigger_pattern,
        result.content,
        scope,
        conversationId,
        now,
        now,
      )
      .run();

    // Log creation
    await env.ARCADIA_DB.prepare(
      `INSERT INTO procedure_evolution_log
         (procedure_id, action, to_status, to_score, reason, created_at)
       VALUES (?, 'created', 'candidate', 0.5, 'Extracted from interaction', ?)`,
    )
      .bind(id, now)
      .run();

    console.log(`[Phase11] New candidate procedure: "${result.name}" (scope: ${scope})`);
  } catch (err) {
    // Duplicate name — ignore
    if (!(err instanceof Error && err.message.includes("UNIQUE"))) {
      console.error("[Phase11] Failed to insert procedure:", err);
    }
  }
}

// ─── scoreInteraction ─────────────────────────────────────────────────────────

/**
 * Record a feedback signal for a specific assistant message.
 * Also directly increments the positive/negative_signals counts on affected procedures.
 */
export async function scoreInteraction(
  conversationId: string,
  messageId: string,
  userId: string,
  signalType: ProcedureSignalType,
  signalSource: ProcedureSignalSource,
  proceduresUsed: string[],
  env: Env,
  context?: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await env.ARCADIA_DB.prepare(
    `INSERT INTO interaction_scores
       (id, conversation_id, message_id, user_id, procedures_used,
        signal_type, signal_source, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      conversationId,
      messageId,
      userId,
      JSON.stringify(proceduresUsed),
      signalType,
      signalSource,
      context ?? null,
      now,
    )
    .run();

  // Immediately bump signal counts on involved procedures
  if (proceduresUsed.length > 0) {
    const isPositive = signalType === "positive";
    const isNegative = signalType === "negative" || signalType === "correction";

    for (const procId of proceduresUsed) {
      if (isPositive) {
        await env.ARCADIA_DB.prepare(
          `UPDATE procedures SET positive_signals = positive_signals + 1, updated_at = ? WHERE id = ?`,
        )
          .bind(now, procId)
          .run();
      } else if (isNegative) {
        await env.ARCADIA_DB.prepare(
          `UPDATE procedures SET negative_signals = negative_signals + 1, updated_at = ? WHERE id = ?`,
        )
          .bind(now, procId)
          .run();
      }
    }
  }
}

// ─── runProcedureEvolution ────────────────────────────────────────────────────

const THIRTY_DAYS_S = 30 * 86400;
const SEVEN_DAYS_S = 7 * 86400;

/**
 * 6-hour cron job. Recalculates scores, promotes candidates, retires losers,
 * evolves mid-performers using AI.
 */
export async function runProcedureEvolution(env: Env): Promise<EvolutionResult> {
  const result: EvolutionResult = { promoted: 0, retired: 0, evolved: 0, unchanged: 0 };
  const now = Math.floor(Date.now() / 1000);
  const minUses = parseInt(env.PROCEDURE_MIN_USES ?? "5", 10);
  const promoteThreshold = parseFloat(env.PROCEDURE_PROMOTE_THRESHOLD ?? "0.65");
  const retireThreshold = parseFloat(env.PROCEDURE_RETIRE_THRESHOLD ?? "0.35");

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT * FROM procedures WHERE status IN ('candidate', 'active') LIMIT 200`,
  ).all<ProcedureRow>();

  for (const row of rows.results ?? []) {
    try {
      const since = now - THIRTY_DAYS_S;
      const sevenAgo = now - SEVEN_DAYS_S;

      // Aggregate signals from interaction_scores for this procedure
      const sigRows = await env.ARCADIA_DB.prepare(
        `SELECT signal_type, created_at FROM interaction_scores
         WHERE procedures_used LIKE ? AND created_at >= ?`,
      )
        .bind(`%"${row.id}"%`, since)
        .all<{ signal_type: string; created_at: number }>();

      let pos = 0;
      let neg = 0;
      let total = 0;
      for (const sig of sigRows.results ?? []) {
        const weight = sig.created_at >= sevenAgo ? 2 : 1;
        total += weight;
        if (sig.signal_type === "positive") pos += weight;
        else if (sig.signal_type === "negative" || sig.signal_type === "correction") neg += weight;
      }

      let score: number;
      if (total < 3) {
        score = 0.5;
      } else {
        score = pos / (pos + neg * 2);
      }
      score = Math.max(0, Math.min(1, score));

      const currentStatus = row.status as ProcedureStatus;
      let newStatus = currentStatus;
      let action: string | null = null;

      // State transitions
      if (currentStatus === "candidate" && score >= promoteThreshold && total >= minUses) {
        newStatus = "active";
        action = "promoted";
        result.promoted++;
      } else if (
        currentStatus === "active" &&
        (score < retireThreshold || (total >= 10 && score < 0.45))
      ) {
        newStatus = "retired";
        action = "retired";
        result.retired++;
      } else if (
        currentStatus === "active" &&
        score >= 0.45 &&
        score < 0.65 &&
        total >= 8
      ) {
        // Try to evolve — AI rewrites content based on negative examples
        const evolved = await evolveProcedure(row, env);
        if (evolved) {
          action = "evolved";
          result.evolved++;
        } else {
          result.unchanged++;
        }
      } else {
        result.unchanged++;
      }

      // Update score and status
      await env.ARCADIA_DB.prepare(
        `UPDATE procedures SET score = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(score, newStatus, now, row.id)
        .run();

      // Log state transition
      if (action) {
        await env.ARCADIA_DB.prepare(
          `INSERT INTO procedure_evolution_log
             (procedure_id, action, from_status, to_status, from_score, to_score, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(row.id, action, currentStatus, newStatus, row.score, score, now)
          .run();
      }
    } catch (err) {
      console.error(`[Phase11] Evolution failed for procedure ${row.id}:`, err);
    }
  }

  console.log(
    `[Phase11] Evolution complete — promoted:${result.promoted} retired:${result.retired}` +
    ` evolved:${result.evolved} unchanged:${result.unchanged}`,
  );
  return result;
}

async function evolveProcedure(row: ProcedureRow, env: Env): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const procedure = rowToProcedure(row);

  // Gather negative signal contexts as examples
  const negRows = await env.ARCADIA_DB.prepare(
    `SELECT context FROM interaction_scores
     WHERE procedures_used LIKE ? AND signal_type IN ('negative', 'correction')
     ORDER BY created_at DESC LIMIT 5`,
  )
    .bind(`%"${row.id}"%`)
    .all<{ context: string | null }>();

  const examples = (negRows.results ?? [])
    .map((r) => r.context)
    .filter((c): c is string => Boolean(c));

  const { system, user } = buildProcedureEvolutionPrompt(procedure, examples);

  let newContent: string;
  try {
    const response = await callAIForPurpose("memory-extraction", system, user, env, {
      max_tokens: 400,
    });
    newContent = response.text.trim().slice(0, 800);
    if (!newContent || newContent === procedure.content) return false;
  } catch (err) {
    console.error(`[Phase11] Evolution AI call failed for ${row.id}:`, err);
    return false;
  }

  const newVersion = row.version + 1;

  // Archive current version
  await env.ARCADIA_DB.prepare(
    `INSERT INTO procedure_versions
       (procedure_id, version, content, score_at_time, evolved_by, created_at)
     VALUES (?, ?, ?, ?, 'cron', ?)`,
  )
    .bind(row.id, row.version, row.content, row.score, now)
    .run();

  // Write new content + bump version
  await env.ARCADIA_DB.prepare(
    `UPDATE procedures SET content = ?, version = ?, source_type = 'evolved', updated_at = ? WHERE id = ?`,
  )
    .bind(newContent, newVersion, now, row.id)
    .run();

  return true;
}

// ─── updateUserIntelligence ───────────────────────────────────────────────────

/**
 * Weekly cron: refresh the user intelligence profile from recent interactions.
 */
export async function updateUserIntelligence(userId: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - SEVEN_DAYS_S;

  // Load recent user+assistant message pairs from webapp_messages
  interface MsgRow { role: string; content: string; conversation_id: string; created_at: number }
  const msgRows = await env.ARCADIA_DB.prepare(
    `SELECT role, content, conversation_id, created_at
     FROM webapp_messages
     WHERE conversation_id IN (
       SELECT id FROM webapp_conversations WHERE user_id = ?
     ) AND created_at >= ?
     ORDER BY created_at ASC LIMIT 40`,
  )
    .bind(userId, sevenDaysAgo)
    .all<MsgRow>();

  const pairs: Array<{ user: string; assistant: string }> = [];
  let pendingUser: string | null = null;
  for (const row of msgRows.results ?? []) {
    if (row.role === "user") {
      pendingUser = row.content;
    } else if (row.role === "assistant" && pendingUser) {
      pairs.push({ user: pendingUser, assistant: row.content });
      pendingUser = null;
    }
  }

  if (pairs.length === 0) return;

  // Load existing intelligence
  const existingRow = await env.ARCADIA_DB.prepare(
    `SELECT * FROM user_intelligence WHERE user_id = ?`,
  )
    .bind(userId)
    .first<UserIntelligenceRow>();

  const existing = existingRow ? rowToUserIntelligence(existingRow) : null;

  // Get display name
  interface ProfileRow { display_name: string }
  const profileRow = await env.ARCADIA_DB.prepare(
    `SELECT display_name FROM user_profiles WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<ProfileRow>();
  const displayName = profileRow?.display_name ?? userId;

  const { system, user } = buildUserIntelligencePrompt(userId, pairs, existing);
  let aiText: string;
  try {
    const response = await callAIForPurpose("summarization", system, user, env, {
      max_tokens: 512,
    });
    aiText = response.text;
  } catch (err) {
    console.error(`[Phase11] Intelligence update AI call failed for ${userId}:`, err);
    return;
  }

  const parsed = parseUserIntelligenceResponse(aiText);
  if (!parsed) return;

  const newVersion = (existingRow?.intelligence_version ?? 0) + 1;

  await env.ARCADIA_DB.prepare(
    `INSERT INTO user_intelligence
       (user_id, display_name, preferred_response_length, preferred_format,
        communication_style, peak_hours, timezone,
        expertise_areas, recurring_clients, correction_patterns,
        total_interactions, positive_rate, last_updated, intelligence_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       preferred_response_length = excluded.preferred_response_length,
       preferred_format           = excluded.preferred_format,
       communication_style        = excluded.communication_style,
       peak_hours                 = excluded.peak_hours,
       timezone                   = excluded.timezone,
       expertise_areas            = excluded.expertise_areas,
       recurring_clients          = excluded.recurring_clients,
       correction_patterns        = excluded.correction_patterns,
       last_updated               = excluded.last_updated,
       intelligence_version       = excluded.intelligence_version`,
  )
    .bind(
      userId,
      displayName,
      parsed.preferredResponseLength,
      parsed.preferredFormat,
      parsed.communicationStyle,
      parsed.peakHours,
      parsed.timezone,
      JSON.stringify(parsed.expertiseAreas),
      JSON.stringify(parsed.recurringClients),
      JSON.stringify(parsed.correctionPatterns),
      pairs.length,
      existingRow?.positive_rate ?? 0.5,
      now,
      newVersion,
    )
    .run();

  console.log(`[Phase11] User intelligence updated for ${userId} (v${newVersion})`);
}

// ─── getActiveUsers (helper for cron) ────────────────────────────────────────

/**
 * Returns user IDs active in the last `days` days (have webapp conversations).
 */
export async function getActiveUsers(
  env: Env,
  days: number,
): Promise<Array<{ userId: string }>> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT DISTINCT user_id FROM webapp_conversations
     WHERE updated_at >= ? LIMIT 100`,
  )
    .bind(since)
    .all<{ user_id: string }>();

  return (rows.results ?? []).map((r) => ({ userId: r.user_id }));
}

// ─── Procedure CRUD helpers (used by API) ─────────────────────────────────────

export async function getProcedure(id: string, env: Env): Promise<Procedure | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT * FROM procedures WHERE id = ?`,
  )
    .bind(id)
    .first<ProcedureRow>();
  return row ? rowToProcedure(row) : null;
}

export async function listProcedures(
  env: Env,
  opts: { status?: string; scope?: string; limit?: number } = {},
): Promise<Procedure[]> {
  let sql = `SELECT * FROM procedures WHERE 1=1`;
  const params: unknown[] = [];

  if (opts.status) {
    sql += ` AND status = ?`;
    params.push(opts.status);
  }
  if (opts.scope) {
    sql += ` AND scope = ?`;
    params.push(opts.scope);
  }
  sql += ` ORDER BY score DESC, updated_at DESC LIMIT ?`;
  params.push(opts.limit ?? 100);

  const rows = await env.ARCADIA_DB.prepare(sql)
    .bind(...params)
    .all<ProcedureRow>();
  return (rows.results ?? []).map(rowToProcedure);
}

export async function updateProcedureStatus(
  id: string,
  status: "active" | "retired",
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT status, score FROM procedures WHERE id = ?`,
  )
    .bind(id)
    .first<{ status: string; score: number }>();
  if (!existing) return;

  await env.ARCADIA_DB.prepare(
    `UPDATE procedures SET status = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(status, now, id)
    .run();

  await env.ARCADIA_DB.prepare(
    `INSERT INTO procedure_evolution_log
       (procedure_id, action, from_status, to_status, from_score, to_score, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
  )
    .bind(id, status === "active" ? "promoted" : "retired", existing.status, status, existing.score, existing.score, now)
    .run();
}

export async function updateProcedureContent(
  id: string,
  content: string,
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.ARCADIA_DB.prepare(
    `SELECT version, content, score FROM procedures WHERE id = ?`,
  )
    .bind(id)
    .first<{ version: number; content: string; score: number }>();
  if (!existing) return;

  // Archive old version
  await env.ARCADIA_DB.prepare(
    `INSERT INTO procedure_versions
       (procedure_id, version, content, score_at_time, evolved_by, created_at)
     VALUES (?, ?, ?, ?, 'manual', ?)`,
  )
    .bind(id, existing.version, existing.content, existing.score, now)
    .run();

  await env.ARCADIA_DB.prepare(
    `UPDATE procedures SET content = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  )
    .bind(content, now, id)
    .run();
}

export async function markProcedureUsed(id: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE procedures SET uses = uses + 1, last_used_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now, now, id)
    .run();
}

export async function getProcedureEvolutionHistory(
  id: string,
  env: Env,
): Promise<Array<{ action: string; fromStatus: string | null; toStatus: string | null; fromScore: number | null; toScore: number | null; reason: string | null; createdAt: string }>> {
  interface LogRow { action: string; from_status: string | null; to_status: string | null; from_score: number | null; to_score: number | null; reason: string | null; created_at: number }
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT action, from_status, to_status, from_score, to_score, reason, created_at
     FROM procedure_evolution_log WHERE procedure_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(id)
    .all<LogRow>();
  return (rows.results ?? []).map((r) => ({
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    fromScore: r.from_score,
    toScore: r.to_score,
    reason: r.reason,
    createdAt: new Date(r.created_at * 1000).toISOString(),
  }));
}

export async function getUserIntelligence(
  userId: string,
  env: Env,
): Promise<UserIntelligence | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT * FROM user_intelligence WHERE user_id = ?`,
  )
    .bind(userId)
    .first<UserIntelligenceRow>();
  return row ? rowToUserIntelligence(row) : null;
}
