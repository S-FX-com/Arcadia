// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Conversation Persistence (Phase 7)
//
// CRUD operations for webapp chat conversations stored in D1.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import type {
  WebappConversation,
  WebappConversationRow,
  WebappMessage,
  WebappMessageRow,
  ContextRef,
} from "./types.js";

// ─── Conversations ───────────────────────────────────────────────────────────

/**
 * Creates a new conversation. Returns the new conversation ID.
 */
export async function createConversation(
  userId: string,
  title: string,
  env: Env
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.ARCADIA_DB.prepare(
    `INSERT INTO webapp_conversations (id, user_id, title, created_at, updated_at, message_count)
     VALUES (?, ?, ?, ?, ?, 0)`
  )
    .bind(id, userId, title, now, now)
    .run();

  return id;
}

/**
 * Lists conversations for a user, ordered by most recently updated.
 */
export async function listConversations(
  userId: string,
  env: Env,
  limit = 50
): Promise<WebappConversation[]> {
  const rows = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?"
  )
    .bind(userId, limit)
    .all<WebappConversationRow>();

  return (rows.results ?? []).map(rowToConversation);
}

/**
 * Gets a single conversation with its messages. Returns null if not found or not owned by user.
 */
export async function getConversationWithMessages(
  conversationId: string,
  userId: string,
  env: Env,
  messageLimit = 50
): Promise<{ conversation: WebappConversation; messages: WebappMessage[] } | null> {
  const convRow = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_conversations WHERE id = ? AND user_id = ?"
  )
    .bind(conversationId, userId)
    .first<WebappConversationRow>();

  if (!convRow) return null;

  const msgRows = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
  )
    .bind(conversationId, messageLimit)
    .all<WebappMessageRow>();

  return {
    conversation: rowToConversation(convRow),
    messages: (msgRows.results ?? []).map(rowToMessage),
  };
}

/**
 * Deletes a conversation and all its messages. Only the owner can delete.
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
  env: Env
): Promise<boolean> {
  // Verify ownership
  const row = await env.ARCADIA_DB.prepare(
    "SELECT id FROM webapp_conversations WHERE id = ? AND user_id = ?"
  )
    .bind(conversationId, userId)
    .first<{ id: string }>();

  if (!row) return false;

  // Delete messages first, then conversation
  await env.ARCADIA_DB.prepare(
    "DELETE FROM webapp_messages WHERE conversation_id = ?"
  )
    .bind(conversationId)
    .run();

  await env.ARCADIA_DB.prepare(
    "DELETE FROM webapp_conversations WHERE id = ?"
  )
    .bind(conversationId)
    .run();

  return true;
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Saves a new message in a conversation. Updates the conversation's updated_at and message_count.
 */
export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  contextRefs: ContextRef[] | null,
  env: Env
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.ARCADIA_DB.prepare(
    `INSERT INTO webapp_messages (id, conversation_id, role, content, context_refs, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      conversationId,
      role,
      content,
      contextRefs ? JSON.stringify(contextRefs) : null,
      now
    )
    .run();

  // Update conversation metadata
  await env.ARCADIA_DB.prepare(
    "UPDATE webapp_conversations SET updated_at = ?, message_count = message_count + 1 WHERE id = ?"
  )
    .bind(now, conversationId)
    .run();

  return id;
}

/**
 * Loads recent messages for a conversation (for AI history context).
 */
export async function getRecentMessages(
  conversationId: string,
  env: Env,
  limit = 20
): Promise<WebappMessage[]> {
  const rows = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(conversationId, limit)
    .all<WebappMessageRow>();

  // Reverse so they're in chronological order
  return (rows.results ?? []).reverse().map(rowToMessage);
}

/**
 * Updates a conversation's title (e.g. auto-title after first exchange).
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string,
  env: Env
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    "UPDATE webapp_conversations SET title = ? WHERE id = ?"
  )
    .bind(title, conversationId)
    .run();
}

// ─── Row Mappers ─────────────────────────────────────────────────────────────

function rowToConversation(row: WebappConversationRow): WebappConversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    messageCount: row.message_count,
  };
}

function rowToMessage(row: WebappMessageRow): WebappMessage {
  let contextRefs: ContextRef[] | null = null;
  if (row.context_refs) {
    try {
      contextRefs = JSON.parse(row.context_refs);
    } catch {
      contextRefs = null;
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as "user" | "assistant",
    content: row.content,
    contextRefs,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  };
}
