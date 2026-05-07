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
import { getUserTeams, getTeamChannels, getUserChats, getMessageReplies, getTeamMembers } from "./context/teams.js";
import { getAccessibleSites } from "./context/sharepoint.js";
import { getUserTasks, getUserPlans } from "./context/planner.js";
import { getUserShifts, getOpenShifts, getTimesOff, getSwapRequests, getSchedulingGroups } from "./context/shifts.js";
import { getPendingUpdates } from "./context/updates.js";
import { getUserPresence } from "./context/presence.js";
import { getUpcomingEvents } from "./context/calendar.js";
import { getRecentDriveItems, getDriveRootItems } from "./context/onedrive.js";
import { getRelevantPeople } from "./context/people.js";
import { handleReportsAPI } from "./api/reports.js";
import { handleClientsAPI } from "./api/clients.js";
import { handleImagesAPI } from "./api/images.js";
import { handleSyncAPI } from "./api/sync.js";
import { handleProceduresAPI } from "./api/procedures.js";
import { handleAdminAPI } from "./api/admin.js";

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
  const isM365Path = path.startsWith("/api/webapp/context/");
  const channelMatch = path.match(/^\/api\/webapp\/context\/channels\/([^/]+)$/);

  if (isM365Path || channelMatch) {
    let accessToken: string;
    try {
      accessToken = await getSessionAccessToken(session, env);
    } catch (err) {
      console.error("[Arcadia Webapp] Token decryption failed:", err);
      return errorResponse("Failed to decrypt access token", 500);
    }

    if (path === "/api/webapp/context/teams" && method === "GET") {
      try {
        const teams = await getUserTeams(accessToken);
        return jsonResponse({ teams });
      } catch (err) {
        console.error("[Arcadia Webapp] Teams fetch error:", err);
        return errorResponse("Failed to fetch teams", 502);
      }
    }

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
        const sites = await getAccessibleSites(accessToken);
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

    if (path === "/api/webapp/context/shifts" && method === "GET") {
      try {
        const teams = await getUserTeams(accessToken);
        const teamIds = teams.map((t) => t.id);
        const shifts = await getUserShifts(accessToken, session.userId, teamIds);
        return jsonResponse({ shifts });
      } catch (err) {
        console.error("[Arcadia Webapp] Shifts fetch error:", err);
        return errorResponse("Failed to fetch Shifts", 502);
      }
    }

    if (path === "/api/webapp/context/updates" && method === "GET") {
      try {
        const updates = await getPendingUpdates(accessToken);
        return jsonResponse({ updates });
      } catch (err) {
        console.error("[Arcadia Webapp] Updates fetch error:", err);
        return errorResponse("Failed to fetch Teams Updates", 502);
      }
    }

    // Extended shift schedule data (open shifts, time off, swaps, groups)
    if (path === "/api/webapp/context/shifts/schedule" && method === "GET") {
      try {
        const teams = await getUserTeams(accessToken);
        const teamIds = teams.map((t) => t.id);
        const [openShifts, timesOff, swapRequests, schedulingGroups] = await Promise.all([
          getOpenShifts(accessToken, teamIds),
          getTimesOff(accessToken, teamIds),
          getSwapRequests(accessToken, teamIds),
          getSchedulingGroups(accessToken, teamIds),
        ]);
        return jsonResponse({ openShifts, timesOff, swapRequests, schedulingGroups });
      } catch (err) {
        console.error("[Arcadia Webapp] Schedule fetch error:", err);
        return errorResponse("Failed to fetch schedule data", 502);
      }
    }

    // Thread replies for a specific channel message
    const repliesMatch = path.match(
      /^\/api\/webapp\/context\/channels\/([^/]+)\/([^/]+)\/messages\/([^/]+)\/replies$/,
    );
    if (repliesMatch && method === "GET") {
      const [, teamId, channelId, messageId] = repliesMatch;
      if (!teamId || !channelId || !messageId) return errorResponse("invalid path", 400);
      try {
        const replies = await getMessageReplies(teamId, channelId, messageId, accessToken);
        return jsonResponse({ replies });
      } catch (err) {
        console.error("[Arcadia Webapp] Replies fetch error:", err);
        return errorResponse("Failed to fetch message replies", 502);
      }
    }

    // Team member roster
    const membersMatch = path.match(/^\/api\/webapp\/context\/teams\/([^/]+)\/members$/);
    if (membersMatch && method === "GET") {
      const [, teamId] = membersMatch;
      if (!teamId) return errorResponse("invalid path", 400);
      try {
        const members = await getTeamMembers(teamId, accessToken);
        return jsonResponse({ members });
      } catch (err) {
        console.error("[Arcadia Webapp] Team members fetch error:", err);
        return errorResponse("Failed to fetch team members", 502);
      }
    }

    if (path === "/api/webapp/context/presence" && method === "GET") {
      try {
        const presence = await getUserPresence(accessToken);
        return jsonResponse({ presence });
      } catch (err) {
        console.error("[Arcadia Webapp] Presence fetch error:", err);
        return errorResponse("Failed to fetch presence", 502);
      }
    }

    if (path === "/api/webapp/context/calendar" && method === "GET") {
      try {
        const events = await getUpcomingEvents(accessToken);
        return jsonResponse({ events });
      } catch (err) {
        console.error("[Arcadia Webapp] Calendar fetch error:", err);
        return errorResponse("Failed to fetch calendar", 502);
      }
    }

    if (path === "/api/webapp/context/onedrive" && method === "GET") {
      try {
        const items = await getRecentDriveItems(accessToken);
        return jsonResponse({ items });
      } catch (err) {
        console.error("[Arcadia Webapp] OneDrive fetch error:", err);
        return errorResponse("Failed to fetch OneDrive", 502);
      }
    }

    if (path === "/api/webapp/context/onedrive/root" && method === "GET") {
      try {
        const items = await getDriveRootItems(accessToken);
        return jsonResponse({ items });
      } catch (err) {
        console.error("[Arcadia Webapp] OneDrive root fetch error:", err);
        return errorResponse("Failed to fetch OneDrive root", 502);
      }
    }

    if (path === "/api/webapp/context/people" && method === "GET") {
      try {
        const people = await getRelevantPeople(accessToken);
        return jsonResponse({ people });
      } catch (err) {
        console.error("[Arcadia Webapp] People fetch error:", err);
        return errorResponse("Failed to fetch people", 502);
      }
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
    const syncResponse = await handleSyncAPI(request, url, session, env);
    if (syncResponse) return syncResponse;
  }

  // ─── Phase 10: Last sync time ─────────────────────────────────────────────
  if (url.pathname === "/api/webapp/sync/status" && request.method === "GET") {
    const syncKey = `sync:${session.userId}:last`;
    const lastSync = await env.ARCADIA_CACHE.get(syncKey);
    return jsonResponse({ lastSync: lastSync ?? null });
  }

  // ─── Phase 11: Procedures, Feedback, User Intelligence ───────────────────
  if (
    url.pathname.startsWith("/api/webapp/procedures") ||
    url.pathname === "/api/webapp/feedback" ||
    url.pathname.startsWith("/api/webapp/intelligence")
  ) {
    const procResponse = await handleProceduresAPI(request, url, session, env);
    if (procResponse) return procResponse;
  }

  // ─── Phase 12: Admin Controls ─────────────────────────────────────────────
  if (url.pathname.startsWith("/api/webapp/admin/")) {
    const adminResponse = await handleAdminAPI(request, url, session, env, ctx);
    if (adminResponse) return adminResponse;
  }

  return errorResponse("Not found", 404);
}
