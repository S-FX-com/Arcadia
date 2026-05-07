// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Client Intelligence Indexer (Phase 10)
//
// Background engine that reads M365 sources linked to a client, extracts
// memories, maintains a living executive summary, and detects blockers.
// Always runs in ctx.waitUntil() — never blocks an HTTP response.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ClientIndexResult, ClientRow, ClientSourceRow, ClientMemoryRow } from "../types.js";
import { getChannelMessages, getChatMessages } from "../webapp/context/teams.js";
import { callAIForPurpose } from "../ai/router.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ component: "client-indexer" });

const MAX_MESSAGES_PER_SOURCE = 50;
const MAX_CONTEXT_TOKENS_APPROX = 30000; // ~30K tokens, rough char estimate × 0.25
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS_APPROX * 4;

// ─── Session token lookup ─────────────────────────────────────────────────────

async function getMostRecentAccessToken(userId: string, env: Env): Promise<string | null> {
  interface SessionRow {
    access_token: string;
    token_expiry: number;
    refresh_token: string | null;
  }

  const row = await env.ARCADIA_DB.prepare(
    "SELECT access_token, token_expiry, refresh_token FROM webapp_sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1"
  )
    .bind(userId)
    .first<SessionRow>();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.token_expiry < now) {
    // Token expired; caller should mark index as error
    return null;
  }

  // Tokens are stored AES-GCM encrypted; decrypt via webapp crypto module
  try {
    const { decryptToken } = await import("../webapp/crypto.js");
    return await decryptToken(row.access_token, env.WEBAPP_SESSION_SECRET);
  } catch {
    return null;
  }
}

// ─── Memory extraction ────────────────────────────────────────────────────────

interface ExtractedMemory {
  category: string;
  content: string;
  importance: number;
}

async function extractMemoriesFromMessages(
  messages: Array<{ authorName: string; text: string; timestamp: string }>,
  clientName: string,
  sourceName: string,
  env: Env,
): Promise<ExtractedMemory[]> {
  if (messages.length === 0) return [];

  const msgText = messages
    .slice(0, MAX_MESSAGES_PER_SOURCE)
    .map((m) => `[${m.timestamp.slice(0, 10)} ${m.authorName}]: ${m.text}`)
    .join("\n")
    .slice(0, MAX_CONTEXT_CHARS);

  const system =
    "You are a memory extraction system for a client intelligence platform. " +
    "Extract facts, decisions, risks, and patterns from the provided messages. " +
    "Respond ONLY with a valid JSON array. No prose, no markdown fences.";

  const user = `Client: "${clientName}" — Source: "${sourceName}"

Messages:
${msgText}

Extract 0-8 memories worth keeping about this client. Only extract meaningful insights:
- Decisions made, commitments given, deadlines set
- Key facts about the client's business, projects, or people
- Risks, blockers, or unresolved questions
- Process knowledge or recurring patterns

Return ONLY a JSON array (return [] if nothing worth keeping):
[
  {
    "category": "episodic|semantic|procedural|observation",
    "content": "concise memory (1-2 sentences, specific)",
    "importance": 0.0-1.0
  }
]`;

  try {
    const response = await callAIForPurpose('memory-extraction', system, user, env, { max_tokens: 1024 });
    const text = response.text.trim();
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) return [];
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as ExtractedMemory[];
    return parsed.filter((m) => m.category && m.content && typeof m.importance === 'number');
  } catch (err) {
    log.error("memory_extraction_failed", { stage: "extract" }, err);
    return [];
  }
}

// ─── Dedup check ──────────────────────────────────────────────────────────────

async function memoryExists(clientId: string, content: string, env: Env): Promise<boolean> {
  // Simple similarity check: exact or near-exact content match
  const existing = await env.ARCADIA_DB.prepare(
    "SELECT id FROM client_memories WHERE client_id = ? AND content = ? LIMIT 1"
  )
    .bind(clientId, content)
    .first<{ id: string }>();
  return existing !== null;
}

// ─── Blocker detection ────────────────────────────────────────────────────────

