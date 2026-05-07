// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — M365 Tenant Scanner
//
// Fetches data from Graph API for research purposes.
// Builds on existing src/graph/ modules and adds new endpoints for:
//   - Listing all teams and their channels
//   - Listing recent chats (1:1 and group)
//   - Listing org users
//
// Each scan is bounded: max 5 Graph API calls per research cycle.
// ─────────────────────────────────────────────────────────────────────────────

import { graphGet } from "../graph/client.js";
import { getChannelMessages, getChatMessages } from "../graph/messages.js";
import { getAllChannels } from "../memory/d1.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "research-scanner" });
import { loadCachedMessages } from "../memory/kv.js";
import type {
  ChannelMessage,
  Env,
  ResearchDirectives,
  TenantSnapshot,
} from "../types.js";

// ─── Graph API response types ────────────────────────────────────────────────

interface GraphTeam {
  id: string;
  displayName: string;
  description?: string;
}

interface GraphChannel {
  id: string;
  displayName: string;
  description?: string;
}

interface GraphChat {
  id: string;
  topic: string | null;
  chatType: "oneOnOne" | "group" | "meeting";
  lastUpdatedDateTime?: string;
  members?: Array<{
    userId?: string;
    displayName?: string;
  }>;
}

interface GraphUser {
  id: string;
  displayName: string;
  mail: string | null;
  jobTitle?: string;
  department?: string;
}

interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

// ─── Team and Channel discovery ──────────────────────────────────────────────

/**
 * List all Teams in the tenant.
 * Uses the /groups endpoint filtered to teams.
 */
async function listTeams(env: Env): Promise<GraphTeam[]> {
  try {
    const resp = await graphGet<GraphListResponse<GraphTeam>>(
      `/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName,description&$top=50`,
      env
    );
    return resp.value;
  } catch (err) {
    console.error("[Arcadia] Research scanner: listTeams failed:", err);
    return [];
  }
}

/**
 * List channels for a specific team.
 */
async function listChannels(teamId: string, env: Env): Promise<GraphChannel[]> {
  try {
    const resp = await graphGet<GraphListResponse<GraphChannel>>(
      `/teams/${teamId}/channels?$select=id,displayName,description`,
      env
    );
    return resp.value;
  } catch (err) {
    console.error(`[Arcadia] Research scanner: listChannels failed for team ${teamId}:`, err);
    return [];
  }
}

// ─── Chat discovery ──────────────────────────────────────────────────────────

/**
 * List recent chats visible to the app.
 * Requires Chat.Read.All application permission.
 */
async function listRecentChats(env: Env, limit = 30): Promise<GraphChat[]> {
  try {
    const resp = await graphGet<GraphListResponse<GraphChat>>(
      `/chats?$top=${Math.min(limit, 50)}&$orderby=lastUpdatedDateTime desc&$expand=members`,
      env
    );
    return resp.value;
  } catch (err) {
    console.error("[Arcadia] Research scanner: listRecentChats failed:", err);
    return [];
  }
}

// ─── User discovery ──────────────────────────────────────────────────────────

/**
 * List org users.
 */
async function listUsers(env: Env, limit = 100): Promise<GraphUser[]> {
  try {
    const resp = await graphGet<GraphListResponse<GraphUser>>(
      `/users?$select=id,displayName,mail,jobTitle,department&$top=${Math.min(limit, 100)}&$orderby=displayName`,
      env
    );
    return resp.value;
  } catch (err) {
    console.error("[Arcadia] Research scanner: listUsers failed:", err);
    return [];
  }
}

// ─── Main scan function ──────────────────────────────────────────────────────

/**
 * Scan the M365 tenant and build a TenantSnapshot.
 *
 * Strategy:
 *   1. First try to use cached messages from registered channels (0 API calls).
 *   2. List teams/channels and chats from Graph API (2-3 API calls).
 *   3. For chats not already cached, fetch messages (bounded).
 *
 * Total Graph API calls: ≤5 per scan (within research cycle budget).
 */
