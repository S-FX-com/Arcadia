// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Shared constants
//
// Centralized literals referenced across the worker. Keep this file free of
// runtime logic: values must be statically analyzable so callers can import
// them without pulling in heavy dependencies.
// ─────────────────────────────────────────────────────────────────────────────

export const ARCADIA_VERSION = "1.0.0";

// ─── Bot Framework (Teams inbound auth) ──────────────────────────────────────

export const BOT_FRAMEWORK = {
  OPENID_URL: "https://login.botframework.com/v1/.well-known/openidconfiguration",
  ISSUER: "https://api.botframework.com",
  SCOPE: "https://api.botframework.com/.default",
  ALGORITHM: "RS256",
} as const;

// ─── Microsoft Graph (outbound API calls) ────────────────────────────────────

export const GRAPH = {
  BASE_URL: "https://graph.microsoft.com/v1.0",
  SCOPE: "https://graph.microsoft.com/.default",
  TOKEN_CACHE_KEY: "token:graph",
  TOKEN_SAFETY_MARGIN_SECONDS: 60,
  TOKEN_URL: (tenantId: string) =>
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
} as const;

// ─── KV key builders ─────────────────────────────────────────────────────────
//
// All writes to ARCADIA_CACHE should go through these builders to avoid typos
// and to keep the key schema auditable from a single place.

export const KV_KEYS = {
  CACHED_MESSAGES: (teamId: string, channelId: string) =>
    `msg:${teamId}:${channelId}`,
  SUMMARY: (teamId: string, channelId: string, date: string) =>
    `summary:${teamId}:${channelId}:${date}`,
  BOT_MESSAGE_IDS: (teamId: string, channelId: string) =>
    `botmsgids:${teamId}:${channelId}`,
  DM_HISTORY: (userId: string) => `dm:history:${userId}`,
  GROUP_CHAT_HISTORY: (conversationId: string) =>
    `groupchat:history:${conversationId}`,
  DRAFT: (conversationId: string, activityId: string) =>
    `draft:${conversationId}:${activityId}`,
  TOKEN_BOT: "token:bot",
  TOKEN_GRAPH: "token:graph",
  // DM broad context: all messages from channels where the user participated
  CROSS_CONTEXT: (userId: string) => `user:${userId}:cross-ctx`,
  // Temporary image storage for generated images (served via /api/image/:id)
  IMG: (id: string) => `img:${id}`,
} as const;

// ─── Teams protocol ──────────────────────────────────────────────────────────

export const TEAMS = {
  MESSAGE_MAX_LENGTH: 3000,
  ACTIVITY_TYPES: {
    MESSAGE: "message",
    TYPING: "typing",
    INVOKE: "invoke",
    CONVERSATION_UPDATE: "conversationUpdate",
    MESSAGE_REACTION: "messageReaction",
  },
  CONVERSATION_TYPES: {
    PERSONAL: "personal",
    GROUP_CHAT: "groupChat",
    CHANNEL: "channel",
  },
} as const;

// ─── AI defaults ─────────────────────────────────────────────────────────────

export const AI = {
  HISTORY_MAX_TURNS: 16,
  DEFAULT_MAX_TOKENS: 4096,
} as const;

// ─── Operational limits ──────────────────────────────────────────────────────

export const LIMITS = {
  MEMORY_RECALL_MAX: 10,
  NUDGE_MAX_PER_RUN: 5,
  NUDGE_COOLDOWN_HOURS: 8,
  CUSTOMER_PROFILE_UPDATE_INTERVAL: 25,
} as const;