export async function detectClientBlockers(clientId: string, env: Env): Promise<string[]> {
  const memories = await env.ARCADIA_DB.prepare(
    "SELECT content FROM client_memories WHERE client_id = ? AND importance >= 0.7 ORDER BY created_at DESC LIMIT 30"
  )
    .bind(clientId)
    .all<{ content: string }>();

  if (!memories.results?.length) return [];

  const memoriesText = memories.results.map((m, i) => `${i + 1}. ${m.content}`).join("\n");

  const system = "You are an executive intelligence analyst. Identify blockers from client memory items.";
  const user = `Review these client memory items and identify concrete blockers:
- Deadlines with no owner or no progress
- Unanswered questions blocking work
- Commitments that appear to be at risk

${memoriesText}

Return ONLY a JSON array of blocker descriptions ([] if none):
["blocker description 1", "blocker description 2"]`;

  try {
    const response = await callAIForPurpose('client-indexing', system, user, env, { max_tokens: 512 });
    const text = response.text.trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    return JSON.parse(text.slice(start, end + 1)) as string[];
  } catch {
    return [];
  }
}

// ─── Memory summary ───────────────────────────────────────────────────────────

export async function updateClientMemorySummary(clientId: string, env: Env): Promise<void> {
  const clientRow = await env.ARCADIA_DB.prepare("SELECT name FROM clients WHERE id = ?")
    .bind(clientId)
    .first<{ name: string }>();
  if (!clientRow) return;

  const memories = await env.ARCADIA_DB.prepare(
    "SELECT content, category, importance FROM client_memories WHERE client_id = ? ORDER BY importance DESC LIMIT 50"
  )
    .bind(clientId)
    .all<{ content: string; category: string; importance: number }>();

  if (!memories.results?.length) return;

  const memText = memories.results
    .map((m) => `[${m.category}] ${m.content}`)
    .join("\n");

  const system = `You are building a living executive briefing for client "${clientRow.name}". Be specific and direct.`;
  const user = `Synthesize these memories into a structured summary covering:
1. Active workstreams
2. Key decisions made
3. Open items and owners
4. Risks and blockers
5. Recommendations

Max 800 tokens. Use bullet points under each section.

Memories:
${memText}`;

  try {
    const response = await callAIForPurpose('summarization', system, user, env, { max_tokens: 1024 });
    const now = Math.floor(Date.now() / 1000);
    await env.ARCADIA_DB.prepare(
      "UPDATE clients SET memory_summary = ?, memory_version = memory_version + 1, updated_at = ? WHERE id = ?"
    )
      .bind(response.text, now, clientId)
      .run();
  } catch (err) {
    console.error("[ClientIndexer] Summary update failed:", err);
  }
}

// ─── Core index cycle ─────────────────────────────────────────────────────────

