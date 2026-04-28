// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Client Intelligence API (Phase 10)
//
// REST endpoints for client CRUD, source management, indexing, notifications,
// memories, and executive summaries.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ClientRow, ClientSourceRow, ClientMemoryRow, ClientNotificationRow, ClientIndexLogRow } from "../../types.js";
import type { WebappSession } from "../types.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import { startClientIndex } from "../../intelligence/client-indexer.js";
import { callAIForPurpose } from "../../ai/router.js";

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapClient(row: ClientRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    indexStatus: row.index_status,
    indexStartedAt: row.index_started_at ? new Date(row.index_started_at * 1000).toISOString() : null,
    indexCompletedAt: row.index_completed_at ? new Date(row.index_completed_at * 1000).toISOString() : null,
    memorySummary: row.memory_summary,
    memoryVersion: row.memory_version,
  };
}

function mapSource(row: ClientSourceRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceName: row.source_name,
    teamId: row.team_id,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata!); } catch { return null; } })() : null,
    addedBy: row.added_by,
    addedAt: new Date(row.added_at * 1000).toISOString(),
  };
}

function mapMemory(row: ClientMemoryRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    category: row.category,
    content: row.content,
    keywords: row.keywords ? row.keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
    importance: row.importance,
    sourceRef: row.source_ref,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
  };
}