export async function scanTenant(
  directives: ResearchDirectives,
  env: Env
): Promise<TenantSnapshot> {
  const snapshot: TenantSnapshot = {
    teams: [],
    chats: [],
    users: [],
    channelMessages: new Map(),
    chatMessages: new Map(),
    scannedAt: new Date().toISOString(),
  };

  // 1. Discover teams and channels (1 API call for teams, 1 per team for channels)
  const teams = await listTeams(env);
  let graphCallsUsed = 1;

  for (const team of teams.slice(0, 3)) { // Cap at 3 teams to stay within API budget
    const channels = await listChannels(team.id, env);
    graphCallsUsed++;

    snapshot.teams.push({
      id: team.id,
      displayName: team.displayName,
      channels: channels.map((c) => ({ id: c.id, displayName: c.displayName })),
    });

    // Load messages from registered/cached channels first (free — no API calls)
    for (const channel of channels) {
      const cached = await loadCachedMessages(team.id, channel.id, env).catch(swallow(log, "cache_load_failed", [], { teamId: team.id, channelId: channel.id }));
      if (cached.length > 0) {
        snapshot.channelMessages.set(channel.id, cached);
      }
    }
  }

  // Also pull from registered channels (channels the bot is already in)
  const registeredChannels = await getAllChannels(env);
  for (const reg of registeredChannels) {
    if (!snapshot.channelMessages.has(reg.channel_id)) {
      const cached = await loadCachedMessages(reg.team_id, reg.channel_id, env).catch(swallow(log, "cache_load_failed", [], { teamId: reg.team_id, channelId: reg.channel_id }));
      if (cached.length > 0) {
        snapshot.channelMessages.set(reg.channel_id, cached);
      }
    }
    // Ensure registered channels appear in snapshot.teams
    const existingTeam = snapshot.teams.find((t) => t.id === reg.team_id);
    if (!existingTeam) {
      snapshot.teams.push({
        id: reg.team_id,
        displayName: reg.channel_name, // Best we have without an API call
        channels: [{ id: reg.channel_id, displayName: reg.channel_name }],
      });
    }
  }

  // 2. Discover recent chats (1 API call)
  if (graphCallsUsed < 5) {
    const chats = await listRecentChats(env);
    graphCallsUsed++;

    const excluded = new Set(directives.excludeChats);

    for (const chat of chats) {
      if (excluded.has(chat.id)) continue;

      const memberNames = (chat.members ?? [])
        .map((m) => m.displayName ?? m.userId ?? "unknown")
        .filter(Boolean);

      snapshot.chats.push({
        id: chat.id,
        topic: chat.topic,
        chatType: chat.chatType,
        members: memberNames,
      });

      // Fetch messages for the most relevant chats (within API budget)
      if (graphCallsUsed < 5 && chat.chatType !== "meeting") {
        try {
          const msgs = await getChatMessages(chat.id, env, 20);
          if (msgs.length > 0) {
            snapshot.chatMessages.set(chat.id, msgs);
          }
          graphCallsUsed++;
        } catch (err) {
          console.warn(`[Arcadia] Research scanner: chat messages failed for ${chat.id}:`, err);
        }
      }
    }
  }

  // 3. List org users (1 API call, only if budget allows)
  if (graphCallsUsed < 5) {
    snapshot.users = (await listUsers(env)).map((u) => ({
      id: u.id,
      displayName: u.displayName,
      mail: u.mail,
    }));
  }

  console.log(
    `[Arcadia] Tenant scan complete: ${snapshot.teams.length} teams, ` +
    `${snapshot.channelMessages.size} channels with messages, ` +
    `${snapshot.chats.length} chats, ${snapshot.users.length} users. ` +
    `Graph API calls: ${graphCallsUsed}.`
  );

  return snapshot;
}

/**
 * Build a condensed text summary of a tenant snapshot for AI analysis.
 * Token-budgeted: caps output to ~3000 tokens worth of text.
 */
export function summarizeSnapshot(snapshot: TenantSnapshot): string {
  const sections: string[] = [];
  let charBudget = 12000; // ~3000 tokens

  // Teams and channels
  if (snapshot.teams.length > 0) {
    const teamLines = snapshot.teams.map((t) => {
      const chNames = t.channels.map((c) => c.displayName).join(", ");
      return `- ${t.displayName}: [${chNames}]`;
    });
    const section = `**Teams & Channels:**\n${teamLines.join("\n")}`;
    sections.push(section);
    charBudget -= section.length;
  }

  // Chats
  if (snapshot.chats.length > 0) {
    const chatLines = snapshot.chats.slice(0, 15).map((c) => {
      const topic = c.topic ?? `${c.chatType} chat`;
      return `- ${topic}: members=[${c.members.slice(0, 4).join(", ")}]`;
    });
    const section = `**Recent Chats:**\n${chatLines.join("\n")}`;
    sections.push(section);
    charBudget -= section.length;
  }

  // Channel messages (condensed)
  if (snapshot.channelMessages.size > 0 && charBudget > 2000) {
    const msgLines: string[] = [];
    for (const [channelId, messages] of snapshot.channelMessages) {
      if (charBudget <= 0) break;
      const recent = messages.slice(-10);
      for (const m of recent) {
        const line = `[${m.timestamp.slice(0, 16)}] ${m.authorName}: ${m.text.slice(0, 150)}`;
        if (charBudget - line.length < 0) break;
        msgLines.push(line);
        charBudget -= line.length;
      }
    }
    if (msgLines.length > 0) {
      sections.push(`**Recent Channel Messages:**\n${msgLines.join("\n")}`);
    }
  }

  // Chat messages (condensed)
  if (snapshot.chatMessages.size > 0 && charBudget > 1000) {
    const msgLines: string[] = [];
    for (const [chatId, messages] of snapshot.chatMessages) {
      if (charBudget <= 0) break;
      const recent = messages.slice(-5);
      for (const m of recent) {
        const line = `[chat] [${m.timestamp.slice(0, 16)}] ${m.authorName}: ${m.text.slice(0, 150)}`;
        if (charBudget - line.length < 0) break;
        msgLines.push(line);
        charBudget -= line.length;
      }
    }
    if (msgLines.length > 0) {
      sections.push(`**Recent Chat Messages:**\n${msgLines.join("\n")}`);
    }
  }

  // Users
  if (snapshot.users.length > 0 && charBudget > 500) {
    const userLines = snapshot.users.slice(0, 20).map((u) =>
      `- ${u.displayName}${u.mail ? ` (${u.mail})` : ""}`
    );
    sections.push(`**Org Users:**\n${userLines.join("\n")}`);
  }

  return sections.join("\n\n");
}