export async function runClientIndexCycle(clientId: string, env: Env): Promise<ClientIndexResult> {
  const start = Date.now();

  // Insert index log row
  const logResult = await env.ARCADIA_DB.prepare(
    "INSERT INTO client_index_log (client_id, started_at, status, messages_read, memories_created) VALUES (?, ?, 'running', 0, 0)"
  )
    .bind(clientId, Math.floor(start / 1000))
    .run();

  const logId = logResult.meta?.last_row_id as number | undefined;

  const clientRow = await env.ARCADIA_DB.prepare("SELECT * FROM clients WHERE id = ?")
    .bind(clientId)
    .first<ClientRow>();

  if (!clientRow) {
    throw new Error(`Client ${clientId} not found`);
  }

  // Get delegated token for the client creator
  const accessToken = await getMostRecentAccessToken(clientRow.created_by, env);
  if (!accessToken) {
    const now = Math.floor(Date.now() / 1000);
    await env.ARCADIA_DB.prepare(
      "UPDATE clients SET index_status = 'error', updated_at = ? WHERE id = ?"
    ).bind(now, clientId).run();
    if (logId) {
      await env.ARCADIA_DB.prepare(
        "UPDATE client_index_log SET status = 'failed', completed_at = ?, summary = 'Delegated token expired or unavailable' WHERE id = ?"
      ).bind(now, logId).run();
    }
    // Notify
    await createNotification(clientId, clientRow.created_by, 'index_complete',
      `⚠ ${clientRow.name} index failed`,
      'Could not retrieve a valid access token. Please re-authenticate.',
      env);
    return { clientId, sourcesProcessed: 0, messagesRead: 0, memoriesCreated: 0, blockersDetected: [], durationMs: Date.now() - start };
  }

  const sources = await env.ARCADIA_DB.prepare(
    "SELECT * FROM client_sources WHERE client_id = ?"
  )
    .bind(clientId)
    .all<ClientSourceRow>();

  let totalMessages = 0;
  let totalMemories = 0;

  for (const source of sources.results ?? []) {
    try {
      let messages: Array<{ authorName: string; text: string; timestamp: string }> = [];

      if (source.source_type === 'channel' && source.team_id) {
        const raw = await getChannelMessages(source.team_id, source.source_id, accessToken, MAX_MESSAGES_PER_SOURCE);
        messages = raw.map((m) => ({ authorName: m.authorName, text: m.text, timestamp: m.timestamp }));
      } else if (source.source_type === 'chat') {
        const raw = await getChatMessages(source.source_id, accessToken, MAX_MESSAGES_PER_SOURCE);
        messages = raw.map((m) => ({ authorName: m.authorName, text: m.text, timestamp: m.timestamp }));
      } else if (source.source_type === 'team') {
        // For a full team, we don't fetch all channels here — they should be added individually
        messages = [];
      }

      totalMessages += messages.length;

      const extracted = await extractMemoriesFromMessages(messages, clientRow.name, source.source_name, env);

      for (const mem of extracted) {
        const exists = await memoryExists(clientId, mem.content, env);
        if (exists) continue;

        const now = Math.floor(Date.now() / 1000);
        await env.ARCADIA_DB.prepare(
          `INSERT INTO client_memories (id, client_id, category, content, keywords, importance, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`
        )
          .bind(crypto.randomUUID(), clientId, mem.category, mem.content, mem.importance, source.id, now, now)
          .run();
        totalMemories++;
      }
    } catch (err) {
      console.error(`[ClientIndexer] Source ${source.source_id} failed:`, err);
    }
  }

  // Detect blockers
  const blockers = await detectClientBlockers(clientId, env);

  // Update summary
  if (totalMemories > 0 || (sources.results?.length ?? 0) > 0) {
    await updateClientMemorySummary(clientId, env);
  }

  // Mark client as ready
  const completedAt = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    "UPDATE clients SET index_status = 'ready', index_completed_at = ?, updated_at = ? WHERE id = ?"
  ).bind(completedAt, completedAt, clientId).run();

  // Update log
  if (logId) {
    await env.ARCADIA_DB.prepare(
      "UPDATE client_index_log SET status = 'completed', completed_at = ?, messages_read = ?, memories_created = ? WHERE id = ?"
    ).bind(completedAt, totalMessages, totalMemories, logId).run();
  }

  // Create notifications
  const sourceCount = sources.results?.length ?? 0;
  await createNotification(clientId, null, 'index_complete',
    `✓ ${clientRow.name} index complete`,
    `${totalMemories} memories created across ${sourceCount} sources.`,
    env);

  for (const blocker of blockers) {
    await createNotification(clientId, null, 'blocker_detected',
      `⚠ Blocker detected in ${clientRow.name}`,
      blocker,
      env);
  }

  return {
    clientId,
    sourcesProcessed: sourceCount,
    messagesRead: totalMessages,
    memoriesCreated: totalMemories,
    blockersDetected: blockers,
    durationMs: Date.now() - start,
  };
}

// ─── Notification helper ──────────────────────────────────────────────────────

async function createNotification(
  clientId: string,
  userId: string | null,
  type: string,
  title: string,
  body: string,
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    "INSERT INTO client_notifications (id, client_id, user_id, type, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
  )
    .bind(crypto.randomUUID(), clientId, userId, type, title, body, now)
    .run();
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export async function startClientIndex(clientId: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    "UPDATE clients SET index_status = 'indexing', index_started_at = ?, updated_at = ? WHERE id = ?"
  ).bind(now, now, clientId).run();

  ctx.waitUntil(
    runClientIndexCycle(clientId, env).catch((err) => {
      console.error(`[ClientIndexer] Index failed for ${clientId}:`, err);
      const n = Math.floor(Date.now() / 1000);
      return env.ARCADIA_DB.prepare(
        "UPDATE clients SET index_status = 'error', updated_at = ? WHERE id = ?"
      ).bind(n, clientId).run();
    })
  );
}

/**
 * Called by the 6-hour cron to re-index all clients.
 */
export async function handleClientIndexCron(env: Env): Promise<void> {
  const clients = await env.ARCADIA_DB.prepare(
    "SELECT id FROM clients WHERE index_status NOT IN ('indexing') ORDER BY index_completed_at ASC NULLS FIRST LIMIT 20"
  ).all<{ id: string }>();

  for (const client of clients.results ?? []) {
    try {
      const now = Math.floor(Date.now() / 1000);
      await env.ARCADIA_DB.prepare(
        "UPDATE clients SET index_status = 'indexing', index_started_at = ?, updated_at = ? WHERE id = ?"
      ).bind(now, now, client.id).run();
      await runClientIndexCycle(client.id, env);
    } catch (err) {
      console.error(`[ClientIndexer] Cron index failed for ${client.id}:`, err);
    }
  }
}