function mapNotification(row: ClientNotificationRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read: row.read === 1,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleClientsAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // GET /api/webapp/clients
  if (path === '/api/webapp/clients' && method === 'GET') {
    const rows = await env.ARCADIA_DB.prepare("SELECT * FROM clients ORDER BY updated_at DESC")
      .all<ClientRow>();
    return jsonResponse({ clients: (rows.results ?? []).map(mapClient) });
  }

  // POST /api/webapp/clients
  if (path === '/api/webapp/clients' && method === 'POST') {
    let body: { name?: string; description?: string; color?: string };
    try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
    if (!body.name?.trim()) return errorResponse('name is required', 400);

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.ARCADIA_DB.prepare(
        `INSERT INTO clients (id, name, description, color, created_by, created_at, updated_at, index_status, memory_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`
      ).bind(id, body.name.trim(), body.description ?? null, body.color ?? '#00b4d8', session.userId, now, now).run();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        return errorResponse('A client with that name already exists', 409);
      }
      throw err;
    }

    const client = await env.ARCADIA_DB.prepare("SELECT * FROM clients WHERE id = ?")
      .bind(id).first<ClientRow>();

    // Trigger indexing (will no-op gracefully if no sources yet)
    await startClientIndex(id, env, ctx);

    return jsonResponse({ client: mapClient(client!) }, 201);
  }

  // Routes that need a client ID
  const singleMatch = path.match(/^\/api\/webapp\/clients\/([^/]+)(\/.*)?$/);
  if (!singleMatch) return null;

  const clientId = singleMatch[1]!;
  const subPath = singleMatch[2] ?? '';

  // Verify client exists
  const clientRow = await env.ARCADIA_DB.prepare("SELECT * FROM clients WHERE id = ?")
    .bind(clientId).first<ClientRow>();
  if (!clientRow && subPath === '') return errorResponse('Client not found', 404);
  if (!clientRow) return errorResponse('Client not found', 404);

  // GET /api/webapp/clients/:id
  if (subPath === '' && method === 'GET') {
    return jsonResponse({ client: mapClient(clientRow) });
  }

  // PUT /api/webapp/clients/:id
  if (subPath === '' && method === 'PUT') {
    let body: { name?: string; description?: string; color?: string };
    try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
    const now = Math.floor(Date.now() / 1000);
    await env.ARCADIA_DB.prepare(
      "UPDATE clients SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color), updated_at = ? WHERE id = ?"
    ).bind(body.name ?? null, body.description ?? null, body.color ?? null, now, clientId).run();
    const updated = await env.ARCADIA_DB.prepare("SELECT * FROM clients WHERE id = ?")
      .bind(clientId).first<ClientRow>();
    return jsonResponse({ client: mapClient(updated!) });
  }

  // DELETE /api/webapp/clients/:id
  if (subPath === '' && method === 'DELETE') {
    await env.ARCADIA_DB.prepare("DELETE FROM client_notifications WHERE client_id = ?").bind(clientId).run();
    await env.ARCADIA_DB.prepare("DELETE FROM client_memories WHERE client_id = ?").bind(clientId).run();
    await env.ARCADIA_DB.prepare("DELETE FROM client_index_log WHERE client_id = ?").bind(clientId).run();
    await env.ARCADIA_DB.prepare("DELETE FROM client_sources WHERE client_id = ?").bind(clientId).run();
    await env.ARCADIA_DB.prepare("DELETE FROM clients WHERE id = ?").bind(clientId).run();
    return jsonResponse({ ok: true });
  }

  // ─── Sources ────────────────────────────────────────────────────────────────

  // GET /api/webapp/clients/:id/sources
  if (subPath === '/sources' && method === 'GET') {
    const rows = await env.ARCADIA_DB.prepare("SELECT * FROM client_sources WHERE client_id = ? ORDER BY added_at DESC")
      .bind(clientId).all<ClientSourceRow>();
    return jsonResponse({ sources: (rows.results ?? []).map(mapSource) });
  }

  // POST /api/webapp/clients/:id/sources
  if (subPath === '/sources' && method === 'POST') {
    let body: { sourceType?: string; sourceId?: string; sourceName?: string; teamId?: string; metadata?: unknown };
    try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
    if (!body.sourceType || !body.sourceId || !body.sourceName) {
      return errorResponse('sourceType, sourceId, and sourceName are required', 400);
    }
    const sourceId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.ARCADIA_DB.prepare(
        `INSERT INTO client_sources (id, client_id, source_type, source_id, source_name, team_id, metadata, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        sourceId, clientId, body.sourceType, body.sourceId, body.sourceName,
        body.teamId ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        session.userId, now
      ).run();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        return errorResponse('Source already added to this client', 409);
      }
      throw err;
    }
    const source = await env.ARCADIA_DB.prepare("SELECT * FROM client_sources WHERE id = ?")
      .bind(sourceId).first<ClientSourceRow>();
    return jsonResponse({ source: mapSource(source!) }, 201);
  }

  // DELETE /api/webapp/clients/:id/sources/:sid
  const sourceDeleteMatch = subPath.match(/^\/sources\/([^/]+)$/);
  if (sourceDeleteMatch && method === 'DELETE') {
    const sid = sourceDeleteMatch[1]!;
    await env.ARCADIA_DB.prepare("DELETE FROM client_sources WHERE id = ? AND client_id = ?")
      .bind(sid, clientId).run();
    return jsonResponse({ ok: true });
  }

  // ─── Index ──────────────────────────────────────────────────────────────────

  // POST /api/webapp/clients/:id/index
  if (subPath === '/index' && method === 'POST') {
    await startClientIndex(clientId, env, ctx);
    return jsonResponse({ ok: true, message: 'Indexing started' });
  }

  // GET /api/webapp/clients/:id/index/status
  if (subPath === '/index/status' && method === 'GET') {
    const latestLog = await env.ARCADIA_DB.prepare(
      "SELECT * FROM client_index_log WHERE client_id = ? ORDER BY started_at DESC LIMIT 1"
    ).bind(clientId).first<ClientIndexLogRow>();

    return jsonResponse({
      status: clientRow.index_status,
      indexStartedAt: clientRow.index_started_at ? new Date(clientRow.index_started_at * 1000).toISOString() : null,
      indexCompletedAt: clientRow.index_completed_at ? new Date(clientRow.index_completed_at * 1000).toISOString() : null,
      recentLog: latestLog ? {
        id: latestLog.id,
        startedAt: new Date(latestLog.started_at * 1000).toISOString(),
        completedAt: latestLog.completed_at ? new Date(latestLog.completed_at * 1000).toISOString() : null,
        status: latestLog.status,
        messagesRead: latestLog.messages_read,
        memoriesCreated: latestLog.memories_created,
        summary: latestLog.summary,
      } : null,
    });
  }

  // ─── Notifications ───────────────────────────────────────────────────────────

  // GET /api/webapp/clients/:id/notifications
  if (subPath === '/notifications' && method === 'GET') {
    const rows = await env.ARCADIA_DB.prepare(
      "SELECT * FROM client_notifications WHERE client_id = ? AND (user_id = ? OR user_id IS NULL) ORDER BY created_at DESC LIMIT 50"
    ).bind(clientId, session.userId).all<ClientNotificationRow>();
    return jsonResponse({ notifications: (rows.results ?? []).map(mapNotification) });
  }

  // POST /api/webapp/clients/:id/notifications/read
  if (subPath === '/notifications/read' && method === 'POST') {
    await env.ARCADIA_DB.prepare(
      "UPDATE client_notifications SET read = 1 WHERE client_id = ? AND (user_id = ? OR user_id IS NULL)"
    ).bind(clientId, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // ─── Memories ────────────────────────────────────────────────────────────────

  // GET /api/webapp/clients/:id/memories
  if (subPath === '/memories' && method === 'GET') {
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const rows = await env.ARCADIA_DB.prepare(
      "SELECT * FROM client_memories WHERE client_id = ? ORDER BY importance DESC LIMIT ? OFFSET ?"
    ).bind(clientId, pageSize, offset).all<ClientMemoryRow>();
    return jsonResponse({ memories: (rows.results ?? []).map(mapMemory), page });
  }

  // ─── Executive Summary ────────────────────────────────────────────────────────

  // GET /api/webapp/clients/:id/executive-summary
  if (subPath === '/executive-summary' && method === 'GET') {
    // Return cached summary if available
    if (clientRow.memory_summary) {
      return jsonResponse({
        summary: clientRow.memory_summary,
        version: clientRow.memory_version,
        cachedAt: clientRow.updated_at ? new Date(clientRow.updated_at * 1000).toISOString() : null,
      });
    }

    // Generate fresh summary
    const memories = await env.ARCADIA_DB.prepare(
      "SELECT content, category, importance FROM client_memories WHERE client_id = ? ORDER BY importance DESC LIMIT 50"
    ).bind(clientId).all<{ content: string; category: string; importance: number }>();

    if (!memories.results?.length) {
      return jsonResponse({ summary: null, version: 0, message: 'No memories yet — run indexing first.' });
    }

    const memText = memories.results.map((m) => `[${m.category}] ${m.content}`).join('\n');
    const response = await callAIForPurpose('summarization',
      `You are building an executive briefing for client "${clientRow.name}". Be specific and direct.`,
      `Synthesize these memories into a structured executive summary:\n${memText}`,
      env,
      { max_tokens: 1024 }
    );

    const now = Math.floor(Date.now() / 1000);
    await env.ARCADIA_DB.prepare(
      "UPDATE clients SET memory_summary = ?, memory_version = memory_version + 1, updated_at = ? WHERE id = ?"
    ).bind(response.text, now, clientId).run();

    return jsonResponse({ summary: response.text, version: clientRow.memory_version + 1 });
  }

  return null;
}
