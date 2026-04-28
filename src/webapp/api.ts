// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp API Router (Phase 7)
//
// Central router for all /api/webapp/* endpoints.
// Dispatches to auth, chat, conversation, and M365 context handlers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { handleTokenExchange, handleLogout, handleGetMe, getSessionAccessToken } from "./auth.js";
import { requireAuth, jsonResponse, errorResponse } from "./middleware.js";
import { handleChat } from "./chat.js";
import { listConversations, getConversationWithMessages, deleteConversation } from "./conversations.js";
import { getUserTeams, getTeamChannels, getUserChats } from "./context/teams.js";
import { getFollowedSites } from "./context/sharepoint.js";
import { getUserTasks, getUserPlans } from "./context/planner.js";
import { handleReportsAPI } from "./api/reports.js";
import { handleClientsAPI } from "./api/clients.js";
import { handleImagesAPI } from "./api/images.js";
import { handleSyncAPI } from "./api/sync.js";

/**
 * Central router for all webapp API requests.
 * Matches /api/webapp/* paths and dispatches to the appropriate handler.
 */
export async function handleWebappAPI(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // ─── Auth routes (no session required) ───────────────────────────────────
  if (path === "/api/webapp/auth/token" && method === "POST") {
    return handleTokenExchange(request, env);
  }

  // ─── Auth routes (session required) ──────────────────────────────────────
  if (path === "/api/webapp/auth/logout" && method === "POST") {
    return handleLogout(request, env);
  }

  if (path === "/api/webapp/auth/me" && method === "GET") {
    return handleGetMe(request, env);
  }

  // ─── All remaining routes require auth ───────────────────────────────────
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const session = auth.session;

  // ─── Chat ────────────────────────────────────────────────────────────────
  if (path === "/api/webapp/chat" && method === "POST") {
    try {
      const result = await handleChat(session, request, env, ctx);
      return jsonResponse(result);
    } catch (err) {
      console.error("[Arcadia Webapp] Chat error:", err);
      return errorResponse(err instanceof Error ? err.message : "Chat failed", 500);
    }
  }

  // ─── Conversations ──────────────────────────────────────────────────────
  if (path === "/api/webapp/conversations" && method === "GET") {
    const conversations = await listConversations(session.userId, env);
    return jsonResponse({ conversations });
  }

  // Conversation by ID: /api/webapp/conversations/{id}
  const convMatch = path.match(/^\/api\/webapp\/conversations\/([^/]+)$/);
  if (convMatch && convMatch[1]) {
    const conversationId = convMatch[1];

    if (method === "GET") {
      const result = await getConversationWithMessages(conversationId, session.userId, env);
      if (!result) return errorResponse("Conversation not found", 404);
      return jsonResponse(result);
    }

    if (method === "DELETE") {
      const deleted = await deleteConversation(conversationId, session.userId, env);
      if (!deleted) return errorResponse("Conversation not found", 404);
      return jsonResponse({ ok: true });
    }
  }

  // ─── M365 Context endpoints ─────────────────────────────────────────────
  const accessToken = await getSessionAccessToken(session, env);

  if (path === "/api/webapp/context/teams" && method === "GET") {
    try {
      const teams = await getUserTeams(accessToken);
      return jsonResponse({ teams });
    } catch (err) {
      console.error("[Arcadia Webapp] Teams fetch error:", err);
      return errorResponse("Failed to fetch teams", 502);
    }
  }

  // Channels: /api/webapp/context/channels/{teamId}
  const channelMatch = path.match(/^\/api\/webapp\/context\/channels\/([^/]+)$/);
  if (channelMatch && channelMatch[1] && method === "GET") {
    try {
      const channels = await getTeamChannels(channelMatch[1], accessToken);
      return jsonResponse({ channels });
    } catch (err) {
      console.error("[Arcadia Webapp] Channels fetch error:", err);
      return errorResponse("Failed to fetch channels", 502);
    }
  }

  if (path === "/api/webapp/context/chats" && method === "GET") {
    try {
      const chats = await getUserChats(accessToken);
      return jsonResponse({ chats });
    } catch (err) {
      console.error("[Arcadia Webapp] Chats fetch error:", err);
      return errorResponse("Failed to fetch chats", 502);
    }
  }

  if (path === "/api/webapp/context/sharepoint" && method === "GET") {
    try {
      const sites = await getFollowedSites(accessToken);
      return jsonResponse({ sites });
    } catch (err) {
      console.error("[Arcadia Webapp] SharePoint fetch error:", err);
      return errorResponse("Failed to fetch SharePoint sites", 502);
    }
  }

  if (path === "/api/webapp/context/planner" && method === "GET") {
    try {
      const [tasks, plans] = await Promise.all([
        getUserTasks(accessToken),
        getUserPlans(accessToken),
      ]);
      return jsonResponse({ tasks, plans });
    } catch (err) {
      console.error("[Arcadia Webapp] Planner fetch error:", err);
      return errorResponse("Failed to fetch Planner data", 502);
    }
  }

  // ─── Phase 9: Report configs & history ────────────────────────────────────
  if (url.pathname.startsWith("/api/webapp/reports/")) {
    const reportsResponse = await handleReportsAPI(request, url, session, env);
    if (reportsResponse) return reportsResponse;
  }

  // ─── Phase 10: Client Intelligence ────────────────────────────────────────
  if (url.pathname.startsWith("/api/webapp/clients")) {
    const clientsResponse = await handleClientsAPI(request, url, session, env, ctx);
    if (clientsResponse) return clientsResponse;
  }

  // ─── Phase 10: Image Generation ───────────────────────────────────────────
  if (url.pathname.startsWith("/api/webapp/images")) {
    const imagesResponse = await handleImagesAPI(request, url, session, env);
    if (imagesResponse) return imagesResponse;
  }

  // ─── Phase 10: M365 Sync ──────────────────────────────────────────────────
  if (url.pathname === "/api/webapp/sync" && request.method === "POST") {
    return handleSyncAPI(request, url, session, env);
  }

  // ─── Phase 10: Last sync time ─────────────────────────────────────────────
  if (url.pathname === "/api/webapp/sync/status" && request.method === "GET") {
    const syncKey = `sync:${session.userId}:last`;
    const lastSync = await env.ARCADIA_CACHE.get(syncKey);
    return jsonResponse({ lastSync: lastSync ?? null });
  }

  return errorResponse("Not found", 404);
}
